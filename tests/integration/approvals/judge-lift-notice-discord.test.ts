import { __setTestValveForTest } from "@open-everywhere/core/agent/testing/test-valves.js";
import { generateKeyPairSync, randomUUID, sign, type KeyObject } from "node:crypto";
import { afterAll, expect, test } from "vitest";

import { NO_REPLY_SENTINEL } from "@open-everywhere/core/agent/channels/normalized-wake.js";
import {
  armSettlement,
  auditCursor,
  awaitWorkResult,
  bootAgent,
  DISCORD_LISTED_CHANNEL_ID,
  discordMentionWake,
  disposeLater,
  registerScript,
  rowsSinceCursor,
  waitFor,
  waitForAuditRows,
  waitForChildren,
  workTaskIdOfCall,
  type AuditCursor,
  type ScriptedHandle,
} from "../harness";
import { installDiscordWebApiStub, type DiscordCreateMessageCall } from "../discord-web-api";

const STARTER_ROUTINE_RULE = "routine-reports-here";

const TRUSTED = generateKeyPairSync("ed25519");
process.env.DISCORD_PUBLIC_KEY = Buffer.from((TRUSTED.publicKey.export({ format: "jwk" }) as { x: string }).x, "base64url").toString("hex");

const DISCORD_INTERACTIONS_ROUTE = "/eve/v1/discord";

const CLICKER_ID = "9000000000000000078";

const TRIGGER = { kind: "scheduled", cron: "0 9 * * 1-5", postPolicy: "every-run" } as const;

const cleanups: (() => void)[] = [];
afterAll(() => {
  for (const c of cleanups.splice(0)) c();
});

const discord = installDiscordWebApiStub({ captureMessages: true });
cleanups.push(() => discord.uninstall());

const reasons: string[] = [];
const VERDICT_WORD = "allow";

let armed = false;
let base = "";

async function armSeams(): Promise<void> {
  ({ base } = await bootAgent());
  if (armed) return;
  armed = true;
  const judge = await import("@open-everywhere/core/agent/access/approval-judge.js");
  judge.registerApprovalJudgeCompletion(async (_prompt, pass) => {
    if (pass === "scrutiny") return "YES";
    const reason = `consult ${reasons.length + 1}`;
    reasons.push(reason);
    return `VERDICT: ${VERDICT_WORD}\nREASON: ${reason}\nRULE: ${STARTER_ROUTINE_RULE}`;
  });
  cleanups.push(() => judge.resetApprovalJudgeCompletion());
}

async function armJudgeMode(mode: "enforce" | "off"): Promise<void> {
  const settings = await import("@open-everywhere/core/agent/settings/settings.js");
  settings.overrideSettingsForTest({ taint: { mode: "on" }, approvals: { judgeMode: mode } });
  expect(settings.getSettings().approvals.judgeMode).toBe(mode);
}

