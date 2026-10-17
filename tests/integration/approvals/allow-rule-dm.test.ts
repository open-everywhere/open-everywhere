import { createHash } from "node:crypto";
import { afterAll, expect, test } from "vitest";

import { NO_REPLY_SENTINEL } from "@open-everywhere/core/agent/channels/normalized-wake.js";

import {
  armSettlement,
  auditCursor,
  bootAgent,
  consumeSettlement,
  disposeLater,
  installSlackWebApiStub,
  registerScript,
  rowsSinceCursor,
  SLACK_TEAM_ID,
  slackDmWake,
  slackInteractivityPost,
  slackTs,
  waitFor,
  waitForAuditRows,
  waitForChildren,
  workTaskIdOfCall,
  type AuditCursor,
  type AuditRow,
  type ScriptedHandle,
} from "../harness";

const OWNER_ID = "U0EXOWNER";
const OTHER_ID = "U0OPE2496BOB";
const BOT_USER_ID = "U0OPE2496BOT";
const OWNER_DM = "D0OPE2496OWNR";
const OTHER_DM = "D0OPE2496OTHR";
const OWNER_DM_KEY = `slack/${SLACK_TEAM_ID}/${OWNER_DM}`;

const DM_RULE_ID = "dm.create-routine.create";
const DM_RULE_WORDS = "In this DM, create routines with create_routine that report here and declare no standing write";

const TRIGGER = { kind: "scheduled", cron: "0 9 * * 1-5", postPolicy: "every-run" } as const;
const CHILD_HOLD_MS = 120_000;

const cleanups: (() => void)[] = [];
afterAll(() => {
  for (const c of cleanups.splice(0).reverse()) c();
});

let tsCounter = 249_600;

const slack = installSlackWebApiStub((method, params) => {
  switch (method) {
    case "auth.test":
      return { ok: true, user_id: BOT_USER_ID, bot_id: "B0OPE2496BOT", team_id: SLACK_TEAM_ID };
    case "users.info": {
      const id = params.get("user") ?? "";
      return {
        ok: true,
        user: { id, name: `ope2496-${id}`, team_id: SLACK_TEAM_ID, is_bot: id === BOT_USER_ID, is_restricted: false, is_ultra_restricted: false, is_stranger: false, profile: { display_name: `ope2496-${id}`, real_name: `OPE 2496 ${id}` } },
      };
    }
    case "conversations.members":
      return { ok: true, members: [], response_metadata: { next_cursor: "" } };
    case "conversations.info":
      return { ok: true, channel: { id: params.get("channel"), name: "ope2496-dm", is_im: true, is_channel: false, is_private: true, num_members: 2 } };
    case "conversations.open":
      return { ok: true, channel: { id: params.get("users") === OTHER_ID ? OTHER_DM : OWNER_DM } };
    case "conversations.history":
    case "conversations.replies":
      return { ok: true, messages: [] };
    case "chat.postMessage":
      return { ok: true, channel: params.get("channel"), ts: slackTs(Date.now(), (tsCounter += 1)) };
    case "chat.update":
    case "chat.postEphemeral":
    case "reactions.add":
    case "reactions.remove":
    case "views.publish":
    case "views.open":
      return { ok: true };
    default:
      return undefined;
  }
});
cleanups.push(() => slack.uninstall());

const judgePrompts: { readonly prompt: string; readonly pass: string }[] = [];
let armed = false;
let org = "";

async function arm(): Promise<void> {
  await bootAgent({ stubbedProviderTransport: true, sharedSqlite: true });
  if (armed) return;
  armed = true;
  const settings = await import("@open-everywhere/core/agent/settings/settings.js");
  settings.overrideSettingsForTest({ taint: { mode: "on" }, approvals: { judgeMode: "enforce" } });
  expect(settings.getSettings().approvals.judgeMode, "the rule option exists only under an armed judge").toBe("enforce");
  const judge = await import("@open-everywhere/core/agent/access/approval-judge.js");
  judge.registerApprovalJudgeCompletion(async (prompt, pass) => {
    judgePrompts.push({ prompt, pass: String(pass) });
    if (pass === "scrutiny") return "YES";
    return `VERDICT: allow\nREASON: ope2496 consult ${judgePrompts.length}\nRULE: ${DM_RULE_ID}`;
  });
  cleanups.push(() => judge.resetApprovalJudgeCompletion());
  const binding = await import("@open-everywhere/core/agent/identity/binding.js");
  org = binding.deploymentOrg();
}

