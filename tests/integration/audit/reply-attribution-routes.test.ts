import { randomBytes } from "node:crypto";
import { expect, test } from "vitest";

import {
  armSettlement,
  bootAgent,
  consumeSettlement,
  discordMentionWake,
  disposeLater,
  DISCORD_LISTED_CHANNEL_ID,
  DISCORD_USER_ID,
  pendingFramedChars,
  readAuditRows,
  registerScript,
  taskIdOfDelegation,
  waitFor,
  waitForChildren,
  type AuditRow,
} from "../harness";

function freshUnlistedChannelId(): string {
  return `9${randomBytes(8).readBigUInt64BE().toString().padStart(18, "0").slice(0, 18)}`;
}

const TERMINAL_SAY = "oe-659 terminal route answer";
const BRIDGE_SAY = "oe-659 bridge route answer, a deliberately different length";
if (TERMINAL_SAY.length === BRIDGE_SAY.length) {
  throw new Error("OPE-659 test: the two replies must differ in LENGTH — detail.chars is the only fingerprint a reply.post row carries.");
}

async function replyRowFor(input: { channelId: string; say: string }): Promise<AuditRow> {
  const sinceIso = new Date(Date.now() - 10_000).toISOString();
  const handle = registerScript({ parent: [{ say: input.say }] });
  try {
    await discordMentionWake({ channelId: input.channelId, text: `<@9000000000000000001> please answer` });
    await waitFor(() => handle.requests.find((r) => r.role === "parent"), "the scripted model to see the wake");
    return await waitFor(async () => {
      const rows = await readAuditRows({ actions: ["reply.post"], sinceIso });
      return rows.find((r) => r.detail?.chars === input.say.length);
    }, `a reply.post audit row whose reply was ${input.say.length} chars`);
  } finally {
    handle.dispose();
  }
}

test("both terminal reply routes name the human who mentioned the bot — and they name the SAME one", async () => {
  await bootAgent();

  const terminal = await replyRowFor({ channelId: freshUnlistedChannelId(), say: TERMINAL_SAY });
  expect(terminal.detail?.route).toBe("terminal");
  expect(terminal.principalId).toBe(DISCORD_USER_ID);

  const bridge = await replyRowFor({ channelId: DISCORD_LISTED_CHANNEL_ID, say: BRIDGE_SAY });
  expect(bridge.detail?.route).toBe("bridge");
  expect(bridge.principalId).toBe(DISCORD_USER_ID);

  expect(bridge.principalId).toBe(terminal.principalId);

  expect(terminal.detail?.chars).not.toBe(bridge.detail?.chars);
  expect(terminal.detail?.sessionId).not.toBe(bridge.detail?.sessionId);

  for (const row of [terminal, bridge]) {
    expect(String(row.detail?.id)).toMatch(/^spoof-/);
    expect(row.detail?.platform).toBe("discord");
  }
  expect(terminal.platform).toBe("discord");
  expect(bridge.platform).toBe("unified");
});

const DELEGATOR_SAY = "oe-659 handing this off to a worker";
const SETTLEMENT_SAY = "oe-659 the worker has reported back to me";

