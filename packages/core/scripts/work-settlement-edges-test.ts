// Drives the REAL delegation-settlement hook handlers (`task.started`, `call.started`, `call.settled`,
// `task.ended`) in a work-session context, on the event shapes eve 1.x emits, and counts the rows a
// settlement writes. Each case says what identifies a job (request, task, call) and proves that the
// job settles exactly once, under its own request.

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { ev, viewOf, type SyntheticEvent } from "./_hook-view.js";
import type { WorkRequestRow } from "../agent/channels/work.js";

process.env.OE_SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "oe-work-settlement-edges-")), "ops.sqlite3");
delete process.env.DATABASE_URL;

const { _setDeploymentIdentityForTest } = await import("../agent/identity/deployment-identity.js");
_setDeploymentIdentityForTest({ workspace: "dev" });
const __slackStubs = await import("./_slack-test-stubs.js");
__slackStubs.registerSlackFixtureCodec();

const hub = await import("../agent/hooks/delegation-settlement.js");
const work = await import("../agent/channels/work.js");
const key = await import("../agent/hooks/work-task-key.js");
const { readAudit } = await import("../agent/audit/audit.js");
const { deploymentOrg } = await import("../agent/identity/binding.js");
const { getOperationalStore } = await import("../agent/operational/provider.js");
const { formatWindowToken, workWindowId } = await import("../agent/channels/window-key.js");
const { isWorkSessionContext } = await import("../agent/access/work-session.js");
const { WORK_STATUS_ACTION, workStatusKey } = await import("../agent/hooks/work-status.js");

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};
const eq = (a: unknown, b: unknown, label: string): void => {
  assert.deepStrictEqual(a, b, label);
  n++;
};

const require = createRequire(import.meta.url);
const eveDist = dirname(require.resolve("eve/package.json"));
const { ContextContainer, contextStorage } = (await import(pathToFileURL(join(eveDist, "dist/src/context/container.js")).href)) as {
  ContextContainer: new () => unknown;
  contextStorage: { run<T>(store: unknown, fn: () => T): T };
};

type Handler = (event: unknown, ctx: unknown) => Promise<void> | void;
const handlers = (hub.default as unknown as { events: Record<string, Handler> }).events;
for (const edge of ["task.started", "call.started", "call.settled", "task.ended"]) {
  ok(typeof handlers[edge] === "function", `precondition: the delegation-settlement hook binds \`${edge}\``);
}

const ORG = deploymentOrg();
const store = getOperationalStore();
const SEAT_WINDOW = formatWindowToken({ domain: "payments", windowId: "slack_T1_C1", generation: 1 });
const WORK_WINDOW = formatWindowToken({ domain: "payments", windowId: workWindowId("slack_T1_C1"), generation: 1 });
const ORIGIN = { platform: "slack", channelId: "C1", threadTs: "100.1" } as const;
const binding = { org: ORG, platform: "slack", workspace: "T1", surface: "C1", mode: "channel", visibility: "private", trust: "internal", principalId: "U_A", target: { channelId: "C1" } };
const TURN = "w-turn";

function requestRow(requestId: string): WorkRequestRow {
  return {
    requestId,
    seatToken: SEAT_WINDOW,
    wakeId: `wake-${requestId}`,
    origin: ORIGIN,
    surfaceKey: "slack/T1/C1",
    binding: binding as never,
    requester: { kind: "requester", principalId: "U_A" },
    nonMemberWake: false,
    atIso: new Date().toISOString(),
  };
}

function workCtx(session: string, stamp: string | undefined, view: unknown, line: number | undefined, index = 0): unknown {
  return {
    agent: { name: "test" },
    channel: { kind: "slack", continuationToken: `unified:${WORK_WINDOW}` },
    session: {
      id: session,
      turn: { id: TURN, sequence: 1 },
      auth: { current: { principalId: "U_A", principalType: "slack-user", attributes: { oe_window_token: WORK_WINDOW, ...(stamp !== undefined ? { [work.OE_WORK_REQUEST_ATTR]: stamp } : {}) } } },
    },
    view,
    ...(line !== undefined ? { position: { line, index } } : {}),
  };
}

