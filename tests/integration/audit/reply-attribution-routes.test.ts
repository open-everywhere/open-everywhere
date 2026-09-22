import { randomBytes } from "node:crypto";
import { expect, test } from "vitest";

import {
  armSettlement,
  auditCursor,
  bootAgent,
  consumeSettlement,
  DISCORD_LISTED_CHANNEL_ID,
  DISCORD_USER_ID,
  discordMentionWake,
  disposeLater,
  registerScript,
  rowsSinceCursor,
  seatReply,
  WAKE_FROM_ENVELOPE,
  taskIdOfDelegation,
  waitFor,
  waitForChildren,
  type AuditRow,
  type ScriptedStep,
} from "../harness";

function freshUnlistedChannelId(): string {
  return `9${randomBytes(8).readBigUInt64BE().toString().padStart(18, "0").slice(0, 18)}`;
}

const TERMINAL_SAY = "oe-659 terminal route answer";
const TOOL_SAY = "oe-659 tool route answer, a third length";
const DROPPED_SAY = "oe-1982 addressed prose that must reach nobody, a deliberately different length";

async function replyRowFor(input: { channelId: string; say: string; route: "tool" | "terminal" }): Promise<AuditRow> {
  const cursor = await auditCursor();
  const settings = await import("@open-everywhere/core/agent/settings/settings.js");
  const topologyBefore = settings.getSettings().window.topology;
  if (input.route === "terminal") {
    settings.overrideSettingsForTest({ window: { topology: false } });
    expect(settings.getSettings().window.topology, "the terminal arm needs the per-surface path — see this function's header").toBe(false);
  }
  const handle = registerScript(
    input.route === "tool" ? { parent: [seatReply(input.say, `oe659-${input.say.length}`), { say: "NO_REPLY" }] } : { parent: [{ say: input.say }] },
  );
  try {
    await discordMentionWake({ channelId: input.channelId, text: `<@9000000000000000001> please answer` });
    await waitFor(() => handle.requests.find((r) => r.role === "parent"), "the scripted model to see the wake");
    const row = await waitFor(async () => {
      const rows = await rowsSinceCursor(cursor, ["reply.post"]);
      return rows.find((r) => r.detail?.chars === input.say.length);
    }, `a reply.post audit row whose reply was ${input.say.length} chars`);
    if (input.route === "tool") await waitFor(() => handle.requests.find((r) => r.role === "parent" && r.stepIndex === 1), "the turn's last step");
    return row;
  } finally {
    handle.dispose();
    if (input.route === "terminal") settings.overrideSettingsForTest({ window: { topology: topologyBefore } });
  }
}

test("both reply routes name the human who mentioned the bot — and they name the SAME one", async () => {
  await bootAgent();

  const terminal = await replyRowFor({ channelId: freshUnlistedChannelId(), say: TERMINAL_SAY, route: "terminal" });
  expect(terminal.detail?.route).toBe("terminal");
  expect(terminal.principalId).toBe(DISCORD_USER_ID);

  const toolRow = await replyRowFor({ channelId: freshUnlistedChannelId(), say: TOOL_SAY, route: "tool" });
  expect(toolRow.detail?.route).toBe("tool");
  expect(toolRow.principalId).toBe(DISCORD_USER_ID);

  expect(terminal.principalId).toBe(toolRow.principalId);

  const chars = [terminal, toolRow].map((r) => r.detail?.chars);
  expect(new Set(chars).size).toBe(2);
  const sessions = [terminal, toolRow].map((r) => r.detail?.sessionId);
  expect(new Set(sessions).size).toBe(2);

  for (const row of [terminal, toolRow]) {
    expect(String(row.detail?.id)).toMatch(/^spoof-/);
    expect(row.detail?.platform).toBe("discord");
  }
  for (const row of [terminal, toolRow]) expect(row.platform).toBe("discord");

  expect(terminal.surface).not.toBe(toolRow.surface);
});

test("OPE-1982 — a direct mention answered in prose reaches NO room, is re-driven exactly once, and a second prose ending is audited silence", async () => {
  await bootAgent();
  const cursor = await auditCursor();
  const handle = disposeLater(registerScript({ parent: [{ say: DROPPED_SAY }] }));

  await discordMentionWake({ channelId: DISCORD_LISTED_CHANNEL_ID, text: `<@9000000000000000001> please answer` });
  await waitFor(() => handle.requests.find((r) => r.role === "parent"), "the scripted model to see the mention");

  const redrives = await waitFor(async () => {
    const rows = await rowsSinceCursor(cursor, ["unified.turn.redrive"]);
    return rows.length > 0 ? rows : undefined;
  }, "the corrective redrive for the dropped prose", 120_000);
  expect(redrives.length).toBe(1);

  await waitFor(async () => {
    const drops = (await rowsSinceCursor(cursor, ["turn.supervisor_prose_dropped"])).filter((r) => r.detail?.chars === DROPPED_SAY.length);
    return drops.length >= 2 ? drops : undefined;
  }, "the re-driven turn's own dropped prose", 120_000);

  const drops = (await rowsSinceCursor(cursor, ["turn.supervisor_prose_dropped"])).filter((r) => r.detail?.chars === DROPPED_SAY.length);
  expect(drops.some((r) => r.detail?.addressing === "direct-mention" && r.detail?.reason === "no-reply-call" && r.detail?.replied === false)).toBe(true);

  expect((await rowsSinceCursor(cursor, ["unified.turn.redrive"])).length).toBe(1);

  const posts = await rowsSinceCursor(cursor, ["reply.post"]);
  expect(posts.filter((r) => r.detail?.chars === DROPPED_SAY.length)).toEqual([]);
  expect(posts.some((r) => r.detail?.route === "bridge")).toBe(false);
});

