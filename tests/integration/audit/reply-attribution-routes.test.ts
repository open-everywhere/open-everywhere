import { randomBytes } from "node:crypto";
import { expect, test } from "vitest";

import {
  armSettlement,
  auditCursor,
  awaitWindowQuiet,
  awaitWorkResult,
  bootAgent,
  DISCORD_LISTED_CHANNEL_ID,
  DISCORD_USER_ID,
  discordMentionWake,
  disposeLater,
  registerScript,
  rowsSinceCursor,
  seatReply,
  WAKE_FROM_ENVELOPE,
  waitFor,
  waitForChildren,
  workTaskIdOfCall,
  type AuditRow,
  type RecordedRequest,
  type ScriptedHandle,
  type ScriptedStep,
} from "../harness";

function freshUnlistedChannelId(): string {
  return `9${randomBytes(8).readBigUInt64BE().toString().padStart(18, "0").slice(0, 18)}`;
}

const DROPPED_PER_SURFACE_SAY = "oe-2006 per-surface closing prose that must reach nobody";
const TOOL_SAY = "oe-659 tool route answer, a third length";
const DROPPED_SAY = "oe-1982 addressed prose that must reach nobody, a deliberately different length";

async function replyRowFor(input: { channelId: string; say: string; route: "tool" | "dropped" }): Promise<AuditRow> {
  const cursor = await auditCursor();
  const settings = await import("@open-everywhere/core/agent/settings/settings.js");
  const topologyBefore = settings.getSettings().window.topology;
  if (input.route === "dropped") {
    settings.overrideSettingsForTest({ window: { topology: false } });
    expect(settings.getSettings().window.topology, "the dropped arm needs the per-surface path — see this function's header").toBe(false);
  }
  const handle = registerScript(
    input.route === "tool" ? { parent: [seatReply(input.say, `oe659-${input.say.length}`)] } : { parent: [{ say: input.say }] },
  );
  try {
    await discordMentionWake({ channelId: input.channelId, text: `<@9000000000000000001> please answer` });
    await waitFor(() => handle.requests.find((r) => r.role === "parent"), "the scripted model to see the wake");
    const action = input.route === "tool" ? "reply.post" : "turn.supervisor_prose_dropped";
    const row = await waitFor(async () => {
      const rows = await rowsSinceCursor(cursor, [action]);
      return rows.find((r) => r.detail?.chars === input.say.length);
    }, `a ${action} audit row whose text was ${input.say.length} chars`);
    if (input.route === "dropped") {
      const posts = (await rowsSinceCursor(cursor, ["reply.post"])).filter((r) => r.detail?.chars === input.say.length);
      expect(posts, "a dropped turn writes NO reply.post row").toEqual([]);
    }
    if (input.route === "tool") {
      await awaitWindowQuiet();
      expect(handle.requests.some((r) => r.role === "parent" && r.stepIndex !== 0), "a step after the reply was requested").toBe(false);
      expect(handle.requests.filter((r) => r.fault !== undefined)).toEqual([]);
    }
    return row;
  } finally {
    handle.dispose();
    if (input.route === "dropped") settings.overrideSettingsForTest({ window: { topology: topologyBefore } });
  }
}