const inSession = <T>(fn: () => Promise<T>): Promise<T> => contextStorage.run(new ContextContainer(), fn);

ok(isWorkSessionContext(workCtx("w-pre", "req", undefined, 1) as never), "precondition: the fixture context is a work session, read through the predicate the hook uses");

interface CallSpec {
  readonly callId: string;
  readonly runId: string;
  readonly opens?: boolean;
}

function startEvents(taskId: string, calls: readonly CallSpec[]): SyntheticEvent[] {
  const out: SyntheticEvent[] = [ev("session.started", {}), ev("turn.started", { turnId: TURN, cause: { policy: "test" }, follows: null }, { turnId: TURN })];
  for (const c of calls) {
    out.push(ev("model.requested", { runId: c.runId, owner: { turnId: TURN } }, { turnId: TURN, runId: c.runId }));
    out.push(ev("call.requested", { callId: c.callId, owner: { runId: c.runId }, capability: { kind: "agent", name: "agent" }, input: { message: `brief ${c.callId}` } }, { turnId: TURN, runId: c.runId }));
    if (c.opens === true) out.push(ev("task.started", { taskId, kind: "agent", name: "agent", startedBy: { callId: c.callId } }, { turnId: TURN }));
    out.push(ev("call.started", { callId: c.callId, taskId }, { turnId: TURN }));
  }
  return out;
}

async function bindCall(session: string, callId: string, requestId: string): Promise<void> {
  await work.rememberWorkRequest(store, ORG, requestRow(requestId));
  await work.rememberWorkCall(store, ORG, session, callId, requestId, new Date().toISOString());
}

async function taskStarted(session: string, taskId: string, callId: string, stamp: string, view: unknown): Promise<void> {
  await inSession(async () => {
    await handlers["task.started"]!({ type: "task.started", data: { taskId, kind: "agent", name: "agent", startedBy: { callId } }, scope: { turnId: TURN } }, workCtx(session, stamp, view, 1));
  });
}

async function callStarted(session: string, taskId: string, callId: string, stamp: string, view: unknown): Promise<void> {
  await inSession(async () => {
    await handlers["call.started"]!({ type: "call.started", data: { callId, taskId }, scope: { turnId: TURN } }, workCtx(session, stamp, view, 2));
  });
}

async function callSettled(session: string, data: Record<string, unknown>, view: unknown, line: number | undefined, index = 0): Promise<void> {
  await inSession(async () => {
    await handlers["call.settled"]!({ type: "call.settled", data, scope: { turnId: TURN } }, workCtx(session, undefined, view, line, index));
  });
}

async function taskEnded(session: string, taskId: string, outcome: string, view: unknown, line: number | undefined): Promise<void> {
  await inSession(async () => {
    await handlers["task.ended"]!({ type: "task.ended", data: { taskId, outcome }, scope: { turnId: TURN } }, workCtx(session, undefined, view, line));
  });
}

const settleAudits = (): Promise<void> => new Promise((r) => setTimeout(r, 60));

interface Tally {
  readonly posts: Record<string, number>;
  readonly withheld: Record<string, number>;
  readonly taskSettled: number;
  readonly statusSettled: Record<string, number>;
}

async function tally(taskId: string): Promise<Tally> {
  await settleAudits();
  const posts: Record<string, number> = {};
  const withheld: Record<string, number> = {};
  for (const r of await readAudit({ org: ORG, action: work.WORK_RESULT_WAKE_ACTION })) {
    const d = (r.detail ?? {}) as Record<string, unknown>;
    if (d.taskId !== taskId) continue;
    const req = String(d.requestId);
    if (d.outcome === "withheld") withheld[req] = (withheld[req] ?? 0) + 1;
    else if (d.outcome !== "replay-skipped" && d.outcome !== "skipped") posts[req] = (posts[req] ?? 0) + 1;
  }
  const taskSettled = (await readAudit({ org: ORG, action: hub.TASK_SETTLED_ACTION })).filter((r) => (r.detail as Record<string, unknown> | undefined)?.task === taskId).length;
  const statusSettled: Record<string, number> = {};
  for (const r of await readAudit({ org: ORG, action: WORK_STATUS_ACTION })) {
    const d = (r.detail ?? {}) as Record<string, unknown>;
    if (d.taskId !== taskId || d.state === "working") continue;
    const req = String(d.requestId);
    statusSettled[req] = (statusSettled[req] ?? 0) + 1;
  }
  return { posts, withheld, taskSettled, statusSettled };
}

