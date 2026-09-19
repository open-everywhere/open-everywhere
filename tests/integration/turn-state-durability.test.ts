import { randomBytes } from "node:crypto";
import { expect, test } from "vitest";
import {
  afterThisTest,
  auditCursor,
  bootAgent,
  DISCORD_GUILD_ID,
  discordMentionWake,
  disposeLater,
  registerScript,
  rowsSinceCursor,
  runRoutineDispatchTick,
  seedDueRoutine,
  waitFor,
  wrapToolExecute,
} from "./harness";

function freshUnlistedChannelId(): string {
  return `9${randomBytes(8).readBigUInt64BE().toString().padStart(18, "0").slice(0, 18)}`;
}

test("a real turn's step count is stored under the (session, turn) key the boundary itself records", async () => {
  await bootAgent({ sharedSqlite: true });

  const settings = await import("@open-everywhere/core/agent/settings/settings.js");
  settings.overrideSettingsForTest({ turn: { stepBudget: 2, stepBackstopMultiple: 2 } });
  expect(settings.getSettings().turn.stepBudget).toBe(2);
  afterThisTest(() => settings.overrideSettingsForTest({ turn: { stepBudget: 120, stepBackstopMultiple: 3 } }));

  const restoreTool = wrapToolExecute("list_routines", async () => ({ routines: [] }));
  afterThisTest(restoreTool);

  const handle = disposeLater(
    registerScript({
      parent: [
        { calls: [{ tool: "list_routines", input: {}, id: "d1" }] },
        { calls: [{ tool: "list_routines", input: {}, id: "d2" }] },
        { calls: [{ tool: "list_routines", input: {}, id: "d3" }] },
        { calls: [{ tool: "list_routines", input: {}, id: "d4" }] },
        { calls: [{ tool: "list_routines", input: {}, id: "d5" }] },
        { say: "should never be reached — the hard backstop ends the turn first" },
      ],
    }),
  );

  const channelId = freshUnlistedChannelId();
  const cursor = await auditCursor();
  await discordMentionWake({ channelId, text: "<@9000000000000000001> loop please" });

  const hard = await waitFor(async () => {
    const found = (await rowsSinceCursor(cursor, ["turn.step_boundary"])).filter((r) => r.surface === channelId);
    return found.find((r) => (r.detail ?? {}).tier === "hard");
  }, "a hard turn.step_boundary audit row");
  expect(handle.requests.filter((r) => r.fault !== undefined)).toEqual([]);

  const sessionId = (hard.detail ?? {}).sessionId as string | undefined;
  const turnId = (hard.detail ?? {}).turnId as string | undefined;
  expect(typeof sessionId).toBe("string");
  expect(sessionId?.length).toBeGreaterThan(0);
  expect(typeof turnId).toBe("string");
  expect(turnId?.length).toBeGreaterThan(0);

  const turnState = await import("@open-everywhere/core/agent/model/turn-state.js");
  const provider = await import("@open-everywhere/core/agent/operational/provider.js");
  const rowKey = turnState.turnStateRowKey(turnState.turnPairKey(sessionId, turnId!));
  const raw = await provider.getOperationalStore().getTaskResult("default", rowKey);

  expect(raw).not.toBeNull();
  expect(turnState.parseTurnState(raw)?.steps).toBe(hard.detail?.steps);
  expect(hard.detail?.steps).toBe(5);
});

test("a scheduled routine fire carries an eve session id at the step-boundary seam", async () => {
  await bootAgent({ sharedSqlite: true });

  const settings = await import("@open-everywhere/core/agent/settings/settings.js");
  settings.overrideSettingsForTest({ turn: { stepBudget: 2, stepBackstopMultiple: 2 } });
  expect(settings.getSettings().turn.stepBudget).toBe(2);
  afterThisTest(() => settings.overrideSettingsForTest({ turn: { stepBudget: 120, stepBackstopMultiple: 3 } }));

  const restoreTool = wrapToolExecute("list_routines", async () => ({ routines: [] }));
  afterThisTest(restoreTool);

  const handle = disposeLater(
    registerScript({
      parent: [
        { calls: [{ tool: "list_routines", input: {}, id: "f1" }] },
        { calls: [{ tool: "list_routines", input: {}, id: "f2" }] },
        { calls: [{ tool: "list_routines", input: {}, id: "f3" }] },
        { calls: [{ tool: "list_routines", input: {}, id: "f4" }] },
        { calls: [{ tool: "list_routines", input: {}, id: "f5" }] },
        { say: "should never be reached — the hard backstop ends the turn first" },
      ],
    }),
  );

  const channelId = freshUnlistedChannelId();
  const cursor = await auditCursor();
  await seedDueRoutine({
    surfaceKey: `discord/${DISCORD_GUILD_ID}/${channelId}`,
    channelId,
    prompt: "loop please",
    createdBy: "U0FIRECREATOR",
  });
  expect((await runRoutineDispatchTick()).length).toBeGreaterThan(0);

  const hard = await waitFor(async () => {
    const found = (await rowsSinceCursor(cursor, ["turn.step_boundary"])).filter((r) => r.surface === channelId);
    return found.find((r) => (r.detail ?? {}).tier === "hard");
  }, "a hard turn.step_boundary audit row from the routine fire");
  expect(handle.requests.filter((r) => r.fault !== undefined)).toEqual([]);

  const sessionId = (hard.detail ?? {}).sessionId as string | undefined;
  const turnId = (hard.detail ?? {}).turnId as string | undefined;
  expect(typeof sessionId).toBe("string");
  expect(sessionId?.length).toBeGreaterThan(0);
  expect(typeof turnId).toBe("string");
  expect(turnId?.length).toBeGreaterThan(0);

  const turnState = await import("@open-everywhere/core/agent/model/turn-state.js");
  const provider = await import("@open-everywhere/core/agent/operational/provider.js");
  const store = provider.getOperationalStore();
  const sessionKeyed = await store.getTaskResult("default", turnState.turnStateRowKey(turnState.turnPairKey(sessionId, turnId!)));
  expect(sessionKeyed).not.toBeNull();
  expect(turnState.parseTurnState(sessionKeyed)?.steps).toBe(hard.detail?.steps);
  const bareKeyed = await store.getTaskResult("default", turnState.turnStateRowKey(turnState.turnPairKey(undefined, turnId!)));
  expect(bareKeyed).toBeNull();
});
