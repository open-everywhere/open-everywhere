import { randomBytes } from "node:crypto";
import { expect, test } from "vitest";
import { NO_REPLY_SENTINEL } from "@open-everywhere/core/agent/channels/normalized-wake.js";
import {
  auditCursor,
  bootAgent,
  controlGet,
  DISCORD_GUILD_ID,
  disposeLater,
  registerScript,
  rowsSinceCursor,
  runRoutineDispatchTick,
  waitFor,
  waitForChildren,
  type AuditRow,
} from "../harness";

const SETTLEMENT_FLUSH_ACTION = "memory.settlement_flush";
const ROUTINE_FIRE_ACTION = "routine.fire";
const TASK_SETTLED_ACTION = "delegation.task_settled";
const TERMINAL_SESSION_EVENTS = ["session.ended"] as const;
const SUPERVISOR_FAILURE_ACTIONS = ["unified.supervisor_session_failed", "unified.supervisor_turn_failed"] as const;

const FIRE_SEAT_CHANNEL_ID = "1300000001500000014";
const SURFACE_KEY = `discord/${DISCORD_GUILD_ID}/${FIRE_SEAT_CHANNEL_ID}`;

function flushView(row: AuditRow): { edge: unknown; outcome: unknown; liveTasks: unknown; surfaceKey: unknown } {
  const detail = (row.detail ?? {}) as Record<string, unknown>;
  return { edge: detail.edge, outcome: detail.outcome, liveTasks: detail.liveTasks, surfaceKey: detail.surfaceKey };
}

test("a routine fire's memory flush and settlement row land when its job completes, with the work session still parked", async () => {
  await bootAgent({ sharedSqlite: true });
  const cursor = await auditCursor();

  const { addRoutine, getRoutine } = await import("@open-everywhere/core/agent/routines/store.js");
  const id = `r-it-2269-${randomBytes(4).toString("hex")}`;
  const dueAt = new Date(Date.now() - 60_000).toISOString();
  const scope = {
    org: "default",
    platform: "discord",
    workspace: DISCORD_GUILD_ID,
    surface: FIRE_SEAT_CHANNEL_ID,
    workspaceKey: `discord/${DISCORD_GUILD_ID}`,
    surfaceKey: SURFACE_KEY,
    domainKey: SURFACE_KEY,
    key: SURFACE_KEY,
  };
  await addRoutine(scope, {
    id,
    org: "default",
    surfaceKey: SURFACE_KEY,
    target: { channelId: FIRE_SEAT_CHANNEL_ID, guildId: DISCORD_GUILD_ID, channelType: "0" },
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
      parent: [{ say: NO_REPLY_SENTINEL }],
      child: [{ say: "gathered" }],
    }),
  );

  await runRoutineDispatchTick();

  const forwarded = await waitFor(
    async () => (await rowsSinceCursor(cursor, ["work.forwarded"], { limit: 100 })).find((r) => (r.detail ?? {})["routineId"] === id),
    "the fire's work.forwarded row",
  );
  const keyed = await waitFor(
    async () => (await rowsSinceCursor(cursor, ["work.task_keyed"], { limit: 100 })).find((r) => (r.detail ?? {})["requestId"] === (forwarded.detail ?? {})["requestId"]),
    "the fire's work.task_keyed row",
  );
  const taskId = String((keyed.detail ?? {})["taskId"]);
  const workSessionId = String((keyed.detail ?? {})["workSession"]);
  await waitForChildren(handle, { count: 1, lastStepIndex: 0, label: "the fire's worker's own terminal step" });
  expect(handle.requests.filter((r) => r.fault !== undefined), "a scripted request degraded instead of answering the script").toEqual([]);

  const settledRows = await waitFor(async () => {
    const rows = await rowsSinceCursor(cursor, [TASK_SETTLED_ACTION], { limit: 100 });
    return rows.some((r) => (r.detail ?? {})["task"] === taskId) ? rows : undefined;
  }, `a ${TASK_SETTLED_ACTION} row naming the fire's own task`);
  const mySettled = settledRows.filter((r) => (r.detail ?? {})["task"] === taskId);
  expect(mySettled, "the fire's worker settled more than once").toHaveLength(1);
  const settledSeq = mySettled[0]!.seq;

  const flushed = await waitFor(async () => {
    const rows = await rowsSinceCursor(cursor, [SETTLEMENT_FLUSH_ACTION], { limit: 200 });
    return rows.find((r) => flushView(r).outcome === "flushed" && flushView(r).surfaceKey === SURFACE_KEY && r.seq > settledSeq);
  }, `a memory.settlement_flush row whose outcome is \`flushed\` on ${SURFACE_KEY} — the fire's end effect`);
  const view = flushView(flushed);
  expect(["task-settled", "turn-backstop"], "the flush did not come from the job's completion — a session edge never fires").toContain(view.edge);
  expect(view.liveTasks, "the flush ran while a task was still live, so it did not run on completion").toBe(0);
  const allFlushes = await rowsSinceCursor(cursor, [SETTLEMENT_FLUSH_ACTION], { limit: 200 });
  expect(
    allFlushes.filter((r) => flushView(r).surfaceKey === SURFACE_KEY && r.seq < settledSeq).map(flushView),
    "a flush attempt ran on the fire's surface before its worker settled",
  ).toEqual([]);

  const fires = await waitFor(async () => {
    const rows = await rowsSinceCursor(cursor, [ROUTINE_FIRE_ACTION], { limit: 100 });
    return rows.some((r) => (r.detail ?? {})["routineId"] === id) ? rows : undefined;
  }, `a ${ROUTINE_FIRE_ACTION} join row for this fire`);
  expect(fires.filter((r) => (r.detail ?? {})["routineId"] === id), "no routine.fire row names this routine").toHaveLength(1);
  const fireRow = fires.find((r) => (r.detail ?? {})["routineId"] === id)!;
  expect(fireRow.detail?.["sessionId"], "the fold named a session other than the work session").toBe(workSessionId);
  expect(fireRow.detail?.["outcome"], "the fire did not settle clean, so this run measured a failure path").toBe("ok");
  const stored = await getRoutine("default", SURFACE_KEY, id);
  expect(stored?.lastOutcome, "the routine row did not record the settled outcome").toBe("ok");

  const res = await controlGet(`/control/v1/session/${encodeURIComponent(workSessionId)}/transcript`);
  expect(res.status, `the transcript route answered ${res.status}: ${res.body.slice(0, 300)}`).toBe(200);
  const page = JSON.parse(res.body) as { complete: boolean; count: number; events: { type: string }[] };
  expect(page.count, "the transcript page is empty, so the absences below are facts about an unread stream").toBeGreaterThan(0);
  const types = page.events.map((e) => e.type);
  expect(types, "the work session's stream carries no task.started, so it is not the stream that ran the job").toContain("task.started");
  expect(types, "the work session's stream carries no call.settled, so the job's call never settled there (eve 1.x settles a task's call and keeps the agent task open)").toContain("call.settled");
  expect(
    page.events.filter((e) => (TERMINAL_SESSION_EVENTS as readonly string[]).includes(e.type)).map((e) => e.type),
    "the work session emitted a terminal event — so the end effects may be riding an edge the park removes",
  ).toEqual([]);
  expect(page.complete, "the transcript drain reported a COMPLETE stream, so the work session ended rather than parking").toBe(false);
  expect(
    await rowsSinceCursor(cursor, [...SUPERVISOR_FAILURE_ACTIONS], { limit: 100 }),
    "a seat recorded a failure, so this run measured a death rather than a park",
  ).toEqual([]);
});