console.log("§0 the reply key is the commit's line:");
{
  eq(hub.settlementReplyKey({ line: 7 }), "L7", "a hook event's position names its reply by the line");
  eq(hub.settlementReplyKey(undefined), undefined, "NEGATIVE CONTROL: no position, no reply key (the edge then runs unguarded)");
}

console.log("§1 one reply that settles two calls of ONE job settles that job once (OPE-2777 gap 1):");
{
  const W = "w-sess-1";
  const T = "agent-one-job";
  await bindCall(W, "c1", "req-1");
  await bindCall(W, "c2", "req-1");
  const started = viewOf(startEvents(T, [{ callId: "c1", runId: "r1", opens: true }, { callId: "c2", runId: "r2" }]));
  await taskStarted(W, T, "c1", "req-1", started);
  await callStarted(W, T, "c2", "req-1", started);
  const settled = viewOf([
    ...startEvents(T, [{ callId: "c1", runId: "r1", opens: true }, { callId: "c2", runId: "r2" }]),
    ev("call.settled", { callId: "c1", outcome: "completed", output: "the answer" }, { turnId: TURN }),
    ev("call.settled", { callId: "c2", outcome: "completed", outputOf: { callId: "c1" } }, { turnId: TURN }),
  ]);
  await callSettled(W, { callId: "c1", outcome: "completed", output: "the answer" }, settled, 40, 0);
  await callSettled(W, { callId: "c2", outcome: "completed", outputOf: { callId: "c1" } }, settled, 40, 1);
  const t = await tally(T);
  eq(t.posts, { "req-1": 1 }, "🔴 the seat gets ONE result wake for the job, not one per call the reply settled");
  eq(t.taskSettled, 1, "🔴 …ONE `delegation.task_settled` row for the reply");
  eq(t.statusSettled, { "req-1": 1 }, "🔴 …and ONE settled `work.status` row");

  await callSettled(W, { callId: "c1", outcome: "completed", output: "the answer" }, settled, 40, 0);
  eq((await tally(T)).posts, { "req-1": 1 }, "a REPLAYED hook event (the same line) posts nothing new");
}
{
  const W = "w-sess-1n";
  const T = "agent-one-job-two-replies";
  await bindCall(W, "c1", "req-1n");
  await bindCall(W, "c2", "req-1n");
  const view = viewOf([
    ...startEvents(T, [{ callId: "c1", runId: "r1", opens: true }, { callId: "c2", runId: "r2" }]),
    ev("call.settled", { callId: "c1", outcome: "failed", error: { message: "first reply" } }, { turnId: TURN }),
    ev("call.settled", { callId: "c2", outcome: "failed", error: { message: "second reply" } }, { turnId: TURN }),
  ]);
  await taskStarted(W, T, "c1", "req-1n", view);
  await callStarted(W, T, "c2", "req-1n", view);
  await callSettled(W, { callId: "c1", outcome: "failed", error: { message: "first reply" } }, view, 50);
  await callSettled(W, { callId: "c2", outcome: "failed", error: { message: "second reply" } }, view, 51);
  const t = await tally(T);
  eq(t.posts, { "req-1n": 2 }, "NEGATIVE CONTROL: two replies (two lines) are two settlements — the guard is per reply, not a blanket mute");
  eq(t.taskSettled, 2, "NEGATIVE CONTROL: …and two `delegation.task_settled` rows");
}

