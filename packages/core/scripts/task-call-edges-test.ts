import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ev, viewOf, type SyntheticEvent } from "./_hook-view.js";

process.env.OE_SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "oe-task-call-edges-")), "ops.sqlite3");

const hub = await import("../agent/hooks/delegation-settlement.js");
const tasks = await import("../agent/access/background-tasks.js");

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};
const eq = (actual: unknown, expected: unknown, label: string) => {
  assert.deepStrictEqual(actual, expected, label);
  n++;
};

const TURN = "t1";
const TASK = "agent-ab12cd";

function opening(): SyntheticEvent[] {
  return [
    ev("session.started", {}),
    ev("turn.started", { turnId: TURN, cause: { policy: "test" }, follows: null }, { turnId: TURN }),
    ev("model.requested", { runId: "r1", owner: { turnId: TURN } }, { turnId: TURN, runId: "r1" }),
    ev("call.requested", { callId: "c1", owner: { runId: "r1" }, capability: { kind: "agent", name: "agent" }, input: { message: "do the job" } }, { turnId: TURN, runId: "r1" }),
    ev("task.started", { taskId: TASK, kind: "agent", name: "agent", startedBy: { callId: "c1" } }, { turnId: TURN }),
    ev("call.started", { callId: "c1", taskId: TASK }, { turnId: TURN }),
  ];
}

function continuation(): SyntheticEvent[] {
  return [
    ev("model.requested", { runId: "r2", owner: { turnId: TURN } }, { turnId: TURN, runId: "r2" }),
    ev("call.requested", { callId: "c2", owner: { runId: "r2" }, capability: { kind: "agent", name: "agent" }, input: { message: "and the follow-up" } }, { turnId: TURN, runId: "r2" }),
    ev("call.started", { callId: "c2", taskId: TASK }, { turnId: TURN }),
  ];
}

// eve 1.x settles each call a task serves with `call.settled`, and keeps an agent task open after
// its reply: `endTask` runs only when the task's body ends. So the settled view below holds NO
// `task.ended` — the shape the work session's stream shows when its worker answers.
{
  const view = viewOf([...opening(), ev("call.settled", { callId: "c1", outcome: "completed", output: "the worker's answer" }, { turnId: TURN })]);
  const data = hub.taskCallSettledData({ callId: "c1", outcome: "completed" }, view, TURN);
  eq(
    data,
    { taskId: TASK, callId: "c1", status: "completed", kind: "agent", name: "agent", turnId: TURN },
    "🔴 a settled call that serves a task reads as that task's settlement — the edge eve 1.x emits in place of `task.ended`",
  );
  const settled = tasks.readTaskSettled(data);
  ok(settled !== null && settled.taskId === TASK && settled.callId === "c1" && settled.status === "completed", "…and the settlement parser reads it, so the hook can run the result wake");
  eq(hub.settledCallOutput(view, { output: "the worker's answer" }), "the worker's answer", "the call's own output is the result text");
}

{
  const view = viewOf([...opening(), ev("call.settled", { callId: "c1", outcome: "failed", error: { code: "TASK_FAILED", message: "the worker died" } }, { turnId: TURN })]);
  const settled = tasks.readTaskSettled(hub.taskCallSettledData({ callId: "c1", outcome: "failed", error: { message: "the worker died" } }, view, TURN));
  ok(settled?.status === "failed" && settled.errorText === "the worker died", "a failed call settles its task as failed, with eve's error text");
}

{
  const view = viewOf([...opening(), ev("call.settled", { callId: "c1", outcome: "interrupted", reason: "task-cancelled" }, { turnId: TURN })]);
  const settled = tasks.readTaskSettled(hub.taskCallSettledData({ callId: "c1", outcome: "interrupted", reason: "task-cancelled" }, view, TURN));
  ok(settled?.status === "cancelled" && settled.cancelReason === "task-cancelled", "eve's `interrupted` call outcome is the task's `cancelled` status, with its reason");
}

{
  const view = viewOf([
    ...opening(),
    ev("model.requested", { runId: "r1", owner: { turnId: TURN } }, { turnId: TURN, runId: "r1" }),
    ev("call.requested", { callId: "plain", owner: { runId: "r1" }, capability: { kind: "tool", name: "reply" } }, { turnId: TURN, runId: "r1" }),
    ev("call.started", { callId: "plain" }, { turnId: TURN }),
    ev("call.settled", { callId: "plain", outcome: "completed", output: "ok" }, { turnId: TURN }),
  ]);
  eq(hub.taskCallSettledData({ callId: "plain", outcome: "completed" }, view, TURN), undefined, "NEGATIVE CONTROL — a call that serves no task settles no task");
  eq(hub.taskCallSettledData({ callId: "c1", outcome: "rejected" }, view, TURN), undefined, "NEGATIVE CONTROL — a rejected call is no task settlement");
  eq(hub.taskCallSettledData({ callId: "c1", outcome: "completed" }, undefined, TURN), undefined, "NEGATIVE CONTROL — with no view, the edge reads nothing");
}

// eve 1.x starts a task once. A continuation call on the same task gets only `call.started
// {callId, taskId}`, and no second `task.started`.
{
  const view = viewOf([...opening(), ev("call.settled", { callId: "c1", outcome: "completed", output: "first" }, { turnId: TURN }), ...continuation()]);
  const data = hub.taskContinuedData({ callId: "c2", taskId: TASK }, view, TURN);
  eq(data, { taskId: TASK, callId: "c2", kind: "agent", name: "agent", turnId: TURN }, "🔴 a continuation call's `call.started` reads as a start of the open task under the new call");
  const started = tasks.readTaskStarted(data);
  ok(started !== null && started.callId === "c2" && started.taskId === TASK && started.kind === "agent", "…and the start parser reads it");
  eq(hub.taskContinuedData({ callId: "c1", taskId: TASK }, view, TURN), undefined, "NEGATIVE CONTROL — the opening call is not a continuation: `task.started` already carries it");
  eq(hub.taskContinuedData({ callId: "c9" }, view, TURN), undefined, "NEGATIVE CONTROL — a call that names no task starts none");
  eq(hub.taskContinuedData({ callId: "c9", taskId: "agent-unknown" }, view, TURN), undefined, "NEGATIVE CONTROL — a task the view has never seen is not continued");

  const settledView = viewOf([
    ...opening(),
    ev("call.settled", { callId: "c1", outcome: "completed", output: "first" }, { turnId: TURN }),
    ...continuation(),
    ev("call.settled", { callId: "c2", outcome: "completed", outputOf: { callId: "c1" } }, { turnId: TURN }),
  ]);
  eq(hub.settledCallOutput(settledView, { outputOf: { callId: "c1" } }), "first", "a call that shares an earlier call's output reads it from that call");
  const second = tasks.readTaskSettled(hub.taskCallSettledData({ callId: "c2", outcome: "completed" }, settledView, TURN));
  ok(second?.callId === "c2" && second.taskId === TASK, "🔴 the continuation call settles its own run of the task, under its own call id");
}

{
  const events = (hub.default as unknown as { events: Record<string, unknown> }).events;
  ok(typeof events["call.started"] === "function", "🔴 the delegation-settlement hook binds `call.started`, the continuation edge");
  ok(typeof events["call.settled"] === "function", "the delegation-settlement hook binds `call.settled`, the settlement edge");
}

console.log(`task-call-edges: ${n} assertions passed`);
