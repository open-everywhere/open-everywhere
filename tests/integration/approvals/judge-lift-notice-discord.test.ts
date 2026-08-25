import { generateKeyPairSync, randomUUID, sign, type KeyObject } from "node:crypto";
import { afterAll, expect, test } from "vitest";

import {
  awaitTaskSettlement,
  bootAgent,
  discordMentionWake,
  disposeLater,
  DISCORD_LISTED_CHANNEL_ID,
  readAuditRows,
  registerScript,
  SETTLEMENT_DRAIN_SCRIPT,
  taskIdOfDelegation,
  waitFor,
  waitForChildren,
  type AuditRow,
  type ScriptedHandle,
} from "../harness";
import { installDiscordWebApiStub, type DiscordCreateMessageCall } from "../discord-web-api";

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
    return `VERDICT: ${VERDICT_WORD}\nREASON: ${reason}`;
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

async function proposeRoutine(ids: string, prompt: string): Promise<number> {
  const handle: ScriptedHandle = disposeLater(
    registerScript({
      parent: [
        { calls: [{ tool: "agent", input: { message: "set up the routine I asked for" }, id: `${ids}-delegate` }] },
        { say: "the worker reported back" },
      ],
      child: [{ calls: [{ tool: "create_routine", input: { prompt, trigger: TRIGGER }, id: `${ids}-routine` }] }, { say: "proposed" }],
    }),
  );

  const wakeAt = Date.now();
  await discordMentionWake({ channelId: DISCORD_LISTED_CHANNEL_ID, text: "<@9000000000000000001> please set up the routine" });
  await waitFor(() => handle.requests.find((r) => r.role === "parent" && r.stepIndex === 1), "the parent's terminal step to be served");
  await waitForChildren(handle, { count: 1, lastStepIndex: 1, label: `the ${ids} worker's own terminal step` });
  expect(handle.requests.filter((r) => r.fault !== undefined)).toEqual([]);

  const drained = await awaitTaskSettlement({
    dispatched: handle,
    taskId: taskIdOfDelegation(handle, `the ${ids} delegation`),
    script: SETTLEMENT_DRAIN_SCRIPT,
    label: `the ${ids} worker's settlement wake`,
  });
  expect(drained.handle.requests.filter((r) => r.fault !== undefined)).toEqual([]);
  drained.handle.dispose();
  return wakeAt;
}

const APPROVAL_ACTIONS = ["approval.autoapproved", "approval.requested", "approval.judge.contradicted"] as const;

async function rowsSince(wakeAt: number, actions: readonly string[]): Promise<AuditRow[]> {
  const got = await readAuditRows({ actions, sinceIso: new Date(wakeAt - 1_000).toISOString(), limit: 200 });
  return got.filter((r) => new Date(r.ts).getTime() >= wakeAt);
}

async function messageThisTurn(label: string): Promise<DiscordCreateMessageCall> {
  return waitFor(() => (discord.messages.length > 0 ? discord.messages[discord.messages.length - 1] : undefined), label);
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
  (discord.messages as DiscordCreateMessageCall[]).length = 0;

  const wakeAt = await proposeRoutine("lift", "post the standup digest every weekday morning");

  const rows = await waitFor(async () => {
    const got = await rowsSince(wakeAt, APPROVAL_ACTIONS);
    return got.some((r) => r.action === "approval.autoapproved") ? got : undefined;
  }, "this turn's approval.autoapproved row to land");
  const lifted = rows.filter((r) => r.action === "approval.autoapproved");
  expect(lifted).toHaveLength(1);
  expect(lifted[0]!.detail?.resolvedBy).toBe("judge");
  expect(rows.filter((r) => r.action === "approval.requested")).toEqual([]);
  expect(reasons.length).toBeGreaterThan(0);
  wedgeRowId = String(lifted[0]!.detail?.id);

  const message = await messageThisTurn("the judge-lift notice to reach the Discord room");
  expect(discord.messages).toHaveLength(1);
  expect(message.channelId).toBe(DISCORD_LISTED_CHANNEL_ID);
  expect(message.content).toContain("Ran without asking: routine.create");
  expect(message.content).toContain("Auto-approved by the approval judge");
  expect(message.content).not.toContain("Approval requested");
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
  const clickAt = Date.now();

  const first = await postClick(noticeButtonCustomId);
  expect(first.status).toBe(200);
  expect(first.type).toBe(4);
  expect(first.content).toContain("recorded");
  expect(first.content).toContain("does NOT undo the action");
  expect(first.components).toBeUndefined();

  const recorded = await waitFor(async () => {
    const got = await rowsSince(clickAt, ["approval.judge.contradicted"]);
    return got.length > 0 ? got : undefined;
  }, "the approval.judge.contradicted row to land");
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
  expect(await rowsSince(clickAt, ["approval.judge.contradicted"])).toHaveLength(1);
});

test("③ 🔴 with the judge OFF no notice reaches the room, and a contradict click records nothing", async () => {
  await armJudgeMode("off");
  (discord.messages as DiscordCreateMessageCall[]).length = 0;
  const consultsBefore = reasons.length;

  const wakeAt = await proposeRoutine("carded", "post the release notes every weekday afternoon");

  const rows = await waitFor(async () => {
    const got = await rowsSince(wakeAt, APPROVAL_ACTIONS);
    return got.some((r) => r.action === "approval.requested") ? got : undefined;
  }, "this turn's approval.requested row to land");
  expect(rows.filter((r) => r.action === "approval.autoapproved")).toEqual([]);
  expect(reasons.length).toBe(consultsBefore);

  expect(discord.messages).toEqual([]);

  const pendingId = String(rows.find((r) => r.action === "approval.requested")!.detail?.id);
  const clickAt = Date.now();
  const refused = await postClick(`oe-approval:${pendingId}:contradict:${deploymentOrg}`);
  expect(refused.type).toBe(4);
  expect(refused.content).toContain("not auto-approved by the approval judge");
  expect(await rowsSince(clickAt, ["approval.judge.contradicted"])).toEqual([]);
});