test("a HOST-WOKEN settlement reply names the human whose seat it is — the auth the turn inherits (OPE-659)", async () => {
  await bootAgent();
  const sinceIso = new Date(Date.now() - 10_000).toISOString();

  const handle = disposeLater(
    registerScript({
      parent: [{ calls: [{ tool: "agent", input: { message: "look something up" }, id: "oe659-delegate" }] }, { say: DELEGATOR_SAY }],
      child: [{ say: "the worker's own prose, which never leaves the parent's session" }],
    }),
  );
  await discordMentionWake({ channelId: DISCORD_LISTED_CHANNEL_ID, text: `<@9000000000000000001> please delegate this` });
  await waitFor(() => handle.requests.find((r) => r.role === "parent" && r.stepIndex === 1), "the delegating turn's terminal step");

  const taskId = taskIdOfDelegation(handle, "the OPE-659 delegation");

  const settlementHandle = disposeLater(
    armSettlement(handle, {
      parent: [{ calls: [{ tool: "task_peek", input: { taskIds: [taskId] }, id: "oe659-peek" }] }, { say: SETTLEMENT_SAY }],
    }),
  );
  await waitForChildren(handle, { count: 1, lastStepIndex: 0, label: "the worker's own model call" });

  const notification = await consumeSettlement({
    armed: settlementHandle,
    dispatched: handle,
    taskId,
    label: "the settled worker's completion, delivered as a new message naming the task id",
  });
  expect(notification.fault).toBeUndefined();
  await waitFor(() => settlementHandle.requests.find((r) => r.role === "parent" && r.stepIndex === 1), "the settlement turn's terminal step");

  const rows = await waitFor(
    async () => {
      const got = (await readAuditRows({ actions: ["reply.post"], sinceIso })).filter((r) => r.detail?.route === "bridge");
      return got.some((r) => r.detail?.chars === SETTLEMENT_SAY.length) ? got : undefined;
    },
    "the settlement turn's bridged reply row",
    120_000,
  );

  const delegator = rows.find((r) => r.detail?.chars === pendingFramedChars(DELEGATOR_SAY));
  const settled = rows.find((r) => r.detail?.chars === SETTLEMENT_SAY.length);
  expect(delegator).toBeDefined();
  expect(settled).toBeDefined();
  expect(delegator!.principalId).toBe(DISCORD_USER_ID);
  expect(settled!.principalId).toBe(DISCORD_USER_ID);

  expect(settled!.detail?.sessionId).toBe(delegator!.detail?.sessionId);
  expect(typeof settled!.detail?.sessionId).toBe("string");
});

test("OPE-734 — arming the settlement script under the dispatch turn's session id wins even if the stale ANY_SESSION entry is never disposed", async () => {
  await bootAgent();
  const sinceIso = new Date(Date.now() - 10_000).toISOString();

  const handle = disposeLater(
    registerScript({
      parent: [{ calls: [{ tool: "agent", input: { message: "look something up" }, id: "ope734-delegate" }] }, { say: DELEGATOR_SAY }],
      child: [{ say: "the worker's own prose, which never leaves the parent's session" }],
    }),
  );
  const say = "oe-734 regression settlement reply, a third distinct length";
  await discordMentionWake({ channelId: DISCORD_LISTED_CHANNEL_ID, text: `<@9000000000000000001> please delegate this too` });
  await waitFor(() => handle.requests.find((r) => r.role === "parent" && r.stepIndex === 1), "the delegating turn's terminal step");
  const taskId = taskIdOfDelegation(handle, "the OPE-734 delegation");

  const settlementHandle = disposeLater(
    armSettlement(handle, {
      parent: [{ calls: [{ tool: "task_peek", input: { taskIds: [taskId] }, id: "ope734-peek" }] }, { say }],
    }),
  );

  await waitForChildren(handle, { count: 1, lastStepIndex: 0, label: "the worker's own model call" });
  const notification = await waitFor(
    () => settlementHandle.requests.find((r) => r.role === "parent" && r.messages.some((m) => m.text.includes(taskId))),
    "the settlement turn to land on the armed, session-scoped entry",
  );

  expect(notification.fault).toBeUndefined();
  expect(handle.requests.filter((r) => r.fault !== undefined)).toEqual([]);
  expect(settlementHandle.requests.filter((r) => r.fault !== undefined)).toEqual([]);
  expect(handle.requests.some((r) => r.turnId === notification.turnId)).toBe(false);

  await waitFor(() => settlementHandle.requests.find((r) => r.role === "parent" && r.stepIndex === 1), "the settlement turn's terminal step");
  const rows = await waitFor(
    async () => {
      const got = (await readAuditRows({ actions: ["reply.post"], sinceIso })).filter((r) => r.detail?.route === "bridge");
      return got.some((r) => r.detail?.chars === say.length) ? got : undefined;
    },
    "the settlement turn's bridged reply row",
  );
  expect(rows.some((r) => r.detail?.chars === say.length)).toBe(true);
});