console.log("§2 one reply that settles calls of TWO jobs settles each job once, under its own request (OPE-2777 gap 1):");
{
  const W = "w-sess-2";
  const T = "agent-two-jobs";
  await bindCall(W, "c1", "req-2a");
  await bindCall(W, "c2", "req-2b");
  const started = viewOf(startEvents(T, [{ callId: "c1", runId: "r1", opens: true }, { callId: "c2", runId: "r2" }]));
  await taskStarted(W, T, "c1", "req-2a", started);
  await callStarted(W, T, "c2", "req-2b", started);
  eq(await work.readWorkTaskRequest(store, ORG, T), "req-2b", "precondition: the task-wide row names only the LATEST job (the continuation's)");
  eq(await key.readWorkTaskKey(store, ORG, T, "c1"), { requestId: "req-2a", verdict: "keyed" }, "🔴 `call.started` keys the continuation under its own call, and the opening call keeps its own key");
  eq(await key.readWorkTaskKey(store, ORG, T, "c2"), { requestId: "req-2b", verdict: "keyed" }, "…and the continuation is keyed to its own job");
  const settled = viewOf([
    ...startEvents(T, [{ callId: "c1", runId: "r1", opens: true }, { callId: "c2", runId: "r2" }]),
    ev("call.settled", { callId: "c1", outcome: "completed", output: "both answered" }, { turnId: TURN }),
    ev("call.settled", { callId: "c2", outcome: "completed", outputOf: { callId: "c1" } }, { turnId: TURN }),
  ]);
  await callSettled(W, { callId: "c1", outcome: "completed", output: "both answered" }, settled, 60, 0);
  await callSettled(W, { callId: "c2", outcome: "completed", outputOf: { callId: "c1" } }, settled, 60, 1);
  const t = await tally(T);
  eq(t.posts, { "req-2a": 1, "req-2b": 1 }, "🔴 each job's seat gets ONE result wake — the opening job is not lost when the continuation re-points the task");
  eq(t.withheld, {}, "🔴 …and neither is withheld as keyed to another job");
  eq(t.taskSettled, 1, "🔴 …while the task-level bookkeeping runs once for the reply");
  eq(t.statusSettled, { "req-2a": 1, "req-2b": 1 }, "🔴 …and each job gets one settled `work.status` row (its ✋ comes off)");
}

console.log("§3 the `task.ended` fallback settles a continuation that is still open (OPE-2777 gap 2):");
{
  const W = "w-sess-3";
  const T = "agent-continued";
  await bindCall(W, "c1", "req-3a");
  await bindCall(W, "c2", "req-3b");
  const started = viewOf(startEvents(T, [{ callId: "c1", runId: "r1", opens: true }, { callId: "c2", runId: "r2" }]));
  await taskStarted(W, T, "c1", "req-3a", started);
  await callStarted(W, T, "c2", "req-3b", started);
  const firstReply = viewOf([...startEvents(T, [{ callId: "c1", runId: "r1", opens: true }]), ev("call.settled", { callId: "c1", outcome: "completed", output: "first" }, { turnId: TURN })]);
  await callSettled(W, { callId: "c1", outcome: "completed", output: "first" }, firstReply, 70);
  const ended = viewOf([
    ...startEvents(T, [{ callId: "c1", runId: "r1", opens: true }]),
    ev("call.settled", { callId: "c1", outcome: "completed", output: "first" }, { turnId: TURN }),
    ...startEvents(T, [{ callId: "c2", runId: "r2" }]).slice(2),
  ]);
  await taskEnded(W, T, "failed", ended, 80);
  const t = await tally(T);
  eq(t.posts, { "req-3a": 1, "req-3b": 1 }, "🔴 the continuation's job settles at `task.ended` — the opening call's settlement no longer makes the fallback skip");
  eq(t.statusSettled, { "req-3a": 1, "req-3b": 1 }, "🔴 …and its ✋ comes off");
  eq(hub.openTaskCalls(ended, T, "c1"), ["c2"], "…because the view shows the opening call settled and the continuation open");

  const allSettled = viewOf([
    ...startEvents(T, [{ callId: "c1", runId: "r1", opens: true }, { callId: "c2", runId: "r2" }]),
    ev("call.settled", { callId: "c1", outcome: "completed", output: "first" }, { turnId: TURN }),
    ev("call.settled", { callId: "c2", outcome: "failed", error: { message: "x" } }, { turnId: TURN }),
  ]);
  eq(hub.openTaskCalls(allSettled, T, "c1"), [], "NEGATIVE CONTROL: with every call settled, no call is open");
  await taskEnded(W, T, "failed", allSettled, 90);
  eq((await tally(T)).posts, { "req-3a": 1, "req-3b": 1 }, "NEGATIVE CONTROL: …so a later `task.ended` settles nothing again");
}

