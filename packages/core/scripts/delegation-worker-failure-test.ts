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

function turnFailedEvent(detail: string) {
  return {
    type: "turn.failed",
    data: {
      code: "SUBAGENT_EXECUTION_FAILED",
      message: "Cannot read properties of undefined (reading 'push')",
      details: { errorId: "err_ope1751", message: "Cannot read properties of undefined (reading 'push')", name: "TypeError", detail },
    },
  };
}

const LIVE_STACK =
  "TypeError: Cannot read properties of undefined (reading 'push')\n" +
  "    at projectToolSet (/var/task/packages/core/dist/agent/access/untrusted-projection.js:101:7)\n" +
  "    at __oeProjectToolSet (/var/task/node_modules/eve/dist/src/harness/tool-loop.js:17:64)\n";

console.log("§1 the hook binds an arm at turn.failed");
{
  const events = (hook as { events?: Record<string, unknown> }).events ?? {};
  ok(typeof events["turn.failed"] === "function", "🔴 hooks/delegation-settlement.ts binds `turn.failed` — a body nothing dispatches to is a row that never exists");
  ok(typeof events["action.result"] === "function", "…and the existing delegation arms are untouched beside it");
}

const arm = ((hook as { events?: Record<string, unknown> }).events ?? {})["turn.failed"] as
  | ((event: unknown, ctx: HookContext) => Promise<void>)
  | undefined;
assert.ok(arm !== undefined, "the turn.failed arm must exist for §2-§3 to mean anything");

console.log("§2 a worker's failed turn writes one row, and it carries the frames");
{
  await inSession(async () => {
    await arm(turnFailedEvent(LIVE_STACK), ctxFor("worker", "wrun_CHILD1"));
  });
  const rows = await settledRows(ORG);
  ok(rows.length === 1, "exactly one row for one dead worker");
  const d = (rows[0]?.detail ?? {}) as Record<string, unknown>;
  ok(d.code === "SUBAGENT_EXECUTION_FAILED", "the row carries eve's own class — an operator still COUNTS deaths by it");
  ok(String(d.error).includes("reading 'push'"), "…and eve's own message, which classifies the defect");
  ok(String(d.frames).startsWith("at projectToolSet ("), "🔴 THE POINT OF THE ROW: the FIRST frame names the throwing line");
  ok(String(d.frames).includes("untrusted-projection.js:101:7"), "…with its file, line and column");
  ok(!String(d.frames).includes("Cannot read properties"), "🔴 the message is NOT in `frames` — it fails the grammar's name rules, so the row's diagnosis is not buried under the error's own prose");
  ok(d.session === "wrun_CHILD1", "the row names the WORKER's own session — which spawn died");
}

console.log("§3 a seat's failed turn writes nothing");
{
  await inSession(async () => {
    await arm(turnFailedEvent(LIVE_STACK), ctxFor("seat", "wrun_SEAT1"));
  });
  const rows = await settledRows(ORG);
  ok(rows.length === 1, "🔴 still ONE row — the seat's failure wrote none, so the gate is real and §2 was not a free pass");
  ok(rows.every((r) => (r.detail as Record<string, unknown>).session !== "wrun_SEAT1"), "…and no row names the seat");
}

console.log("§4 eve still puts a details record on turn.failed");
{
  const { readFileSync } = await import("node:fs");
  const message = readFileSync(join(eveRoot, "dist/src/protocol/message.js"), "utf8");
  ok(
    /function createTurnFailedEvent\([^)]*\)\{return\{data:\{[^}]*details:/.test(message),
    "🔴 eve's `createTurnFailedEvent` still carries `details` — the frames are read off it, and an eve release that drops the field must red HERE, not empty the row in silence",
  );
  const emission = readFileSync(join(eveRoot, "dist/src/harness/emission.js"), "utf8");
  ok(emission.includes("createTurnFailedEvent"), "…and `emitStepAndTurnFailed` is still what emits it, through the same emit function the hook dispatcher wraps");
}

if (failures > 0) {
  console.error(`delegation-worker-failure: ${failures} FAILED`);
  process.exit(1);
}
console.log("delegation-worker-failure: all assertions passed");
