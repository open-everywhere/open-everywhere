import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

process.env.OE_SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "oe-worker-toolset-")), "ops.sqlite3");

import { auditWorkerToolset, MAX_RECORDED_NAMES, WORKER_TOOLSET_ACTION } from "../agent/audit/worker-toolset.js";
import { readAudit } from "../agent/audit/audit.js";
import type { AuditEntry } from "../agent/audit/audit.js";
import { projectToolSet, recordWorkerToolset } from "../agent/access/untrusted-projection.js";
import { setWorkerWake } from "../agent/access/worker-seat-state.js";
import { setWorkerToolsetIdentity, type WorkerToolsetIdentity } from "../agent/access/worker-toolset-state.js";
import { CONVERSATIONAL_ROOT_GRAINS } from "../agent/access/window-gate-manifest.js";

let failures = 0;
function ok(cond: boolean, label: string): void {
  if (cond) {
    console.log(`  ok  ${label}`);
    return;
  }
  failures += 1;
  console.error(`  FAIL ${label}`);
}

async function rowsFor(org: string): Promise<AuditEntry[]> {
  return readAudit({ org, action: WORKER_TOOLSET_ACTION });
}

async function settledRowsFor(org: string): Promise<AuditEntry[]> {
  let stable = 0;
  let last = -1;
  for (let attempt = 0; attempt < 150 && stable < 8; attempt += 1) {
    const rows = await rowsFor(org);
    stable = rows.length > 0 && rows.length === last ? stable + 1 : 0;
    last = rows.length;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return rowsFor(org);
}

function detailOf(row: AuditEntry): Record<string, unknown> {
  return (row.detail ?? {}) as Record<string, unknown>;
}

function identity(org: string, worker: string): WorkerToolsetIdentity {
  return {
    org,
    domain: "acme",
    worker,
    parentSession: "wrun_PARENT",
    parentCallId: "call_7",
    rootSession: "wrun_PARENT",
    turn: "turn_1",
  };
}

console.log("§1 the emitter's row shape");
{
  const org = "org-emitter";
  await auditWorkerToolset({
    who: identity(org, "wrun_WORKER"),
    reason: "mount",
    tools: ["reply", "notion__fetch", "bash"],
    withheld: ["stand_down", "no_reply"],
  });
  const rows = await rowsFor(org);
  ok(rows.length === 1, "one row per call");
  const row = rows[0]!;
  ok(row.action === WORKER_TOOLSET_ACTION, "the action is `worker.toolset`");
  ok(row.platform === "unified", "platform `unified` — the same pair turn.tool_gated uses");
  ok(row.workspace === "acme", "workspace is the domain label, so the row lands beside the seat's");
  const d = detailOf(row);
  ok(d.worker === "wrun_WORKER", "the WORKER's own session id is named — the id the incident had no row for");
  ok(d.parentSession === "wrun_PARENT", "the parent session is named");
  ok(d.parentCallId === "call_7", "the parent CALL id is named, so the row joins to one spawn");
  ok(d.rootSession === "wrun_PARENT", "the delegation root is named");
  ok(d.turn === "turn_1", "the worker's own turn is named");
  ok(d.grain === "task", "the grain is stamped `task`");
  ok(d.reason === "mount", "the row says WHY it exists — this one is the worker's first roster");
  assert.deepEqual(d.tools, ["bash", "notion__fetch", "reply"]);
  ok(true, "the mounted NAMES are carried, sorted — a discovered connector op among them");
  ok(d.toolCount === 3, "the mounted count is carried");
  ok(d.namesTruncated === false, "a short roster is not marked truncated");
  assert.deepEqual(d.withheld, ["no_reply", "stand_down"]);
  ok(true, "the worker subtraction's removed names are carried, sorted");
  ok(d.withheldCount === 2, "the withheld count is carried");
}

console.log("§2 a spawn that mounted nothing");
{
  const org = "org-empty";
  await auditWorkerToolset({ who: identity(org, "wrun_BARE"), reason: "mount", tools: [], withheld: [] });
  const rows = await rowsFor(org);
  ok(rows.length === 1, "🔴 the row is STILL written on an empty toolset — absence of a row means no worker spawned, never an empty worker");
  const d = detailOf(rows[0]!);
  assert.deepEqual(d.tools, []);
  ok(d.toolCount === 0, "the empty set is recorded as a count of zero, not as a missing field");
}

console.log("§3 a roster longer than the cap");
{
  const org = "org-capped";
  const many = Array.from({ length: MAX_RECORDED_NAMES + 10 }, (_, i) => `vendor__tool_${String(i).padStart(4, "0")}`);
  await auditWorkerToolset({ who: identity(org, "wrun_MANY"), reason: "mount", tools: many, withheld: [] });
  const d = detailOf((await rowsFor(org))[0]!);
  ok((d.tools as string[]).length === MAX_RECORDED_NAMES, "the recorded list stops at the cap — the names are partly vendor-authored, so the row is bounded");
  ok(d.namesTruncated === true, "…and the row SAYS it was truncated");
  ok(d.toolCount === MAX_RECORDED_NAMES + 10, "🔴 the count stays TRUE — a capped list must never make the row understate the roster");
}

const require = createRequire(import.meta.url);
const eveRoot = dirname(require.resolve("eve/package.json"));
const { ContextContainer, contextStorage } = (await import(pathToFileURL(join(eveRoot, "dist/src/context/container.js")).href)) as {
  ContextContainer: new () => unknown;
  contextStorage: { run<T>(store: unknown, fn: () => T): T };
};

function inSession<T>(fn: () => T): T {
  return contextStorage.run(new ContextContainer(), fn);
}

function makeToolset(extra: readonly string[] = []): Record<string, unknown> {
  const set: Record<string, unknown> = {
    reply: { execute: () => undefined },
    bash: { execute: () => undefined },
    update_status: { execute: () => undefined },
    connection_search: { execute: () => undefined },
    no_reply: { execute: () => undefined },
    stand_down: { execute: () => undefined },
    read_channel: { execute: () => undefined },
    agent: { execute: () => undefined },
  };
  for (const name of extra) set[name] = { execute: () => undefined };
  return set;
}

console.log("§4 the seam writes the row for a worker wake");
{
  const org = "org-worker";
  const toolset = makeToolset();
  inSession(() => {
    setWorkerWake(true);
    setWorkerToolsetIdentity(identity(org, "wrun_CHILD"));
    projectToolSet(toolset);
  });
  const rows = await settledRowsFor(org);
  ok(rows.length === 1, "one row for the worker's first model call");
  const d = detailOf(rows[0]!);
  const tools = d.tools as string[];
  ok(tools.includes("reply") && tools.includes("bash") && tools.includes("update_status"), "the row names what the worker KEPT");
  ok(!tools.includes("no_reply") && !tools.includes("stand_down") && !tools.includes("read_channel"), "🔴 the row names the roster AFTER the worker subtraction — not what the mount tables offered");
  ok(!tools.includes("agent"), "the withdrawn built-in `agent` is not named either — every subtraction the seam applies runs first");
  assert.deepEqual(d.withheld, ["no_reply", "read_channel", "stand_down"]);
  ok(true, "the worker subtraction's own removals are carried as the delta");
  ok(d.worker === "wrun_CHILD", "the row names the worker session the identity slot stamped");
  ok(d.reason === "mount", "the first roster is marked `mount`");
  ok(!("no_reply" in toolset) && !("stand_down" in toolset), "fixture guard — the seam really did subtract on this run");
}

console.log("§5 the dedupe is on the ROSTER, not on 'have I written a row yet'");
{
  const org = "org-repeat";
  inSession(() => {
    setWorkerWake(true);
    setWorkerToolsetIdentity(identity(org, "wrun_STEADY"));
    projectToolSet(makeToolset());
    projectToolSet(makeToolset());
    projectToolSet(makeToolset());
  });
  const rows = await settledRowsFor(org);
  ok(rows.length === 1, "🔴 three model calls with an UNCHANGED roster write exactly ONE row — a per-call row would bury the trail under the worker's own steady state");
}
{
  const org = "org-discovery";
  inSession(() => {
    setWorkerWake(true);
    setWorkerToolsetIdentity(identity(org, "wrun_example17"));
    projectToolSet(makeToolset());
    projectToolSet(makeToolset(["notion__fetch"]));
    projectToolSet(makeToolset(["notion__fetch"]));
  });
  const rows = await settledRowsFor(org);
  ok(rows.length === 2, "🔴 a roster that GREW writes a SECOND row — without it the trail positively claims the worker never held the discovered op");
  const reasons = rows.map((r) => detailOf(r).reason).sort();
  assert.deepEqual(reasons, ["changed", "mount"]);
  ok(true, "…the two rows say which is which");
  const changed = rows.find((r) => detailOf(r).reason === "changed")!;
  const mount = rows.find((r) => detailOf(r).reason === "mount")!;
  ok((detailOf(changed).tools as string[]).includes("notion__fetch"), "the second row names the discovered connector op");
  ok(!(detailOf(mount).tools as string[]).includes("notion__fetch"), "…and the first row does not, because the worker did not hold it yet");
}

console.log("§6 the seat, and two fail-soft cases");
{
  const org = "org-seat";
  inSession(() => {
    setWorkerWake(false);
    setWorkerToolsetIdentity(identity(org, "wrun_SEAT"));
    projectToolSet(makeToolset());
  });
  await new Promise((resolve) => setTimeout(resolve, 300));
  ok((await rowsFor(org)).length === 0, "🔴 a NON-worker wake writes no row even with an identity stamped — the WORKER BIT is what gates it");
}
{
  const org = "org-unstamped";
  inSession(() => {
    setWorkerWake(true);
    setWorkerToolsetIdentity(null);
    projectToolSet(makeToolset());
  });
  await new Promise((resolve) => setTimeout(resolve, 300));
  ok((await rowsFor(org)).length === 0, "🔴 an unstamped identity writes NO row — the fail direction is silence, never invented ids");
}
{
  const ORGS_SO_FAR = [
    "org-emitter",
    "org-empty",
    "org-capped",
    "org-worker",
    "org-repeat",
    "org-discovery",
    "org-seat",
    "org-unstamped",
  ] as const;
  const totalRows = async (): Promise<number> => {
    let n = 0;
    for (const o of ORGS_SO_FAR) n += (await rowsFor(o)).length;
    return n;
  };
  const before = await totalRows();
  recordWorkerToolset(["reply"], []);
  await new Promise((resolve) => setTimeout(resolve, 300));
  const after = await totalRows();
  ok(after === before, `a context-less caller writes no row and does not throw — ${before} rows before, ${after} after`);
}

console.log("§7 the grant plane cannot reach a worker");
{
  ok(!(CONVERSATIONAL_ROOT_GRAINS as readonly string[]).includes("task"), "🔴 a credential-grant tool cannot mount on grain `task`, so no worker row can ever name one");
  ok((CONVERSATIONAL_ROOT_GRAINS as readonly string[]).includes("standing"), "…fixture guard: the list really is the conversational root grains");
}

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed`);
  process.exit(1);
}
console.log("\nall worker-toolset evidence assertions passed");
