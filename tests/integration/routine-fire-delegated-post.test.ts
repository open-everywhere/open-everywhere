import { randomBytes } from "node:crypto";
import { expect, test } from "vitest";
import { NO_REPLY_SENTINEL } from "@open-everywhere/core/agent/channels/normalized-wake.js";
import {
  auditCursor,
  bootAgent,
  DISCORD_GUILD_ID,
  disposeLater,
  registerScript,
  rowsSinceCursor,
  runRoutineDispatchTick,
  waitFor,
  waitForChildren,
  WAKE_FROM_ENVELOPE,
  type AuditCursor,
  type AuditRow,
  type ScriptedHandle,
} from "./harness";

const FIRE_SEAT_CHANNEL_ID = "1300000001500000014";
const SURFACE_KEY = `discord/${DISCORD_GUILD_ID}/${FIRE_SEAT_CHANNEL_ID}`;
const TASK_SETTLED_ACTION = "delegation.task_settled";
const ROUTINE_FIRE_ACTION = "routine.fire";
const WORKER_HOLD_MS = 3_000;

function sessionOf(row: AuditRow): unknown {
  return (row.detail ?? {})["sessionId"];
}

function detailOf(row: AuditRow | undefined): Record<string, unknown> {
  return (row?.detail ?? {}) as Record<string, unknown>;
}

async function seedWindowedFire(input: { readonly id: string; readonly silent: boolean }): Promise<void> {
  if (process.env.OE_OPERATIONAL_PROVIDER !== "sqlite") {
    throw new Error("this test needs bootAgent({ sharedSqlite: true }) — PGlite is single-writer.");
  }
  const { addRoutine } = await import("@open-everywhere/core/agent/routines/store.js");
  const dueAt = new Date(Date.now() - 60_000).toISOString();
  await addRoutine(
    {
      org: "default",
      platform: "discord",
      workspace: DISCORD_GUILD_ID,
      surface: FIRE_SEAT_CHANNEL_ID,
      workspaceKey: `discord/${DISCORD_GUILD_ID}`,
      surfaceKey: SURFACE_KEY,
      domainKey: SURFACE_KEY,
      key: SURFACE_KEY,
    },
    {
      id: input.id,
      org: "default",
      surfaceKey: SURFACE_KEY,
      target: { channelId: FIRE_SEAT_CHANNEL_ID, guildId: DISCORD_GUILD_ID, channelType: "0" },
      trigger: { kind: "once", at: dueAt },
      prompt: "gather the numbers and report",
      createdBy: "discord:9000000000000000043",
      status: "active",
      nextRunAt: dueAt,
      createdAt: new Date(Date.now() - 120_000).toISOString(),
      consecutiveFailures: 0,
      ...(input.silent ? { report: { kind: "silent" as const } } : {}),
    },
  );
}

async function driveFire(cursor: AuditCursor, id: string, handle: ScriptedHandle, label: string): Promise<{ taskId: string; workSessionId: string; requestId: string }> {
  await runRoutineDispatchTick();
  const forwarded = await waitFor(
    async () => (await rowsSinceCursor(cursor, ["work.forwarded"], { limit: 100 })).find((r) => detailOf(r).routineId === id),
    `${label}: the fire's work.forwarded row`,
  );
  const requestId = String(detailOf(forwarded).requestId);
  const keyed = await waitFor(
    async () => (await rowsSinceCursor(cursor, ["work.task_keyed"], { limit: 100 })).find((r) => detailOf(r).requestId === requestId),
    `${label}: the fire's work.task_keyed row`,
  );
  expect([detailOf(keyed).verdict, detailOf(keyed).requester], `${label}: the fire's task is not keyed to nobody`).toEqual(["keyed", "oe/unverified"]);
  await waitForChildren(handle, { count: 1, lastStepIndex: 0, label: `${label}: the worker's own terminal step` });
  return { taskId: String(detailOf(keyed).taskId), workSessionId: String(detailOf(keyed).workSession), requestId };
}