async function postClick(customId: string): Promise<{ status: number; type: number; content: string; components: unknown }> {
  const body = JSON.stringify({
    type: 3,
    id: randomUUID(),
    application_id: "9000000000000000001",
    channel_id: DISCORD_LISTED_CHANNEL_ID,
    data: { custom_id: customId, component_type: 2 },
    user: { id: CLICKER_ID },
    token: `it-${randomUUID()}`,
    version: 1,
  });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = sign(null, Buffer.from(timestamp + body), TRUSTED.privateKey).toString("hex");
  const res = await fetch(`${base}${DISCORD_INTERACTIONS_ROUTE}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-signature-ed25519": signature, "x-signature-timestamp": timestamp },
    body,
  });
  const raw = await res.text();
  const parsed = JSON.parse(raw) as { type?: unknown; data?: { content?: unknown; components?: unknown } };
  return {
    status: res.status,
    type: typeof parsed.type === "number" ? parsed.type : -1,
    content: typeof parsed.data?.content === "string" ? parsed.data.content : "",
    components: parsed.data?.components,
  };
}

async function proposeRoutine(ids: string, prompt: string): Promise<AuditCursor> {
  const handle: ScriptedHandle = disposeLater(
    registerScript({
      parent: [
        { calls: [{ tool: "work", input: { message: "set up the routine I asked for" }, id: `${ids}-delegate` }] },
        { say: NO_REPLY_SENTINEL },
      ],
      child: [
        { delayMs: 120_000, calls: [{ tool: "create_routine", input: { prompt, trigger: TRIGGER }, id: `${ids}-routine` }] },
        { say: "proposed" },
      ],
    }),
  );

  const wakeCursor = await auditCursor();
  await discordMentionWake({ channelId: DISCORD_LISTED_CHANNEL_ID, text: "<@9000000000000000001> please set up the routine" });
  const receiptStep = await waitFor(
    () => handle.requests.find((r) => r.role === "parent" && r.stepIndex === 1),
    `the ${ids} receipt step to be served`,
  );
  const settlement = disposeLater(armSettlement(handle, { parent: [{ say: NO_REPLY_SENTINEL }] }));
  const taskId = await workTaskIdOfCall(wakeCursor, handle, `${ids}-delegate`, `${ids} forward receipt`);
  handle.releaseHolds();
  await waitForChildren(handle, { count: 1, lastStepIndex: 1, label: `the ${ids} worker's own terminal step` });
  expect(handle.holdsCutShort(), "the worker's hold ended on the release, not on its 120 s backstop").toBe(1);
  const resultStep = await awaitWorkResult({ handle: settlement, taskId, label: `the ${ids} seat step that read the worker's result` });
  expect(resultStep.stepIndex).toBe(0);
  expect(typeof receiptStep.turnId, "the recorder stamps eve's turn id").toBe("string");
  expect(resultStep.turnId, "the result arrives in a seat turn of its own, never the proposal turn (OPE-2338)").not.toBe(receiptStep.turnId);
  expect(handle.requests.filter((r) => r.fault !== undefined)).toEqual([]);
  expect(settlement.requests.filter((r) => r.fault !== undefined)).toEqual([]);
  expect(settlement.resolves.filter((r) => r.fault !== undefined)).toEqual([]);
  settlement.dispose();
  return wakeCursor;
}

const APPROVAL_ACTIONS = ["approval.autoapproved", "approval.requested", "approval.judge.contradicted"] as const;

const NOTICE_MARK = "Ran without asking";
const CARD_MARK = "Asked by ";

function noticesThisTurn(): DiscordCreateMessageCall[] {
  return discord.messages.filter((m) => m.content.includes(NOTICE_MARK));
}

async function noticeThisTurn(label: string): Promise<DiscordCreateMessageCall> {
  return waitFor(() => noticesThisTurn()[0], label);
}

function egressSpoof(on: boolean): void {
  if (on) __setTestValveForTest("egress-spoof", true);
  else __setTestValveForTest("egress-spoof", false);
}

function buttonsOf(message: DiscordCreateMessageCall): { label?: string; custom_id?: string }[] {
  return message.components.flatMap((rowComponent) => {
    const inner = (rowComponent as { components?: unknown }).components;
    return Array.isArray(inner) ? (inner as { label?: string; custom_id?: string }[]) : [];
  });
}

let noticeButtonCustomId = "";
let wedgeRowId = "";
let deploymentOrg = "";

test("① an armed judge lift POSTS the notice into the Discord room, carrying the contradict button", async () => {
  await armSeams();
  await armJudgeMode("enforce");
  egressSpoof(false);
  (discord.messages as DiscordCreateMessageCall[]).length = 0;

  const wakeCursor = await proposeRoutine("lift", "post the standup digest every weekday morning");

  const rows = await waitForAuditRows({
    probe: async () => {
      const got = await rowsSinceCursor(wakeCursor, APPROVAL_ACTIONS);
      return got.some((r) => r.action === "approval.autoapproved") ? got : undefined;
    },
    label: "this turn's approval.autoapproved row to land",
    actions: APPROVAL_ACTIONS,
    cursor: wakeCursor,
  });
  const lifted = rows.filter((r) => r.action === "approval.autoapproved");
  expect(lifted).toHaveLength(1);
  expect(lifted[0]!.detail?.resolvedBy).toBe("judge");
  expect(rows.filter((r) => r.action === "approval.requested")).toEqual([]);
  expect(reasons.length).toBeGreaterThan(0);
  wedgeRowId = String(lifted[0]!.detail?.id);

  const message = await noticeThisTurn("the judge-lift notice to reach the Discord room");
  expect(noticesThisTurn()).toHaveLength(1);
  expect(discord.messages.filter((m) => m.content.includes(CARD_MARK))).toEqual([]);
  expect(message.channelId).toBe(DISCORD_LISTED_CHANNEL_ID);
  expect(message.content).toContain("Ran without asking: started a routine in ");
  expect(message.content).not.toContain("routine.create");
  expect(message.content).toContain("Auto-approved and already run");
  expect(message.content).not.toContain(CARD_MARK);
  expect(message.content).not.toContain("expires");

  const buttons = buttonsOf(message);
  expect(buttons).toHaveLength(1);
  expect(buttons[0]!.label).toBe("This should not have run");
  noticeButtonCustomId = String(buttons[0]!.custom_id);
  expect(noticeButtonCustomId.startsWith(`oe-approval:${wedgeRowId}:contradict:`)).toBe(true);
  expect(noticeButtonCustomId).not.toContain(":approve:");
  expect(noticeButtonCustomId).not.toContain(":reject:");
  deploymentOrg = noticeButtonCustomId.slice(`oe-approval:${wedgeRowId}:contradict:`.length);
  expect(deploymentOrg).not.toBe("");
});

test("② a signed click on THAT button records the contradiction, and a second click does not", async () => {
  expect(noticeButtonCustomId).not.toBe("");
  const clickCursor = await auditCursor();

  const first = await postClick(noticeButtonCustomId);
  expect(first.status).toBe(200);
  expect(first.type).toBe(4);
  expect(first.content).toContain("recorded");
  expect(first.content).toContain("does NOT undo the action");
  expect(first.components).toBeUndefined();

  const recorded = await waitForAuditRows({
    probe: async () => {
      const got = await rowsSinceCursor(clickCursor, ["approval.judge.contradicted"]);
      return got.length > 0 ? got : undefined;
    },
    label: "the approval.judge.contradicted row to land",
    actions: ["approval.judge.contradicted"],
    cursor: clickCursor,
  });
  expect(recorded).toHaveLength(1);
  expect(recorded[0]!.detail?.id).toBe(wedgeRowId);
  expect(recorded[0]!.detail?.kind).toBe("routine.create");
  expect(recorded[0]!.detail?.route).toBe("click");
  expect(recorded[0]!.detail?.humanAction).toBe("overrule");
  expect(recorded[0]!.detail?.judgeVerdict).toBe("allow");
  expect(recorded[0]!.principalId).toBe(CLICKER_ID);

  const second = await postClick(noticeButtonCustomId);
  expect(second.type).toBe(4);
  expect(second.content).toContain("already flagged");
  expect(await rowsSinceCursor(clickCursor, ["approval.judge.contradicted"])).toHaveLength(1);
});

test("③ 🔴 with the judge OFF no notice reaches the room, and a contradict click records nothing", async () => {
  await armJudgeMode("off");
  egressSpoof(false);
  (discord.messages as DiscordCreateMessageCall[]).length = 0;
  const consultsBefore = reasons.length;

  const wakeCursor = await proposeRoutine("carded", "post the release notes every weekday afternoon");

  const rows = await waitForAuditRows({
    probe: async () => {
      const got = await rowsSinceCursor(wakeCursor, APPROVAL_ACTIONS);
      return got.some((r) => r.action === "approval.requested") ? got : undefined;
    },
    label: "this turn's approval.requested row to land",
    actions: APPROVAL_ACTIONS,
    cursor: wakeCursor,
  });
  expect(rows.filter((r) => r.action === "approval.autoapproved")).toEqual([]);
  expect(reasons.length).toBe(consultsBefore);

  expect(noticesThisTurn()).toEqual([]);
  expect(discord.messages.filter((m) => m.content.includes(CARD_MARK))).toHaveLength(1);

  const pendingId = String(rows.find((r) => r.action === "approval.requested")!.detail?.id);
  const clickCursor = await auditCursor();
  const refused = await postClick(`oe-approval:${pendingId}:contradict:${deploymentOrg}`);
  expect(refused.type).toBe(4);
  expect(refused.content).toContain("not auto-approved by the approval judge");
  expect(await rowsSinceCursor(clickCursor, ["approval.judge.contradicted"])).toEqual([]);
});

test("④ 🔴 with the egress-spoof valve armed and a real bot token present, the notice reaches NO vendor transport", async () => {
  await armSeams();
  await armJudgeMode("enforce");
  egressSpoof(true);
  (discord.messages as DiscordCreateMessageCall[]).length = 0;

  const wakeCursor = await proposeRoutine("spoofed", "post the oncall handover every weekday evening");

  const rows = await waitForAuditRows({
    probe: async () => {
      const got = await rowsSinceCursor(wakeCursor, APPROVAL_ACTIONS);
      return got.some((r) => r.action === "approval.autoapproved") ? got : undefined;
    },
    label: "the spoofed turn's approval.autoapproved row to land",
    actions: APPROVAL_ACTIONS,
    cursor: wakeCursor,
  });
  expect(rows.filter((r) => r.action === "approval.autoapproved")).toHaveLength(1);
  expect(rows.filter((r) => r.action === "approval.autoapproved")[0]!.detail?.resolvedBy).toBe("judge");

  expect(noticesThisTurn()).toEqual([]);
  expect(discord.messages).toEqual([]);

  egressSpoof(false);
});