console.log("§4 eve's own commit shape: `call.settled` and `task.ended` on one line settle the job once:");
{
  const W = "w-sess-4";
  const T = "agent-ended-with-call";
  await bindCall(W, "c1", "req-4");
  const open = viewOf(startEvents(T, [{ callId: "c1", runId: "r1", opens: true }]));
  await taskStarted(W, T, "c1", "req-4", open);
  // eve publishes each event with the view folded through its whole line, so on a live host the
  // `task.ended` hook sees the call settled and `openTaskCalls` finds none. This case hands the hook
  // a view that still shows the call open, to prove the second defence: the line key ties the two
  // edges to one reply, so even then the job settles once.
  await callSettled(W, { callId: "c1", outcome: "interrupted", reason: "task-cancelled" }, open, 100, 0);
  await taskEnded(W, T, "cancelled", open, 100);
  const t = await tally(T);
  eq(t.posts, { "req-4": 1 }, "🔴 a cancel that settles the call and ends the task in one commit wakes the seat once");
  eq(t.taskSettled, 1, "🔴 …and writes one `delegation.task_settled` row");
}

console.log("§5 a call `task.started` keys off the step stamp gets its own join row:");
{
  const W = "w-sess-5";
  const T = "agent-stamp-only";
  await work.rememberWorkRequest(store, ORG, requestRow("req-5"));
  const view = viewOf(startEvents(T, [{ callId: "c1", runId: "r1", opens: true }]));
  await taskStarted(W, T, "c1", "req-5", view);
  eq(await work.readWorkCall(store, ORG, W, "c1"), "req-5", "🔴 the call is joined to the stamped job, so its settlement reads its own job, not the task-wide row");
  await callSettled(W, { callId: "c1", outcome: "completed", output: "done" }, viewOf([...startEvents(T, [{ callId: "c1", runId: "r1", opens: true }]), ev("call.settled", { callId: "c1", outcome: "completed", output: "done" }, { turnId: TURN })]), 110);
  eq((await tally(T)).posts, { "req-5": 1 }, "…and the job settles once");
}

console.log("§6 a status write that fails releases the job's settlement, and a replay settles it once:");
{
  const W = "w-sess-6";
  const T = "agent-status-retry";
  await bindCall(W, "c1", "req-6");
  const open = viewOf(startEvents(T, [{ callId: "c1", runId: "r1", opens: true }]));
  await taskStarted(W, T, "c1", "req-6", open);
  const settledView = viewOf([...startEvents(T, [{ callId: "c1", runId: "r1", opens: true }]), ev("call.settled", { callId: "c1", outcome: "completed", output: "done" }, { turnId: TURN })]);
  const live = store as unknown as { putTaskResult: (...a: unknown[]) => Promise<unknown> };
  const put = live.putTaskResult;
  let failed = 0;
  live.putTaskResult = async function (this: unknown, ...a: unknown[]) {
    if (failed === 0 && a[1] === workStatusKey("req-6")) {
      failed++;
      throw new Error("the status write failed");
    }
    return await put.apply(this, a);
  };
  await callSettled(W, { callId: "c1", outcome: "completed", output: "done" }, settledView, 120);
  live.putTaskResult = put;
  const first = await tally(T);
  eq(failed, 1, "precondition: the first settled status write failed");
  eq([first.posts, first.statusSettled], [{ "req-6": 1 }, {}], "the result wake posted once, and no settled status row was written");
  await callSettled(W, { callId: "c1", outcome: "completed", output: "done" }, settledView, 120);
  const second = await tally(T);
  eq(second.statusSettled, { "req-6": 1 }, "🔴 a replay of the same event writes the settled status row (its ✋ comes off): the failed write released the job's settlement");
  eq(second.posts, { "req-6": 1 }, "🔴 …and posts no second result wake");
}

