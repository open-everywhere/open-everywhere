import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

process.env.OE_SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "oe-worker-failure-")), "ops.sqlite3");

import { readAudit, type AuditEntry } from "../agent/audit/audit.js";
import type { HookContext } from "eve/hooks";

let failures = 0;
function ok(cond: boolean, label: string): void {
  if (cond) {
    console.log(`  ok  ${label}`);
    return;
  }
  failures += 1;
  console.error(`  FAIL ${label}`);
}

const ACTION = "delegation.worker_turn_failed";

const ORG = "default";

async function settledRows(org: string): Promise<AuditEntry[]> {
  let stable = 0;
  let last = -1;
  for (let attempt = 0; attempt < 150 && stable < 8; attempt += 1) {
    const rows = await readAudit({ org, action: ACTION });
    if (rows.length === last) stable += 1;
    else {
      stable = 0;
      last = rows.length;
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  return readAudit({ org, action: ACTION });
}

const hook = (await import("../agent/hooks/delegation-settlement.js")).default;

const require = createRequire(import.meta.url);
const eveRoot = dirname(require.resolve("eve/package.json"));
const { ContextContainer, contextStorage } = (await import(pathToFileURL(join(eveRoot, "dist/src/context/container.js")).href)) as {
  ContextContainer: new () => unknown;
  contextStorage: { run<T>(store: unknown, fn: () => T): T };
};

function inSession<T>(fn: () => T): T {
  return contextStorage.run(new ContextContainer(), fn);
}

function ctxFor(kind: "worker" | "seat", sessionId: string): HookContext {
  return {
    session: { id: sessionId },
    channel: { continuationToken: kind === "worker" ? `subagent:wrun_PARENT:call_ABC` : sessionId },
  } as unknown as HookContext;
}

function turnSettledEvent(outcome: "failed" | "completed") {
  return {
    type: "turn.settled",
    data: {
      turnId: "turn_worker",
      outcome,
      ...(outcome === "failed" ? { error: { code: "SUBAGENT_EXECUTION_FAILED", message: "Cannot read properties of undefined (reading 'push')" } } : {}),
    },
  };
}

console.log("§1 the hook binds an arm at turn.settled");
{
  const events = (hook as { events?: Record<string, unknown> }).events ?? {};
  ok(typeof events["turn.settled"] === "function", "🔴 hooks/delegation-settlement.ts binds `turn.settled` — a body nothing dispatches to is a row that never exists");
  ok(typeof events["call.settled"] === "function", "…and the existing delegation arms are untouched beside it");
}

const arm = ((hook as { events?: Record<string, unknown> }).events ?? {})["turn.settled"] as
  | ((event: unknown, ctx: HookContext) => Promise<void>)
  | undefined;
assert.ok(arm !== undefined, "the turn.settled arm must exist for §2-§3 to mean anything");

console.log("§2 a worker's failed turn writes one row");
{
  await inSession(async () => {
    await arm(turnSettledEvent("failed"), ctxFor("worker", "wrun_CHILD1"));
  });
  const rows = await settledRows(ORG);
  ok(rows.length === 1, "exactly one row for one dead worker");
  const d = (rows[0]?.detail ?? {}) as Record<string, unknown>;
  ok(d.code === "SUBAGENT_EXECUTION_FAILED", "the row carries eve's own class — an operator still COUNTS deaths by it");
  ok(String(d.error).includes("reading 'push'"), "…and eve's own message, which classifies the defect");
  ok(d.session === "wrun_CHILD1", "the row names the WORKER's own session — which spawn died");
}

console.log("§3 a seat's failed turn, and a worker's completed turn, write nothing");
{
  await inSession(async () => {
    await arm(turnSettledEvent("failed"), ctxFor("seat", "wrun_SEAT1"));
    await arm(turnSettledEvent("completed"), ctxFor("worker", "wrun_CHILD2"));
  });
  const rows = await settledRows(ORG);
  ok(rows.length === 1, "🔴 still ONE row — the seat's failure and the worker's completed turn wrote none, so the gate is real and §2 was not a free pass");
  ok(rows.every((r) => (r.detail as Record<string, unknown>).session !== "wrun_SEAT1"), "…and no row names the seat");
}

console.log("§4 eve's v27 turn error carries no stack frames");
{
  const { readFileSync } = await import("node:fs");
  const envelope = readFileSync(join(eveRoot, "dist/src/protocol/session-events/envelope.d.ts"), "utf8");
  const errorInfo = envelope.slice(envelope.indexOf("export interface ErrorInfo"), envelope.indexOf("}", envelope.indexOf("export interface ErrorInfo")));
  ok(/readonly code: string;/.test(errorInfo) && /readonly message: string;/.test(errorInfo), "eve's `ErrorInfo` still carries `code` and `message`, which the row reads");
  ok(
    !/details|stack/.test(errorInfo),
    "🔴 eve's v27 `ErrorInfo` carries no `details` or `stack`, so the row has no frames to read. An eve release that adds them must red HERE, so the row reads them again",
  );
}

console.log("§5 a failed delegated call writes one task_failed row, and a task-backed one writes none at the call edge");
{
  const { callView, callSettled } = await import("./_hook-view.js");
  const { TASK_FAILED_ACTION } = await import("../agent/hooks/delegation-settlement.js");
  const settledArm = ((hook as { events?: Record<string, unknown> }).events ?? {})["call.settled"] as (event: unknown, ctx: unknown) => Promise<void>;
  const failedRows = async (call: string): Promise<number> =>
    (await readAudit({ org: ORG, action: TASK_FAILED_ACTION })).filter((r) => (r.detail as Record<string, unknown> | undefined)?.call === call).length;
  await inSession(async () => {
    await settledArm(callSettled("call_task_backed", "failed", "turn_seat"), {
      ...(ctxFor("seat", "wrun_SEAT2") as object),
      view: callView({ callId: "call_task_backed", name: "worker", kind: "agent", taskId: "task_backed_1", turnId: "turn_seat", outcome: "failed" }),
    });
    await settledArm(callSettled("call_inline", "failed", "turn_seat"), {
      ...(ctxFor("seat", "wrun_SEAT2") as object),
      view: callView({ callId: "call_inline", name: "worker", kind: "agent", turnId: "turn_seat", outcome: "failed" }),
    });
  });
  await new Promise((r) => setTimeout(r, 50));
  ok((await failedRows("call_task_backed")) === 0, "🔴 a task-backed call that settles with its task writes NO `result` row — the task.ended edge owns that failure, so the call edge would double-count it");
  ok((await failedRows("call_inline")) === 1, "…and a failed delegated call with no task still writes exactly one (negative control)");
}

if (failures > 0) {
  console.error(`delegation-worker-failure: ${failures} FAILED`);
  process.exit(1);
}
console.log("delegation-worker-failure: all assertions passed");
