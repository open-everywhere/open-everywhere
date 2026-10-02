import { randomBytes } from "node:crypto";
import { expect, test } from "vitest";
import {
  afterThisTest,
  armSettlement,
  auditCursor,
  bootAgent,
  consumeSettlement,
  controlGet,
  DISCORD_GUILD_ID,
  DISCORD_LISTED_CHANNEL_ID,
  disposeLater,
  registerScript,
  rowsSinceCursor,
  runRoutineDispatchTick,
  SETTLEMENT_DRAIN_SCRIPT,
  taskIdOfDelegation,
  waitFor,
  waitForChildren,
  type AuditRow,
} from "../harness";

const SETTLEMENT_FLUSH_ACTION = "memory.settlement_flush";
const ROUTINE_FIRE_ACTION = "routine.fire";
const TASK_SETTLED_ACTION = "delegation.task_settled";
const TERMINAL_SESSION_EVENTS = ["session.completed", "session.failed"] as const;
const SUPERVISOR_FAILURE_ACTIONS = ["unified.supervisor_session_failed", "unified.supervisor_turn_failed"] as const;

const SURFACE_KEY = `discord/${DISCORD_GUILD_ID}/${DISCORD_LISTED_CHANNEL_ID}`;

function flushView(row: AuditRow): { edge: unknown; outcome: unknown; liveTasks: unknown; surfaceKey: unknown } {
  const detail = (row.detail ?? {}) as Record<string, unknown>;
  return { edge: detail.edge, outcome: detail.outcome, liveTasks: detail.liveTasks, surfaceKey: detail.surfaceKey };
}