test("the reply tool names the human who mentioned the bot, and a per-surface prose turn reaches nobody", async () => {
  await bootAgent();

  const dropped = await replyRowFor({ channelId: freshUnlistedChannelId(), say: DROPPED_PER_SURFACE_SAY, route: "dropped" });
  expect(dropped.platform).toBe("discord");

  const toolRow = await replyRowFor({ channelId: freshUnlistedChannelId(), say: TOOL_SAY, route: "tool" });
  expect(toolRow.detail?.route).toBe("tool");
  expect(toolRow.principalId).toBe(DISCORD_USER_ID);

  expect(toolRow.principalId).toBe(DISCORD_USER_ID);

  const chars = [dropped, toolRow].map((r) => r.detail?.chars);
  expect(new Set(chars).size).toBe(2);
  const sessions = [dropped, toolRow].map((r) => r.detail?.sessionId);
  expect(new Set(sessions).size).toBe(2);

  expect(String(toolRow.detail?.id)).toMatch(/^spoof-/);
  expect(toolRow.detail?.platform).toBe("discord");
  expect(dropped.detail?.id, "the drop row names no message — nothing was posted to name").toBeUndefined();
  for (const row of [dropped, toolRow]) expect(row.platform).toBe("discord");

  expect(dropped.surface).not.toBe(toolRow.surface);
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
    DROPPED_PER_SURFACE_SAY: DROPPED_PER_SURFACE_SAY.length,
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

function delegatingArm(ids: string): ScriptedStep[] {
  return [
    { calls: [{ tool: "work", input: { message: "look something up" }, id: `${ids}-delegate` }] },
    delegatorReply(`${ids}-delegator-reply`),
  ];
}

function resultWakeArm(ids: string, resultSay: string): ScriptedStep[] {
  return [seatReply(resultSay, `${ids}-settlement-reply`)];
}

const HELD_WORKER: ScriptedStep[] = [{ delayMs: 120_000, say: "the worker's own prose, which never leaves the parent's session" }];

async function driveHeldDelegation(input: {
  readonly handle: ScriptedHandle;
  readonly ids: string;
  readonly resultSay: string;
  readonly cursor: Awaited<ReturnType<typeof auditCursor>>;
}): Promise<{ readonly dispatchStep: RecordedRequest; readonly resultStep: RecordedRequest; readonly taskId: string; readonly settlement: ScriptedHandle }> {
  const { handle, ids, cursor } = input;
  await waitFor(async () => {
    const rows = (await rowsSinceCursor(cursor, ["reply.post"])).filter((r) => r.detail?.route === "tool");
    return rows.find((r) => r.detail?.chars === DELEGATOR_SAY.length);
  }, `the ${ids} hand-off reply's reply.post row`);
  const settlement = disposeLater(armSettlement(handle, { parent: resultWakeArm(ids, input.resultSay) }));
  const taskId = await workTaskIdOfCall(cursor, handle, `${ids}-delegate`, `the ${ids} forward receipt`);
  await waitForChildren(handle, { count: 1, lastStepIndex: 0, label: `the ${ids} worker to enter its hold` });
  handle.releaseHolds();
  const resultStep = await awaitWorkResult({ handle: settlement, taskId, label: `the ${ids} seat step that read the worker's result` });
  await awaitWindowQuiet();
  expect(handle.holdsCutShort(), "the worker's hold ended on the release, not on its 120 s backstop").toBe(1);
  const dispatchStep = handle.requests.find((r) => r.role === "parent" && r.stepIndex === 0);
  expect(dispatchStep, `the ${ids} dispatch step`).toBeDefined();
  expect(resultStep.stepIndex).toBe(0);
  const parentSteps = new Set(handle.requests.filter((r) => r.role === "parent").map((r) => r.stepIndex));
  expect([...parentSteps].sort((a, b) => a - b)).toEqual([0, 1]);
  const resultSteps = new Set(settlement.requests.filter((r) => r.role === "parent").map((r) => r.stepIndex));
  expect([...resultSteps]).toEqual([0]);
  return { dispatchStep: dispatchStep!, resultStep, taskId, settlement };
}

test("the reply after a worker's result names the human who asked — the held turn keeps that delivery's auth (OPE-659, re-derived for eve 0.71 by OPE-2314 and for the work session by OPE-2338)", async () => {
  await bootAgent();
  const cursor = await auditCursor();

  const handle = disposeLater(registerScript({ parent: delegatingArm("oe659"), child: HELD_WORKER }));
  await discordMentionWake({ channelId: DISCORD_LISTED_CHANNEL_ID, text: `<@9000000000000000001> please delegate this` });

  const { dispatchStep, resultStep, taskId, settlement } = await driveHeldDelegation({ handle, ids: "oe659", resultSay: SETTLEMENT_SAY, cursor });
  expect(resultStep.fault).toBeUndefined();
  expect(handle.requests.filter((r) => r.fault !== undefined)).toEqual([]);
  expect(settlement.requests.filter((r) => r.fault !== undefined)).toEqual([]);

  const rows = await waitFor(
    async () => {
      const got = (await rowsSinceCursor(cursor, ["reply.post"])).filter((r) => r.detail?.route === "tool");
      return got.some((r) => r.detail?.chars === SETTLEMENT_SAY.length) ? got : undefined;
    },
    "the result half's reply row",
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
  expect(typeof dispatchStep.turnId, "the recorder stamps eve's turn id").toBe("string");
  expect(resultStep.turnId, "the result arrives in a seat turn of its own (OPE-2338)").not.toBe(dispatchStep.turnId);
  await waitFor(
    async () => (await rowsSinceCursor(cursor, ["work.result_wake"])).find((r) => r.detail?.taskId === taskId && r.detail?.outcome === "delivered"),
    "the work.result_wake row for this task",
  );
  const wakeRows = await waitFor(async () => {
    const got = (await rowsSinceCursor(cursor, ["unified.task_wake"])).filter((r) => String(r.detail?.task) === taskId);
    return got.length > 0 ? got : undefined;
  }, "the settlement edge's unified.task_wake row for this task");
  const outcomes = wakeRows.map((r) => String(r.detail?.outcome));
  expect(outcomes).toContain("ingressed");
  expect(outcomes).not.toContain("installed");
});

test("OPE-734 — with the dispatch script never disposed, the result wake is served by its own session-keyed script, with no fault", async () => {
  await bootAgent();
  const cursor = await auditCursor();

  const handle = disposeLater(registerScript({ parent: delegatingArm("ope734"), child: HELD_WORKER }));
  const say = REGRESSION_SETTLEMENT_SAY;
  await discordMentionWake({ channelId: DISCORD_LISTED_CHANNEL_ID, text: `<@9000000000000000001> please delegate this too` });

  const { dispatchStep, resultStep, settlement } = await driveHeldDelegation({ handle, ids: "ope734", resultSay: say, cursor });

  expect(resultStep.fault).toBeUndefined();
  expect(handle.requests.filter((r) => r.fault !== undefined)).toEqual([]);
  expect(handle.resolves.filter((r) => r.fault !== undefined)).toEqual([]);
  expect(settlement.requests.filter((r) => r.fault !== undefined)).toEqual([]);
  expect(settlement.resolves.filter((r) => r.fault !== undefined)).toEqual([]);
  expect(typeof dispatchStep.turnId, "the recorder stamps eve's turn id").toBe("string");
  const parentTurns = new Set(handle.requests.filter((r) => r.role === "parent").map((r) => r.turnId));
  expect([...parentTurns]).toEqual([dispatchStep.turnId]);
  expect(resultStep.turnId).not.toBe(dispatchStep.turnId);

  const rows = await waitFor(
    async () => {
      const got = (await rowsSinceCursor(cursor, ["reply.post"])).filter((r) => r.detail?.route === "tool");
      return got.some((r) => r.detail?.chars === say.length) ? got : undefined;
    },
    "the result half's reply row",
  );
  expect(rows.some((r) => r.detail?.chars === say.length)).toBe(true);
});