async function store() {
  const provider = await import("@open-everywhere/core/agent/operational/provider.js");
  return provider.getOperationalStore();
}

function detailOf(row: AuditRow | undefined): Record<string, unknown> {
  return (row?.detail ?? {}) as Record<string, unknown>;
}

interface Ask {
  readonly cursor: AuditCursor;
  readonly handle: ScriptedHandle;
  readonly seatSessionId: string;
  readonly verdictPrompts: readonly string[];
  readonly postMark: number;
}

async function ask(input: { readonly ids: string; readonly channelId: string; readonly userId: string; readonly prompt: string }): Promise<Ask> {
  const promptMark = judgePrompts.length;
  const postMark = slack.calls.length;
  const child = [{ delayMs: CHILD_HOLD_MS, calls: [{ tool: "create_routine", input: { prompt: input.prompt, trigger: TRIGGER }, id: `${input.ids}-routine` }] }, { say: "proposed" }];
  const handle = disposeLater(
    registerScript({
      parent: [{ calls: [{ tool: "work", input: { message: `set up this routine: ${input.prompt}` }, id: `${input.ids}-work` }] }, { say: NO_REPLY_SENTINEL }],
      child,
    }),
  );
  const cursor = await auditCursor();
  const ts = slackTs(Date.now(), (tsCounter += 1));
  const res = await slackDmWake({ channelId: input.channelId, userId: input.userId, text: `please ${input.prompt}`, ts, eventId: `EvOPE2496${input.ids}${ts.replace(".", "")}` });
  expect(res.status, `the Slack front refused the DM wake: ${res.body.slice(0, 200)}`).toBe(200);

  const seatFirst = await waitFor(() => handle.requests.find((r) => r.role === "parent" && r.stepIndex === 0), `the ${input.ids} DM seat's turn`);
  await waitFor(() => handle.requests.find((r) => r.role === "parent" && r.stepIndex === 1), `the ${input.ids} DM seat's receipt step`);
  const taskId = await workTaskIdOfCall(cursor, handle, `${input.ids}-work`, `the ${input.ids} DM job`);
  const settlement = disposeLater(armSettlement(handle, { parent: [{ say: NO_REPLY_SENTINEL }, { say: NO_REPLY_SENTINEL }] }));
  handle.releaseHolds();
  await waitForChildren(handle, { count: 1, lastStepIndex: child.length - 1, label: `the ${input.ids} worker's terminal step` });
  await consumeSettlement({ armed: settlement, dispatched: handle, taskId, label: `the ${input.ids} DM seat's result wake` });
  settlement.dispose();
  expect(handle.requests.filter((r) => r.fault !== undefined).map((r) => `${r.role}#${r.stepIndex}: ${String(r.fault)}`), `${input.ids}: a scripted step degraded`).toEqual([]);
  return {
    cursor,
    handle,
    seatSessionId: String(seatFirst.sessionId),
    verdictPrompts: judgePrompts.slice(promptMark).filter((p) => p.pass !== "scrutiny").map((p) => p.prompt),
    postMark,
  };
}

const APPROVAL_ACTIONS = ["approval.judge.verdict", "approval.requested", "approval.autoapproved"] as const;

async function judgedAsk(cursor: AuditCursor, label: string): Promise<{ verdict: Record<string, unknown>; requested: AuditRow[]; autoapproved: AuditRow[] }> {
  const rows = await waitForAuditRows({
    probe: async () => {
      const got = await rowsSinceCursor(cursor, APPROVAL_ACTIONS);
      const judged = got.filter((r) => r.action === "approval.judge.verdict" && detailOf(r).tool === "create_routine");
      const decided = got.some((r) => r.action === "approval.requested" || r.action === "approval.autoapproved");
      return judged.length >= 1 && decided ? got : undefined;
    },
    label: `${label}: the judge row and the chain's outcome row`,
    actions: APPROVAL_ACTIONS,
    cursor,
    kind: "routine.create",
  });
  const verdicts = rows.filter((r) => r.action === "approval.judge.verdict" && detailOf(r).tool === "create_routine");
  expect(verdicts, `${label}: exactly one judge consult`).toHaveLength(1);
  return {
    verdict: detailOf(verdicts[0]),
    requested: rows.filter((r) => r.action === "approval.requested"),
    autoapproved: rows.filter((r) => r.action === "approval.autoapproved"),
  };
}

interface SlackButton {
  readonly action_id: string;
  readonly value?: string;
  readonly confirm?: { readonly text?: { readonly text?: string } };
}