console.log("§7 one call's failure at `task.ended` does not leave the task's other open calls unsettled:");
{
  const W = "w-sess-7";
  const T = "agent-two-open";
  await bindCall(W, "c1", "req-7a");
  await bindCall(W, "c2", "req-7b");
  const open = viewOf(startEvents(T, [{ callId: "c1", runId: "r1", opens: true }, { callId: "c2", runId: "r2" }]));
  await taskStarted(W, T, "c1", "req-7a", open);
  await callStarted(W, T, "c2", "req-7b", open);
  const live = store as unknown as { getTaskResult: (...a: unknown[]) => Promise<unknown> };
  const get = live.getTaskResult;
  live.getTaskResult = async function (this: unknown, ...a: unknown[]) {
    if (a[1] === work.workRequestKey("req-7a")) throw new Error("the store read failed");
    return await get.apply(this, a);
  };
  try {
    await taskEnded(W, T, "failed", open, 130);
  } finally {
    live.getTaskResult = get;
  }
  eq((await tally(T)).posts, { "req-7b": 1 }, "🔴 the first open call's job fails to settle, and the second open call's job still settles");
}

console.log("§8 a re-run that the start claim skips re-arms the job's start in the turn state:");
{
  // The dead attempt's turn-state writes die with it, so the re-run reads the turn from a fresh session
  // state that holds the delivered job but not its start. The claim skips the start edge, and the edge
  // re-arms the start from the call's work join. The first run writes the start once (the control).
  const { recordWorkRequestsThisTurn, workRequestStarted } = await import("../agent/access/work-request-turn.js");
  const W = "w-sess-8";
  const T = "agent-start-rerun";
  const REQ = "req-8";
  await bindCall(W, "c1", REQ);
  const deliver = (): void => recordWorkRequestsThisTurn(TURN, work.renderWorkRequest({ requestId: REQ, brief: "brief c1", origin: ORIGIN, nowIso: "2026-01-01T00:00:00.000Z" }));
  const view = viewOf(startEvents(T, [{ callId: "c1", runId: "r1", opens: true }]));
  // `work.task_keyed` is a durable write that every run of the start edge makes, also for the opening
  // call (where `noteTaskStarted` already writes no second start row). One row proves one edge run.
  const keyedRows = async (): Promise<number> => {
    await new Promise((r) => setTimeout(r, 20));
    return (await readAudit({ org: ORG, action: key.WORK_TASK_KEYED_ACTION })).filter((r) => (r.detail as { taskId?: unknown } | undefined)?.taskId === T).length;
  };
  const started = (): Promise<{ before: boolean; after: boolean }> =>
    inSession(async () => {
      deliver();
      const before = workRequestStarted(TURN, REQ);
      await handlers["task.started"]!({ type: "task.started", data: { taskId: T, kind: "agent", name: "agent", startedBy: { callId: "c1" } }, scope: { turnId: TURN } }, workCtx(W, REQ, view, 1));
      return { before, after: workRequestStarted(TURN, REQ) };
    });
  const first = await started();
  eq(first, { before: false, after: true }, "control: the first run notes the job's start in the turn state");
  eq(await keyedRows(), 1, "control: the first run keys the task once");
  const rerun = await started();
  ok(!rerun.before, "setup: the re-run's session state holds no trace of the first run's start");
  ok(rerun.after, "🔴 the re-run notes the job's start again, so the turn's settlement reads the job as started");
  eq(await keyedRows(), 1, "🔴 …and the claim still holds the durable edge: the re-run keys the task no second time");
}

