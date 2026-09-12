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
  readAuditRows,
  registerScript,
  seatReply,
  taskIdOfDelegation,
  waitFor,
  waitForChildren,
  type AuditRow,
} from "../harness";

function freshUnlistedChannelId(): string {
  return `9${randomBytes(8).readBigUInt64BE().toString().padStart(18, "0").slice(0, 18)}`;
}

const TERMINAL_SAY = "oe-659 terminal route answer";
const TOOL_SAY = "oe-659 tool route answer, a third length";
const BRIDGE_SAY = "oe-659 bridge route answer, a deliberately different length that is longer";

async function replyRowFor(input: { channelId: string; say: string; route: "tool" | "bridge" | "terminal" }): Promise<AuditRow> {
  const sinceIso = new Date(Date.now() - 10_000).toISOString();
  const settings = await import("@open-everywhere/core/agent/settings/settings.js");
  const topologyBefore = settings.getSettings().window.topology;
  if (input.route === "terminal") {
    settings.overrideSettingsForTest({ window: { topology: false } });
    expect(settings.getSettings().window.topology, "the terminal arm needs the per-surface path — see this function's header").toBe(false);
  }
  const handle = registerScript(
    input.route === "tool" ? { parent: [seatReply(input.say, `oe659-${input.say.length}`), { say: "done" }] } : { parent: [{ say: input.say }] },
  );
  try {
    await discordMentionWake({ channelId: input.channelId, text: `<@9000000000000000001> please answer` });
    await waitFor(() => handle.requests.find((r) => r.role === "parent"), "the scripted model to see the wake");
    const row = await waitFor(async () => {
      const rows = await readAuditRows({ actions: ["reply.post"], sinceIso });
      return rows.find((r) => r.detail?.chars === input.say.length);
    }, `a reply.post audit row whose reply was ${input.say.length} chars`);
    if (input.route === "tool") await waitFor(() => handle.requests.find((r) => r.role === "parent" && r.stepIndex === 1), "the turn's last step");
    return row;
  } finally {
    handle.dispose();
    if (input.route === "terminal") settings.overrideSettingsForTest({ window: { topology: topologyBefore } });
  }
}

test("all three reply routes name the human who mentioned the bot — and they name the SAME one", async () => {
  await bootAgent();

  const terminal = await replyRowFor({ channelId: freshUnlistedChannelId(), say: TERMINAL_SAY, route: "terminal" });
  expect(terminal.detail?.route).toBe("terminal");
  expect(terminal.principalId).toBe(DISCORD_USER_ID);

  const toolRow = await replyRowFor({ channelId: freshUnlistedChannelId(), say: TOOL_SAY, route: "tool" });
  expect(toolRow.detail?.route).toBe("tool");
  expect(toolRow.principalId).toBe(DISCORD_USER_ID);

  const bridge = await replyRowFor({ channelId: DISCORD_LISTED_CHANNEL_ID, say: BRIDGE_SAY, route: "bridge" });
  expect(bridge.detail?.route).toBe("bridge");
  expect(bridge.principalId).toBe(DISCORD_USER_ID);

  expect(bridge.principalId).toBe(toolRow.principalId);
  expect(terminal.principalId).toBe(toolRow.principalId);

  const chars = [terminal, toolRow, bridge].map((r) => r.detail?.chars);
  expect(new Set(chars).size).toBe(3);
  const sessions = [terminal, toolRow, bridge].map((r) => r.detail?.sessionId);
  expect(new Set(sessions).size).toBe(3);

  for (const row of [terminal, toolRow, bridge]) {
    expect(String(row.detail?.id)).toMatch(/^spoof-/);
    expect(row.detail?.platform).toBe("discord");
  }
  expect(terminal.platform).toBe("discord");
  expect(toolRow.platform).toBe("discord");
  expect(bridge.platform).toBe("unified");
  expect(toolRow.surface).not.toBe(bridge.surface);
  expect(terminal.surface).not.toBe(toolRow.surface);
});

const DELEGATOR_SAY = "oe-659 handing this off to a worker";
const SETTLEMENT_SAY = "oe-659 the worker has reported back to me";
const REGRESSION_SETTLEMENT_SAY = "oe-734 regression settlement reply, a fifth length distinct from the rest";

{
  const fingerprints = {
    TERMINAL_SAY: TERMINAL_SAY.length,
    TOOL_SAY: TOOL_SAY.length,
    BRIDGE_SAY: BRIDGE_SAY.length,
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
      parent: [{ say: SETTLEMENT_SAY }],
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
  await waitFor(() => settlementHandle.requests.find((r) => r.role === "parent" && r.stepIndex === 0), "the settlement turn's terminal step");

  const rows = await waitFor(
    async () => {
      const got = (await readAuditRows({ actions: ["reply.post"], sinceIso })).filter((r) => r.detail?.route === "bridge");
      return got.some((r) => r.detail?.chars === SETTLEMENT_SAY.length) ? got : undefined;
    },
    "the settlement turn's bridged reply row",
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
  const sinceIso = new Date(Date.now() - 10_000).toISOString();

  const handle = disposeLater(
    registerScript({
      parent: [{ calls: [{ tool: "agent", input: { message: "look something up" }, id: "ope734-delegate" }] }, { say: DELEGATOR_SAY }],
      child: [{ say: "the worker's own prose, which never leaves the parent's session" }],
    }),
  );
  const say = REGRESSION_SETTLEMENT_SAY;
  await discordMentionWake({ channelId: DISCORD_LISTED_CHANNEL_ID, text: `<@9000000000000000001> please delegate this too` });
  await waitFor(() => handle.requests.find((r) => r.role === "parent" && r.stepIndex === 1), "the delegating turn's terminal step");
  const taskId = taskIdOfDelegation(handle, "the OPE-734 delegation");

  const settlementHandle = disposeLater(
    armSettlement(handle, {
      parent: [{ say }],
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

  await waitFor(() => settlementHandle.requests.find((r) => r.role === "parent" && r.stepIndex === 0), "the settlement turn's terminal step");
  const rows = await waitFor(
    async () => {
      const got = (await readAuditRows({ actions: ["reply.post"], sinceIso })).filter((r) => r.detail?.route === "bridge");
      return got.some((r) => r.detail?.chars === say.length) ? got : undefined;
    },
    "the settlement turn's bridged reply row",
  );
  expect(rows.some((r) => r.detail?.chars === say.length)).toBe(true);
});