const DELEGATOR_SAY = "oe-659 handing this off to a worker";

function delegatorReply(id: string): ScriptedStep {
  return { calls: [{ tool: "reply", input: { text: DELEGATOR_SAY, wake: WAKE_FROM_ENVELOPE, done: false }, id }] };
}
const SETTLEMENT_SAY = "oe-659 the worker has reported back to me";
const REGRESSION_SETTLEMENT_SAY = "oe-734 regression settlement reply, a fifth length distinct from the rest";

{
  const fingerprints = {
    TERMINAL_SAY: TERMINAL_SAY.length,
    TOOL_SAY: TOOL_SAY.length,
    DROPPED_SAY: DROPPED_SAY.length,
    SETTLEMENT_SAY: SETTLEMENT_SAY.length,
    REGRESSION_SETTLEMENT_SAY: REGRESSION_SETTLEMENT_SAY.length,
    DELEGATOR_SAY: DELEGATOR_SAY.length,
  };
  const counts = Object.values(fingerprints);
  if (new Set(counts).size !== counts.length) {
    throw new Error(
      `OPE-659/OPE-734 test: the replies must differ in LENGTH — detail.chars is the only fingerprint a reply.post row carries. Saw ${JSON.stringify(fingerprints)}. Give the colliding reply a different text.`,
    );
  }
}

test("a HOST-WOKEN settlement reply names the human whose seat it is — the auth the turn inherits (OPE-659)", async () => {
  await bootAgent();
  const cursor = await auditCursor();

  const handle = disposeLater(
    registerScript({
      parent: [{ calls: [{ tool: "agent", input: { message: "look something up" }, id: "oe659-delegate" }] }, delegatorReply("oe659-delegator-reply"), { say: "NO_REPLY" }],
      child: [{ say: "the worker's own prose, which never leaves the parent's session" }],
    }),
  );
  await discordMentionWake({ channelId: DISCORD_LISTED_CHANNEL_ID, text: `<@9000000000000000001> please delegate this` });
  await waitFor(() => handle.requests.find((r) => r.role === "parent" && r.stepIndex === 2), "the delegating turn's terminal step");

  const taskId = taskIdOfDelegation(handle, "the OPE-659 delegation");

  const settlementHandle = disposeLater(
    armSettlement(handle, {
      parent: [seatReply(SETTLEMENT_SAY, "oe659-settlement-reply"), { say: "NO_REPLY" }],
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
      const got = (await rowsSinceCursor(cursor, ["reply.post"])).filter((r) => r.detail?.route === "tool");
      return got.some((r) => r.detail?.chars === SETTLEMENT_SAY.length) ? got : undefined;
    },
    "the settlement turn's reply row",
    120_000,
  );

  const delegator = rows.find((r) => r.detail?.chars === DELEGATOR_SAY.length);
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
  const cursor = await auditCursor();

  const handle = disposeLater(
    registerScript({
      parent: [{ calls: [{ tool: "agent", input: { message: "look something up" }, id: "ope734-delegate" }] }, delegatorReply("ope734-delegator-reply"), { say: "NO_REPLY" }],
      child: [{ say: "the worker's own prose, which never leaves the parent's session" }],
    }),
  );
  const say = REGRESSION_SETTLEMENT_SAY;
  await discordMentionWake({ channelId: DISCORD_LISTED_CHANNEL_ID, text: `<@9000000000000000001> please delegate this too` });
  await waitFor(() => handle.requests.find((r) => r.role === "parent" && r.stepIndex === 2), "the delegating turn's terminal step");
  const taskId = taskIdOfDelegation(handle, "the OPE-734 delegation");

  const settlementHandle = disposeLater(
    armSettlement(handle, {
      parent: [seatReply(say, "ope734-settlement-reply"), { say: "NO_REPLY" }],
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
      const got = (await rowsSinceCursor(cursor, ["reply.post"])).filter((r) => r.detail?.route === "tool");
      return got.some((r) => r.detail?.chars === say.length) ? got : undefined;
    },
    "the settlement turn's reply row",
  );
  expect(rows.some((r) => r.detail?.chars === say.length)).toBe(true);
});