function postedApprovalButtons(postMark: number, channelId: string): SlackButton[][] {
  const out: SlackButton[][] = [];
  for (const call of slack.calls.slice(postMark)) {
    if (call.method !== "chat.postMessage" || call.params.get("channel") !== channelId) continue;
    const raw = call.params.get("blocks");
    if (raw === null) continue;
    const blocks = JSON.parse(raw) as { type?: string; elements?: SlackButton[] }[];
    const buttons = blocks.flatMap((b) => (b.type === "actions" ? (b.elements ?? []) : [])).filter((e) => e.action_id.startsWith("oe_approval:"));
    if (buttons.length > 0) out.push(buttons);
  }
  return out;
}

function cardButtons(postMark: number, channelId: string): SlackButton[] {
  return postedApprovalButtons(postMark, channelId)
    .flat()
    .filter((b) => /^oe_approval:(approve|approve_rule|approve_session|reject):/u.test(b.action_id));
}

function pendingIdOf(requested: readonly AuditRow[], label: string): string {
  expect(requested, `${label}: exactly one card`).toHaveLength(1);
  const id = detailOf(requested[0]).id;
  expect(typeof id, `${label}: the approval.requested row names its pending id`).toBe("string");
  return String(id);
}

test("🔴 'Approve, and allow things like this' in a Slack DM: the click writes the rule, the rule lifts the next ask, a non-matching ask still gets a card, and Remove restores the card", async () => {
  await arm();
  const ruleRows = async () => (await store()).listDmRules(org, OWNER_DM_KEY);
  expect(await ruleRows(), "the owner's DM starts with no rule").toEqual([]);

  const first = await ask({ ids: "r1", channelId: OWNER_DM, userId: OWNER_ID, prompt: "post the build summary every weekday morning (ope2496 r1)" });
  const j1 = await judgedAsk(first.cursor, "①");
  expect(j1.verdict.ruleCitation, "① the judge cited a rule the scope does not carry, and the fence saw it").toBe("unmatched");
  expect(j1.verdict.ruleId, "① no rule matched").toBeUndefined();
  expect(j1.autoapproved, "① nothing was lifted").toEqual([]);
  const pending1 = pendingIdOf(j1.requested, "①");
  expect(first.verdictPrompts.some((p) => p.includes(DM_RULE_WORDS)), "① the judge read no DM rule before the click").toBe(false);
  const card1 = cardButtons(first.postMark, OWNER_DM);
  const ruleButton = card1.find((b) => b.action_id === `oe_approval:approve_rule:${pending1}`);
  expect(card1.map((b) => b.action_id.split(":")[1]), "① the card Slack received carries Approve, the rule option and Reject").toEqual(["approve", "approve_rule", "reject"]);
  expect(ruleButton?.confirm?.text?.text ?? "", "① the rule option's confirmation dialog quotes the rule the person agrees to").toContain(DM_RULE_WORDS);

  const clickCursor = await auditCursor();
  const decisionTurn = disposeLater(registerScript({ parent: [{ say: NO_REPLY_SENTINEL }, { say: NO_REPLY_SENTINEL }] }, first.seatSessionId));
  const updateMark = slack.calls.length;
  const cardTs = (await (await store()).getPendingAction(org, pending1))?.messageTs;
  expect(typeof cardTs, "② the card's ts is stored, so the click can name the card Slack shows").toBe("string");
  const clicked = await slackInteractivityPost({
    type: "block_actions",
    user: { id: OWNER_ID },
    channel: { id: OWNER_DM },
    team: { id: SLACK_TEAM_ID },
    message: { ts: cardTs },
    actions: [{ action_id: ruleButton!.action_id, type: "button", value: ruleButton!.value }],
  });
  expect(clicked.status, `② the Slack front refused the click: ${clicked.body.slice(0, 200)}`).toBe(200);
  const added = await waitForAuditRows({
    probe: async () => {
      const rows = await rowsSinceCursor(clickCursor, ["approval.approved", "approval.rule.added", "approval.rule.refused"]);
      return rows.some((r) => r.action === "approval.rule.added" || r.action === "approval.rule.refused") && rows.some((r) => r.action === "approval.approved") ? rows : undefined;
    },
    label: "② the click's approval.approved and approval.rule.added rows",
    actions: ["approval.approved", "approval.rule.added", "approval.rule.refused"],
    cursor: clickCursor,
  });
  expect(added.filter((r) => r.action === "approval.rule.refused").map(detailOf), "② the click wrote no refusal").toEqual([]);
  expect(added.filter((r) => r.action === "approval.approved").map((r) => detailOf(r).id), "② the click approved the one act").toEqual([pending1]);
  const ruleAdded = added.filter((r) => r.action === "approval.rule.added").map(detailOf);
  expect(ruleAdded.map((d) => [d.id, d.ruleId, d.change]), "② the click added the DM rule, from this card").toEqual([[pending1, DM_RULE_ID, "added"]]);
  const rulesAfterClick = await ruleRows();
  expect(rulesAfterClick.map((r) => [r.ruleId, r.ownerId, r.sourceActionId]), "② the store holds the owner's one DM rule").toEqual([[DM_RULE_ID, OWNER_ID, pending1]]);
  expect(rulesAfterClick[0]?.rule ?? "", "② the stored rule is the rule the dialog quoted").toContain(DM_RULE_WORDS);
  expect((await (await store()).getPendingAction(org, pending1))?.status, "② the act is approved").toBe("approved");
  const updated = await waitFor(() => {
    const call = slack.calls.slice(updateMark).find((c) => c.method === "chat.update" && (c.params.get("blocks") ?? c.params.get("text") ?? "").includes("rule added to your DM"));
    return call;
  }, "② the card's own outcome line tells the owner the rule was added");
  expect(updated.params.get("channel"), "② the outcome line went to the owner's DM").toBe(OWNER_DM);
  expect(updated.params.get("ts"), "② the outcome line rewrote the card itself").toBe(cardTs);
  const wake = await waitForAuditRows({
    probe: async () => {
      const rows = await rowsSinceCursor(clickCursor, ["approval.decision_wake"]);
      return rows.length > 0 ? rows : undefined;
    },
    label: "② the decision wake row",
    actions: ["approval.decision_wake"],
    cursor: clickCursor,
  });
  if (detailOf(wake[0]).delivered === true) await waitFor(() => decisionTurn.requests.find((r) => r.role === "parent"), "② the DM seat's decision-wake turn");
  decisionTurn.dispose();

  const second = await ask({ ids: "r2", channelId: OWNER_DM, userId: OWNER_ID, prompt: "post the deploy summary every weekday evening (ope2496 r2)" });
  const j2 = await judgedAsk(second.cursor, "③");
  expect(second.verdictPrompts.some((p) => p.includes(`[${DM_RULE_ID}]`) && p.includes(DM_RULE_WORDS)), "③ the judge read the owner's DM rule").toBe(true);
  expect(j2.verdict.ruleId, "③ the citation matched the owner's DM rule").toBe(DM_RULE_ID);
  expect(j2.verdict.ruleCitation, "③ the citation matched").toBe("matched");
  expect(j2.requested, "🔴 ③ no card was requested").toEqual([]);
  expect(j2.autoapproved, "🔴 ③ the act was lifted").toHaveLength(1);
  expect(cardButtons(second.postMark, OWNER_DM), "🔴 ③ no approval card reached the owner's DM").toEqual([]);

  const other = await ask({ ids: "r3", channelId: OTHER_DM, userId: OTHER_ID, prompt: "post the build summary every weekday morning (ope2496 r3)" });
  const j3 = await judgedAsk(other.cursor, "④");
  expect(other.verdictPrompts.some((p) => p.includes(DM_RULE_WORDS)), "④ the owner's rule is not in another person's judge prompt").toBe(false);
  expect(j3.verdict.ruleCitation, "④ the same citation is unmatched outside the owner's DM").toBe("unmatched");
  expect(j3.autoapproved, "🔴 ④ nothing was lifted").toEqual([]);
  pendingIdOf(j3.requested, "④");
  expect(cardButtons(other.postMark, OTHER_DM).length, "🔴 ④ a card reached the other person's DM").toBeGreaterThan(0);

  const homeCursor = await auditCursor();
  const publishMark = slack.calls.length;
  const refresh = await slackInteractivityPost({
    type: "block_actions",
    user: { id: OWNER_ID, team_id: SLACK_TEAM_ID },
    team: { id: SLACK_TEAM_ID },
    trigger_id: "2496.refresh",
    container: { type: "view", view_id: "V0OPE2496HOME" },
    view: { id: "V0OPE2496HOME", type: "home" },
    actions: [{ type: "button", action_id: "oe_home:memory.refresh", block_id: "ope2496", action_ts: `${Date.now() / 1000}` }],
  });
  expect(refresh.status, `⑤ the Slack front refused the Refresh click: ${refresh.body.slice(0, 200)}`).toBe(200);
  const page = await waitFor(() => {
    const call = slack.calls.slice(publishMark).find((c) => c.method === "views.publish" && c.params.get("user_id") === OWNER_ID);
    return call === undefined ? undefined : (JSON.parse(call.params.get("view") ?? "{}") as { blocks?: { text?: { text?: string }; accessory?: { action_id?: string; options?: { value?: string }[] } }[] });
  }, "⑤ the owner's Home page was published");
  const ruleItem = (page.blocks ?? []).find((b) => (b.text?.text ?? "").includes(DM_RULE_WORDS));
  expect(ruleItem, "⑤ the Home page lists the owner's rule").toBeDefined();
  const removeValue = ruleItem?.accessory?.options?.map((o) => o.value ?? "").find((v) => v.startsWith("rules.remove|"));
  expect(removeValue, "⑤ the rule's overflow offers Remove").toBeDefined();
  expect(removeValue, "⑤ the Remove choice names the rule by its digest, never by its id").toBe(`rules.remove|${createHash("sha256").update(DM_RULE_ID).digest("hex")}`);

  const modalMark = slack.calls.length;
  const choose = await slackInteractivityPost({
    type: "block_actions",
    user: { id: OWNER_ID, team_id: SLACK_TEAM_ID },
    team: { id: SLACK_TEAM_ID },
    trigger_id: "2496.remove",
    container: { type: "view", view_id: "V0OPE2496HOME" },
    view: { id: "V0OPE2496HOME", type: "home" },
    actions: [{ type: "overflow", action_id: ruleItem!.accessory!.action_id, block_id: "ope2496", selected_option: { value: removeValue }, action_ts: `${Date.now() / 1000}` }],
  });
  expect(choose.status, `⑤ the Slack front refused the Remove choice: ${choose.body.slice(0, 200)}`).toBe(200);
  const modal = await waitFor(() => {
    const call = slack.calls.slice(modalMark).find((c) => c.method === "views.open");
    return call === undefined ? undefined : (JSON.parse(call.params.get("view") ?? "{}") as { callback_id?: string; private_metadata?: string });
  }, "🔴 ⑤ the Remove choice opened the confirmation modal");
  expect(modal.private_metadata, "⑤ the modal carries the Remove choice").toBe(removeValue);
  expect(await ruleRows(), "⑤ opening the modal removed nothing").toHaveLength(1);

  const submitted = await slackInteractivityPost({
    type: "view_submission",
    user: { id: OWNER_ID, team_id: SLACK_TEAM_ID },
    team: { id: SLACK_TEAM_ID },
    view: { id: "V0OPE2496MODAL", type: "modal", callback_id: modal.callback_id, private_metadata: modal.private_metadata, state: { values: {} } },
  });
  expect(submitted.status, `⑤ the Slack front refused the modal submission: ${submitted.body.slice(0, 200)}`).toBe(200);
  const removed = await waitForAuditRows({
    probe: async () => {
      const rows = await rowsSinceCursor(homeCursor, ["approval.rule.removed"]);
      return rows.length > 0 ? rows : undefined;
    },
    label: "⑤ the approval.rule.removed row",
    actions: ["approval.rule.removed"],
    cursor: homeCursor,
  });
  expect(removed.map((r) => [detailOf(r).ruleId, r.principalId]), "⑤ one Remove, naming the rule and the owner").toEqual([[DM_RULE_ID, OWNER_ID]]);
  expect(await ruleRows(), "🔴 ⑤ the store holds no rule after Remove").toEqual([]);

  const fourth = await ask({ ids: "r4", channelId: OWNER_DM, userId: OWNER_ID, prompt: "post the incident summary every weekday noon (ope2496 r4)" });
  const j4 = await judgedAsk(fourth.cursor, "⑥");
  expect(fourth.verdictPrompts.some((p) => p.includes(DM_RULE_WORDS)), "⑥ the judge reads no rule after Remove").toBe(false);
  expect(j4.verdict.ruleCitation, "⑥ the citation is unmatched after Remove").toBe("unmatched");
  expect(j4.autoapproved, "🔴 ⑥ nothing was lifted after Remove").toEqual([]);
  const pending4 = pendingIdOf(j4.requested, "⑥");
  expect(cardButtons(fourth.postMark, OWNER_DM).map((b) => b.action_id), "🔴 ⑥ the card is back in the owner's DM, rule option included").toEqual([
    `oe_approval:approve:${pending4}`,
    `oe_approval:approve_rule:${pending4}`,
    `oe_approval:reject:${pending4}`,
  ]);
});