console.log("§8b a first run that dies before the job's key row loses no job (OPE-2819):");
{
  // The first run dies after the claim, at the write of the call's key row: a store write that never
  // returns, as a dead process stops. The re-run that the claim skips writes the key row and the job's
  // start status, so the settlement posts the job's result instead of withholding it as unkeyed.
  const { readWorkJobStatus } = await import("../agent/hooks/work-status.js");
  const W = "w-sess-8b";
  const T = "agent-start-died";
  const REQ = "req-8b";
  await bindCall(W, "c1", REQ);
  const view = viewOf(startEvents(T, [{ callId: "c1", runId: "r1", opens: true }]));
  const keyedRows = async (): Promise<number> => {
    await new Promise((r) => setTimeout(r, 20));
    return (await readAudit({ org: ORG, action: key.WORK_TASK_KEYED_ACTION })).filter((r) => (r.detail as { taskId?: unknown } | undefined)?.taskId === T).length;
  };
  const live = store as unknown as { putTaskResult: (...a: unknown[]) => Promise<unknown> };
  const put = live.putTaskResult;
  let killed = false;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("the first run never reached the kill point")), 5000);
    const died = (): void => {
      clearTimeout(timer);
      resolve();
    };
    live.putTaskResult = function (this: unknown, ...a: unknown[]) {
      if (!killed && a[1] === key.workTaskKeyKey(T, "c1")) {
        killed = true;
        died();
        return new Promise<never>(() => undefined);
      }
      return put.apply(this, a);
    };
    void taskStarted(W, T, "c1", REQ, view);
  });
  live.putTaskResult = put;
  ok(killed, "setup: the first run passed the claim and died at the key row's write");
  eq(await key.readWorkTaskKey(store, ORG, T, "c1"), undefined, "setup: the dead first run left no key row");
  eq(await readWorkJobStatus(store, ORG, REQ), undefined, "setup: …and no start status");
  await taskStarted(W, T, "c1", REQ, view);
  eq((await key.readWorkTaskKey(store, ORG, T, "c1"))?.requestId, REQ, "🔴 the re-run writes the call's key row for its job");
  eq((await readWorkJobStatus(store, ORG, REQ))?.state, "working", "🔴 …and the job's start status");
  eq(await keyedRows(), 1, "…once: the re-run keys the task once");
  await taskStarted(W, T, "c1", REQ, view);
  eq(await keyedRows(), 1, "🔴 a second re-run keys the task no second time");
  const settled = viewOf([...startEvents(T, [{ callId: "c1", runId: "r1", opens: true }]), ev("call.settled", { callId: "c1", outcome: "completed", output: "done" }, { turnId: TURN })]);
  await callSettled(W, { callId: "c1", outcome: "completed", output: "done" }, settled, 140);
  const t = await tally(T);
  eq([t.posts, t.withheld], [{ [REQ]: 1 }, {}], "🔴 the settlement posts the job's result once and withholds nothing");
}

/** Runs `first` until its first store write that `hits` matches, and abandons it there, as a dead process stops. */
async function killAtPut(hits: (key: string) => boolean, first: () => Promise<void>): Promise<void> {
  const live = store as unknown as { putTaskResult: (...a: unknown[]) => Promise<unknown> };
  const put = live.putTaskResult;
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("the first run never reached the kill point")), 5000);
      live.putTaskResult = function (this: unknown, ...a: unknown[]) {
        if (typeof a[1] === "string" && hits(a[1])) {
          live.putTaskResult = put;
          clearTimeout(timer);
          resolve();
          return new Promise<never>(() => undefined);
        }
        return put.apply(this, a);
      };
      void first();
    });
  } finally {
    live.putTaskResult = put;
  }
}