test("a routine fire posts exactly once, after its worker settles", async () => {
  await bootAgent({ sharedSqlite: true });
  const cursor = await auditCursor();
  const id = `r-it-2257-${randomBytes(4).toString("hex")}`;

  const handle = disposeLater(
    registerScript({
      parent: [{ calls: [{ tool: "reply", input: { wake: WAKE_FROM_ENVELOPE, text: "the numbers are in: 42", done: true }, id: "ope2257-report" }] }, { say: NO_REPLY_SENTINEL }],
      child: [{ say: "gathered: 42", delayMs: WORKER_HOLD_MS }],
    }),
  );
  await seedWindowedFire({ id, silent: false });
  const { taskId, workSessionId, requestId } = await driveFire(cursor, id, handle, "ordinary fire");

  const fires = await waitFor(async () => {
    const rows = await rowsSinceCursor(cursor, [ROUTINE_FIRE_ACTION], { limit: 100 });
    const mine = rows.filter((r) => detailOf(r).routineId === id);
    return mine.length > 0 ? mine : undefined;
  }, `a ${ROUTINE_FIRE_ACTION} row for this fire`);

  const seatPost = await waitFor(async () => {
    const rows = await rowsSinceCursor(cursor, [TASK_SETTLED_ACTION, "reply.post"], { limit: 200 });
    const settled = rows.filter((r) => r.action === TASK_SETTLED_ACTION && detailOf(r).task === taskId);
    const seat = handle.requests.find((r) => r.role === "parent")?.sessionId;
    const posts = rows.filter((r) => r.action === "reply.post" && seat !== undefined && sessionOf(r) === seat);
    return posts.length > 0 ? { settled, posts } : undefined;
  }, "the seat's reply.post for the fire's result");
  expect(seatPost.settled, "the fire's worker did not settle exactly once").toHaveLength(1);
  expect(seatPost.posts, "the fire did not post exactly once").toHaveLength(1);
  expect(seatPost.posts[0]!.seq, "the fire posted BEFORE its worker settled").toBeGreaterThan(seatPost.settled[0]!.seq);

  expect(fires, "the fire folded more than once").toHaveLength(1);
  expect(detailOf(fires[0]).sessionId, "the fold named a session other than the work session that ran the job").toBe(workSessionId);
  expect(detailOf(fires[0]).outcome).toBe("ok");

  const seatSteps = handle.requests.filter((r) => r.role === "parent");
  expect(new Set(seatSteps.map((r) => r.turnId)).size, "the seat took more than one turn for one fire").toBe(1);
  expect(seatSteps[0]!.messages.some((m) => m.text.includes(`work-result-${taskId}`)), "🔴 the seat's first step is not the fire's result wake — a seat turn ran for the fire itself").toBe(true);
  const wake = await waitFor(async () => (await rowsSinceCursor(cursor, ["work.result_wake"], { limit: 100 })).find((r) => detailOf(r).requestId === requestId), "the fire's work.result_wake row");
  expect([detailOf(wake).outcome, detailOf(wake).fire]).toEqual(["delivered", true]);

  expect(handle.requests.filter((r) => r.fault !== undefined), "a scripted request degraded instead of answering the script").toEqual([]);
});

test("NEGATIVE CONTROL — a SILENT routine fire wakes no seat and posts nothing, and still folds once", async () => {
  await bootAgent({ sharedSqlite: true });
  const cursor = await auditCursor();
  const id = `r-it-2257s-${randomBytes(4).toString("hex")}`;

  const handle = disposeLater(
    registerScript({
      parent: [{ say: "the numbers are in: 42" }],
      child: [{ say: "gathered: 42", delayMs: WORKER_HOLD_MS }],
    }),
  );
  await seedWindowedFire({ id, silent: true });
  const { taskId, workSessionId, requestId } = await driveFire(cursor, id, handle, "silent fire");

  const wake = await waitFor(async () => (await rowsSinceCursor(cursor, ["work.result_wake"], { limit: 100 })).find((r) => detailOf(r).requestId === requestId), "the silent fire's work.result_wake row");
  expect(detailOf(wake).outcome, "the silent fire's result woke a seat").toBe("silent-fire");
  const fires = await waitFor(async () => {
    const rows = await rowsSinceCursor(cursor, [ROUTINE_FIRE_ACTION], { limit: 100 });
    const mine = rows.filter((r) => detailOf(r).routineId === id);
    return mine.length > 0 ? mine : undefined;
  }, `a ${ROUTINE_FIRE_ACTION} row for the silent fire`);
  expect(fires, "the silent fire folded more than once").toHaveLength(1);
  expect(detailOf(fires[0]).sessionId).toBe(workSessionId);

  const rows = await rowsSinceCursor(cursor, [TASK_SETTLED_ACTION, "reply.post"], { limit: 200 });
  expect(rows.filter((r) => r.action === TASK_SETTLED_ACTION && detailOf(r).task === taskId), "the silent fire's worker did not settle exactly once").toHaveLength(1);
  expect(handle.requests.filter((r) => r.role === "parent"), "a seat step was served for a SILENT fire").toEqual([]);
  expect(rows.filter((r) => r.action === "reply.post" && String(r.surface ?? "").includes("it-fire-seat")), "a SILENT fire posted").toEqual([]);
  expect(handle.requests.filter((r) => r.fault !== undefined), "a scripted request degraded instead of answering the script").toEqual([]);
});