test("a routine fire's memory flush and settlement row land when its delegated work completes, with its session still parked", async () => {
  await bootAgent({ sharedSqlite: true });
  const cursor = await auditCursor();

  const { addRoutine, getRoutine } = await import("@open-everywhere/core/agent/routines/store.js");
  const id = `r-it-2269-${randomBytes(4).toString("hex")}`;
  const dueAt = new Date(Date.now() - 60_000).toISOString();
  const scope = {
    org: "default",
    platform: "discord",
    workspace: DISCORD_GUILD_ID,
    surface: DISCORD_LISTED_CHANNEL_ID,
    workspaceKey: `discord/${DISCORD_GUILD_ID}`,
    surfaceKey: SURFACE_KEY,
    domainKey: SURFACE_KEY,
    key: SURFACE_KEY,
  };
  await addRoutine(scope, {
    id,
    org: "default",
    surfaceKey: SURFACE_KEY,
    target: { channelId: DISCORD_LISTED_CHANNEL_ID, guildId: DISCORD_GUILD_ID, channelType: "0" },
    trigger: { kind: "once", at: dueAt },
    prompt: "gather the numbers and report",
    createdBy: "discord:9000000000000000042",
    status: "active",
    nextRunAt: dueAt,
    createdAt: new Date(Date.now() - 120_000).toISOString(),
    consecutiveFailures: 0,
  });

  const handle = disposeLater(
    registerScript({
      parent: [
        { calls: [{ tool: "agent", input: { message: "gather the numbers" }, id: "oe2269-fire-delegate" }] },
        { say: "the worker reported back" },
      ],
      child: [{ say: "gathered" }],
    }),
  );

  const sessionIds = await runRoutineDispatchTick();
  expect(sessionIds.length, "the compiled schedule task started no session for this fire").toBe(1);

  const fireFirst = await waitFor(() => handle.requests.find((r) => r.role === "parent"), "the fire's first model call");
  expect(fireFirst.tools, "the fire did not land the unified window — no delegator, so nothing here is measurable").toContain("agent");

  await waitFor(() => handle.requests.find((r) => r.role === "parent" && r.stepIndex === 1), "the fire's dispatch turn to serve its terminal step");
  await waitForChildren(handle, { count: 1, lastStepIndex: 0, label: "the fire's delegated worker's own terminal step" });
  expect(handle.requests.filter((r) => r.fault !== undefined), "a scripted request degraded instead of answering the script").toEqual([]);

  const taskId = taskIdOfDelegation(handle, "the fire's delegation");
  const armed = armSettlement(handle, SETTLEMENT_DRAIN_SCRIPT);
  afterThisTest(() => armed.dispose());

  const held = await waitFor(async () => {
    const rows = await rowsSinceCursor(cursor, [SETTLEMENT_FLUSH_ACTION], { limit: 100 });
    return rows.some((r) => flushView(r).outcome === "skipped" && flushView(r).surfaceKey === SURFACE_KEY) ? rows : undefined;
  }, "a memory.settlement_flush row whose outcome is `skipped` — a turn that ended with the worker live");
  const skipped = held.filter((r) => flushView(r).outcome === "skipped" && flushView(r).surfaceKey === SURFACE_KEY);
  expect(skipped.length, "no held flush on the fire's own surface, so nothing says the guard was closed before the work finished").toBeGreaterThanOrEqual(1);
  for (const row of skipped) {
    expect(
      flushView(row).liveTasks,
      `a held flush (seq ${row.seq}) named no live task, so the fan-out guard was not what held it and ② would not measure completion`,
    ).toBeGreaterThanOrEqual(1);
  }

  await consumeSettlement({
    armed,
    dispatched: handle,
    taskId,
    label: "the fire worker's completion, delivered as a new message naming the task id",
  });

  const settledRows = await waitFor(async () => {
    const rows = await rowsSinceCursor(cursor, [TASK_SETTLED_ACTION], { limit: 100 });
    return rows.some((r) => (r.detail ?? {})["task"] === taskId) ? rows : undefined;
  }, `a ${TASK_SETTLED_ACTION} row naming the fire's own task`);
  expect(settledRows.filter((r) => (r.detail ?? {})["task"] === taskId), "the fire's worker settled more than once").toHaveLength(1);
  expect(armed.requests.filter((r) => r.fault !== undefined), "a straggler reached the settlement script").toEqual([]);

  const flushed = await waitFor(async () => {
    const rows = await rowsSinceCursor(cursor, [SETTLEMENT_FLUSH_ACTION], { limit: 200 });
    return rows.find((r) => flushView(r).outcome === "flushed" && flushView(r).surfaceKey === SURFACE_KEY);
  }, `a memory.settlement_flush row whose outcome is \`flushed\` on ${SURFACE_KEY} — the fire's end effect`);
  const view = flushView(flushed);
  expect(
    view.edge,
    "the flush did not come from the turn-completion backstop — the edge the reshape must not move. " +
      "`task-settled` here means a peek crept back into the settlement script (see the header); " +
      "no row at all means the effect moved onto a session edge that never fires",
  ).toBe("turn-backstop");
  expect(view.liveTasks, "the flush ran while a delegated task was still live, so it did not run on completion").toBe(0);
  expect(view.surfaceKey, "the flush resolved a different surface from the fire's own").toBe(SURFACE_KEY);

  const fires = await waitFor(async () => {
    const rows = await rowsSinceCursor(cursor, [ROUTINE_FIRE_ACTION], { limit: 100 });
    return rows.length > 0 ? rows : undefined;
  }, `a ${ROUTINE_FIRE_ACTION} join row for this fire`);
  expect(fires.filter((r) => (r.detail ?? {})["routineId"] === id), "no routine.fire row names this routine").toHaveLength(1);
  const fireRow = fires.find((r) => (r.detail ?? {})["routineId"] === id)!;
  expect(fireRow.detail?.["sessionId"], "the fold named a session other than the fire's own").toBe(sessionIds[0]);
  expect(fireRow.detail?.["outcome"], "the fire did not settle clean, so this run measured a failure path").toBe("ok");
  const stored = await getRoutine("default", SURFACE_KEY, id);
  expect(stored?.lastOutcome, "the routine row did not record the settled outcome").toBe("ok");

  expect(fireFirst.sessionId, "the fire's turn ran in a session the dispatcher did not start").toBe(sessionIds[0]);
  const res = await controlGet(`/control/v1/session/${encodeURIComponent(sessionIds[0]!)}/transcript`);
  expect(res.status, `the transcript route answered ${res.status}: ${res.body.slice(0, 300)}`).toBe(200);
  const page = JSON.parse(res.body) as { complete: boolean; count: number; events: { type: string }[] };
  expect(page.count, "the transcript page is empty, so the absences below are facts about an unread stream").toBeGreaterThan(0);
  expect(
    page.events.map((e) => e.type),
    "the fire's own stream carries no turn.completed, so this is not the stream whose end effects were measured",
  ).toContain("turn.completed");
  expect(
    page.events.filter((e) => (TERMINAL_SESSION_EVENTS as readonly string[]).includes(e.type)).map((e) => e.type),
    "the fire's session emitted a terminal event — so its end effects may be riding an edge the eve 0.69/0.70 park removes",
  ).toEqual([]);
  expect(page.complete, "the transcript drain reported a COMPLETE stream, so the fire's session ended rather than parking").toBe(false);
  expect(
    await rowsSinceCursor(cursor, [...SUPERVISOR_FAILURE_ACTIONS], { limit: 100 }),
    "the fire's seat recorded a failure, so this run measured a death rather than a park",
  ).toEqual([]);
});