console.log("§8c a work continuation that dies before the task row names the continuing job on the re-run:");
{
  const W = "w-sess-8c";
  const T = "agent-cont-died";
  await bindCall(W, "c1", "req-8c-a");
  await new Promise((r) => setTimeout(r, 5));
  await bindCall(W, "c2", "req-8c-b");
  const view = viewOf(startEvents(T, [{ callId: "c1", runId: "r1", opens: true }, { callId: "c2", runId: "r2" }]));
  await taskStarted(W, T, "c1", "req-8c-a", view);
  eq(await work.readWorkTaskRequest(store, ORG, T), "req-8c-a", "setup: the opening job names the task row");
  await killAtPut((k) => k === work.workTaskKey(T), () => callStarted(W, T, "c2", "req-8c-b", view));
  eq(await work.readWorkTaskRequest(store, ORG, T), "req-8c-a", "setup: the continuation died before it wrote the task row");
  await callStarted(W, T, "c2", "req-8c-b", view);
  eq(await work.readWorkTaskRequest(store, ORG, T), "req-8c-b", "🔴 the re-run makes the task row name the continuing job, so a cancel by task reaches the live job");

  // Control: a NEWER job already wrote the task row. The re-run of the older continuation leaves it.
  const T2 = "agent-cont-newer";
  await bindCall(W, "c3", "req-8c-c");
  await new Promise((r) => setTimeout(r, 5));
  await bindCall(W, "c4", "req-8c-d");
  await new Promise((r) => setTimeout(r, 5));
  await bindCall(W, "c5", "req-8c-e");
  const view2 = viewOf(startEvents(T2, [{ callId: "c3", runId: "r1", opens: true }, { callId: "c4", runId: "r2" }]));
  await taskStarted(W, T2, "c3", "req-8c-c", view2);
  await killAtPut((k) => k === work.workTaskKey(T2), () => callStarted(W, T2, "c4", "req-8c-d", view2));
  await work.rememberWorkTask(store, ORG, T2, "req-8c-e", new Date().toISOString());
  await callStarted(W, T2, "c4", "req-8c-d", view2);
  eq(await work.readWorkTaskRequest(store, ORG, T2), "req-8c-e", "🔴 control: the re-run never writes the task row over a newer job");
}

console.log("§8d a first run that dies between the job's status row and its stop hand gets the hand on the re-run:");
{
  const { readWorkJobStatus, readAnchoredWorkJobs, workHandKey } = await import("../agent/hooks/work-status.js");
  const W = "w-sess-8d";
  const T = "agent-hand-died";
  const REQ = "req-8d";
  await bindCall(W, "c1", REQ);
  const view = viewOf(startEvents(T, [{ callId: "c1", runId: "r1", opens: true }]));
  // The hand write sits under an in-process anchor lock. A promise that never settles would hold that lock
  // for the re-run too, which a dead process does not do. So the write fails instead: it leaves the same
  // durable state as a death between the two writes (the status row, and no hand row).
  const live = store as unknown as { putTaskResult: (...a: unknown[]) => Promise<unknown> };
  const put = live.putTaskResult;
  let failed = 0;
  live.putTaskResult = async function (this: unknown, ...a: unknown[]) {
    if (typeof a[1] === "string" && a[1].startsWith(workHandKey(""))) {
      failed++;
      throw new Error("the store write failed");
    }
    return await put.apply(this, a);
  };
  try {
    await taskStarted(W, T, "c1", REQ, view);
  } finally {
    live.putTaskResult = put;
  }
  eq(failed, 1, "setup: the first run's hand write failed");
  const status = await readWorkJobStatus(store, ORG, REQ);
  ok(status?.state === "working" && status.anchorKey !== undefined, "setup: the first run wrote the job's working status with its anchor");
  const anchor = status!.anchorKey!;
  ok(!(await readAnchoredWorkJobs(store, ORG, anchor)).some((j) => j.requestId === REQ), "setup: …and died before it added the job to the anchor's jobs");
  await taskStarted(W, T, "c1", REQ, view);
  ok((await readAnchoredWorkJobs(store, ORG, anchor)).some((j) => j.requestId === REQ && j.taskId === T), "🔴 the re-run adds the job to the anchor's jobs, so a cancel at the anchor reaches it");
  const statusRows = async (): Promise<number> => {
    await new Promise((r) => setTimeout(r, 20));
    return (await readAudit({ org: ORG, action: WORK_STATUS_ACTION })).filter((r) => (r.detail as { requestId?: unknown } | undefined)?.requestId === REQ).length;
  };
  const rows = await statusRows();
  await taskStarted(W, T, "c1", REQ, view);
  eq(await statusRows(), rows, "🔴 a second re-run starts the job no second time");
}

console.log(`work-settlement-edges: ${n} assertions passed`);
process.exit(0);
