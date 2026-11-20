// proves: const WORKER_TOOLSET_ACTION, worker.toolset

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

process.env.OE_SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "oe-worker-toolset-")), "ops.sqlite3");

import { auditWorkerToolset, MAX_RECORDED_NAMES, WORKER_TOOLSET_ACTION } from "../agent/audit/worker-toolset.js";
import { isGrantToolName } from "../agent/operational/credential-grant-rows.js";
import { readAudit } from "../agent/audit/audit.js";
import type { AuditEntry } from "../agent/audit/audit.js";
import { dropWorkerRound, recordOfferedWorkerToolset, recordWorkerToolset, seatCut } from "../agent/access/seat-cut.js";
import { setNativeDelegationSeat } from "../agent/access/native-delegation-state.js";
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
    reply: { description: "reply", execute: () => undefined },
    bash: { description: "bash", execute: () => undefined },
    update_status: { description: "update_status", execute: () => undefined },
    connection_search: { description: "connection_search", execute: () => undefined },
    no_reply: { description: "no_reply", execute: () => undefined },
    stand_down: { description: "stand_down", execute: () => undefined },
    read_channel: { description: "read_channel", execute: () => undefined },
  };
  for (const name of extra) set[name] = { description: name, execute: () => undefined };
  return set;
}

const DYNAMIC = Symbol.for("eve.dynamic");

let sessionSeq = 0;

/** eve 1.x mounts these on a worker outside every seat-cut slot: its own tools, a static slot, a declared subagent. */
const EVE_MOUNTED = ["ask_question", "eve__skill", "eve__task_cancel", "eve__task_wait", "fresh_eyes_review"] as const;

async function evaluateCut(toolset: Record<string, unknown>, sessionId: string): Promise<string[]> {
  const ctx = { session: { id: sessionId } };
  const kept: string[] = [];
  for (const [name, tool] of Object.entries(toolset)) {
    const fn = (seatCut(name, tool) as Record<symbol, (c: unknown) => unknown>)[DYNAMIC]!;
    if ((await fn(ctx)) !== null) kept.push(name);
    else delete toolset[name];
  }
  return kept;
}

/** One model call: the seat cut evaluates its slots, then the call offers what the cut kept plus `eveMounted`. */
async function modelCall(toolset: Record<string, unknown>, sessionId: string, eveMounted: readonly string[] = []): Promise<string[]> {
  const kept = await evaluateCut(toolset, sessionId);
  recordOfferedWorkerToolset(sessionId, [...kept, ...eveMounted]);
  return kept;
}

function session(): string {
  sessionSeq += 1;
  return `wrun_SESSION_${sessionSeq}`;
}

console.log("§4 the seam writes the row for a worker wake");
{
  const org = "org-worker";
  const toolset = makeToolset();
  await inSession(async () => {
    setWorkerWake(true);
    setWorkerToolsetIdentity(identity(org, "wrun_CHILD"));
    await modelCall(toolset, session());
  });
  const rows = await settledRowsFor(org);
  ok(rows.length === 1, "one row for the worker's first model call");
  const d = detailOf(rows[0]!);
  const tools = d.tools as string[];
  ok(tools.includes("reply") && tools.includes("bash") && tools.includes("update_status"), "the row names what the worker KEPT");
  ok(!tools.includes("no_reply") && !tools.includes("stand_down") && !tools.includes("read_channel"), "🔴 the row names the roster AFTER the worker subtraction — not what the mount tables offered (the seat-cut evaluations of one model call, flushed at `model.started`)");
  assert.deepEqual(d.withheld, ["no_reply", "read_channel", "stand_down"]);
  ok(true, "the worker subtraction's own removals are carried as the delta");
  ok(d.worker === "wrun_CHILD", "the row names the worker session the identity slot stamped");
  ok(d.reason === "mount", "the first roster is marked `mount`");
  ok(!("no_reply" in toolset) && !("stand_down" in toolset), "fixture guard — the seam really did subtract on this run");
}

console.log("§4b the model call's offered list is what writes the row, and it names what eve mounts");
{
  const org = "org-offered";
  const id = session();
  await inSession(async () => {
    setWorkerWake(true);
    setWorkerToolsetIdentity(identity(org, "wrun_OFFERED"));
    await evaluateCut(makeToolset(), id);
  });
  await new Promise((resolve) => setTimeout(resolve, 300));
  ok((await rowsFor(org)).length === 0, "🔴 the seat-cut evaluations alone write NO row — one evaluation sees one slot, never the whole offered set");
  await inSession(async () => {
    setWorkerWake(true);
    setNativeDelegationSeat("leaf");
    setWorkerToolsetIdentity(identity(org, "wrun_OFFERED"));
    recordOfferedWorkerToolset(id, ["reply", "bash", "update_status", "connection_search", ...EVE_MOUNTED, "agent"]);
  });
  const rows = await settledRowsFor(org);
  ok(rows.length === 1, "…and the model call's record writes ONE row");
  const d = detailOf(rows[0]!);
  const tools = d.tools as string[];
  for (const name of EVE_MOUNTED) ok(tools.includes(name), `🔴 the row names \`${name}\`, which eve mounts outside the seat cut`);
  ok(tools.includes("agent"), "🔴 the row names `agent`: the worker is OFFERED it, whatever the call-time gate then does");
  ok(d.toolCount === 4 + EVE_MOUNTED.length + 1, "the count is the whole offered set");
  assert.deepEqual(d.outsideSeatCut, ["agent", ...EVE_MOUNTED].sort());
  ok(true, "🔴 `outsideSeatCut` names exactly the offered tools the seat cut never evaluated");
  ok(d.outsideSeatCutCount === EVE_MOUNTED.length + 1, "…with its count");
  assert.deepEqual(d.refused, ["agent"]);
  ok(true, "🔴 `refused` names `agent`: offered, and refused at call time on a seat whose verdict is not `allow`");
  assert.deepEqual(d.withheld, ["no_reply", "read_channel", "stand_down"]);
  ok(true, "the seat cut's removals stay in `withheld`, unchanged for readers");
  ok(d.seatCutSeen === true, "NEGATIVE CONTROL: with a round visible, the row says `seatCutSeen: true`");
}
{
  const org = "org-offered-allow";
  const id = session();
  await inSession(async () => {
    setWorkerWake(true);
    setNativeDelegationSeat("allow");
    setWorkerToolsetIdentity(identity(org, "wrun_ALLOW"));
    await evaluateCut(makeToolset(), id);
    recordOfferedWorkerToolset(id, ["reply", "agent"]);
  });
  const d = detailOf((await settledRowsFor(org))[0]!);
  assert.deepEqual(d.refused, []);
  ok(true, "NEGATIVE CONTROL: with the `allow` verdict, `agent` is offered and NOT listed as refused");
}
{
  const org = "org-offered-no-round";
  await inSession(async () => {
    setWorkerWake(true);
    setWorkerToolsetIdentity(identity(org, "wrun_NOROUND"));
    recordOfferedWorkerToolset(session(), ["reply", "eve__skill"]);
  });
  const d = detailOf((await settledRowsFor(org))[0]!);
  ok(d.outsideSeatCut === null && d.outsideSeatCutCount === null, "🔴 with no seat-cut round to compare, `outsideSeatCut` is null — never a guess that every tool came from outside the cut");
  ok(d.seatCutSeen === false, "🔴 …and the row says `seatCutSeen: false`, so its empty `withheld` reads as unknown, not as 'the cut removed nothing'");
  assert.deepEqual(d.withheld, []);
  ok(true, "…the empty `withheld` is the documented no-round value");
  assert.deepEqual(d.tools, ["eve__skill", "reply"]);
  ok(true, "…and the offered names are still recorded");
  const hookSrc = readFileSync(new URL("../agent/hooks/lean-seat.ts", import.meta.url), "utf8");
  ok(!hookSrc.includes('"model.started"'), "🔴 hooks/lean-seat.ts no longer writes the row on `model.started`: that flush saw only the seat cut's names");
}

console.log("§4c a round is dropped at turn.settled, so its names never leak into the next row");
{
  const hook = (await import("../agent/hooks/lean-seat.js")).default as unknown as {
    events: Record<string, (event: unknown, ctx: unknown) => Promise<void>>;
  };
  const evaluateOnly = async (id: string) => {
    await (seatCut("bash", { description: "bash", execute: () => undefined }) as Record<symbol, (c: unknown) => unknown>)[DYNAMIC]!({ session: { id } });
  };

  const controlOrg = "org-stale-control";
  const controlId = session();
  await inSession(async () => {
    setWorkerWake(true);
    setWorkerToolsetIdentity(identity(controlOrg, "wrun_STALE_CONTROL"));
    await evaluateOnly(controlId);
    setWorkerWake(true);
    setWorkerToolsetIdentity(identity(controlOrg, "wrun_STALE_CONTROL"));
    recordOfferedWorkerToolset(controlId, ["bash"]);
  });
  const control = await settledRowsFor(controlOrg);
  ok(control.length === 1, "NEGATIVE CONTROL: with no turn.settled between them, a later model call writes the row");
  assert.deepEqual(detailOf(control[0]!).outsideSeatCut, []);
  ok(true, "NEGATIVE CONTROL: …and the surviving round says `bash` passed the seat cut");

  const org = "org-stale";
  const id = session();
  await inSession(async () => {
    setWorkerWake(true);
    setWorkerToolsetIdentity(identity(org, "wrun_STALE"));
    await evaluateOnly(id);
    await hook.events["turn.settled"]!({}, { session: { id } });
    setWorkerWake(true);
    setWorkerToolsetIdentity(identity(org, "wrun_STALE"));
    recordOfferedWorkerToolset(id, ["bash"]);
  });
  const stale = await settledRowsFor(org);
  ok(stale.length === 1, "a later model call still writes its row");
  ok(detailOf(stale[0]!).outsideSeatCut === null, "🔴 the real hooks/lean-seat.ts `turn.settled` handler drops the round, so the later row cannot reuse its names");
}

console.log("§5 the dedupe is on the ROSTER, not on 'have I written a row yet'");
{
  const org = "org-repeat";
  await inSession(async () => {
    setWorkerWake(true);
    setWorkerToolsetIdentity(identity(org, "wrun_STEADY"));
    const id = session();
    await modelCall(makeToolset(), id);
    await modelCall(makeToolset(), id);
    await modelCall(makeToolset(), id);
  });
  const rows = await settledRowsFor(org);
  ok(rows.length === 1, "🔴 three model calls with an UNCHANGED roster write exactly ONE row — a per-call row would bury the trail under the worker's own steady state");
}
{
  const org = "org-discovery";
  await inSession(async () => {
    setWorkerWake(true);
    setWorkerToolsetIdentity(identity(org, "wrun_SEARCHER"));
    const id = session();
    await modelCall(makeToolset(), id);
    await modelCall(makeToolset(["notion__fetch"]), id);
    await modelCall(makeToolset(["notion__fetch"]), id);
  });
  const rows = await settledRowsFor(org);
  ok(rows.length === 2, "🔴 an offered set that GREW writes a SECOND row (the dedupe is on the roster)");
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
  await inSession(async () => {
    setWorkerWake(false);
    setNativeDelegationSeat("allow");
    setWorkerToolsetIdentity(identity(org, "wrun_SEAT"));
    await modelCall(makeToolset(), session());
  });
  await new Promise((resolve) => setTimeout(resolve, 300));
  ok((await rowsFor(org)).length === 0, "🔴 a NON-worker wake writes no row even with an identity stamped — the WORKER BIT is what gates it");
}
{
  const org = "org-unstamped";
  await inSession(async () => {
    setWorkerWake(true);
    setWorkerToolsetIdentity(null);
    await modelCall(makeToolset(), session());
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
    "org-flush",
    "org-stale",
    "org-stale-control",
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

console.log("§7 a lent tool's name is recorded like any other");
{
  const lent = "grant__dana_notion__notion_fetch_launch_checklist";
  ok(isGrantToolName(lent), "fixture guard: the fixture name really is one the grant plane could mint");
  const org = "org-lent";
  await auditWorkerToolset({ who: identity(org, "wrun_LENT"), reason: "mount", tools: ["reply", lent], withheld: [] });
  const recorded = detailOf((await rowsFor(org))[0]!).tools as string[];
  ok(recorded.includes(lent), "a lent tool's name is filtered out of the worker toolset row — the one worker capability an auditor most needs to see would be invisible");
  ok(recorded.includes("reply"), "…fixture guard: an ordinary name is recorded too, so the assertion above is not measuring an empty row");
  ok(!(CONVERSATIONAL_ROOT_GRAINS as readonly string[]).includes("task"), "the conversational-root list gained `task` — the seat/worker seam moved, which is not what OPE-2023 did");
  ok((CONVERSATIONAL_ROOT_GRAINS as readonly string[]).includes("standing"), "…fixture guard: the list really is the conversational root grains");
}

console.log("§8 the worker's model records the offered set from the call's own `tools` (reachability)");
{
  const { resolvePrimaryModel } = await import("../agent/model/routing.js");
  const { offeredToolNames, withWorkerToolsetEvidence } = await import("../agent/model/worker-toolset-evidence.js");
  type RoutableModel = import("../agent/model/routing.js").RoutableModel;
  type RoutingDeps = import("../agent/model/routing.js").RoutingDeps;
  type BindableContext = import("../agent/identity/binding.js").BindableContext;

  const fnTool = (name: string) => ({ type: "function", name, description: name, inputSchema: { type: "object" } });
  const callTools = [...["reply", "bash", "update_status"].map(fnTool), ...EVE_MOUNTED.map(fnTool), { type: "provider", id: "vendor.web_search", name: "web_search", args: {} }];
  assert.deepEqual(offeredToolNames({ tools: callTools }), [...EVE_MOUNTED, "bash", "reply", "update_status", "web_search"].sort());
  ok(true, "offeredToolNames reads every entry of the call's `tools` list: function tools and a provider tool");
  ok(offeredToolNames({}).length === 0 && offeredToolNames({ tools: "junk" }).length === 0, "…and an absent or malformed list reads as no names, never a throw");

  const innerCalls: unknown[] = [];
  const fakeModel = (id: string): RoutableModel => ({
    specificationVersion: "v3",
    provider: "fake",
    modelId: id,
    supportedUrls: {},
    async doGenerate(options: unknown) {
      innerCalls.push(options);
      return { content: [], finishReason: { unified: "stop", raw: "stop" }, usage: {}, warnings: [] };
    },
    async doStream(options: unknown) {
      innerCalls.push(options);
      return { stream: new ReadableStream({ start: (c) => c.close() }) };
    },
  });
  const deps: RoutingDeps = { domains: () => [], backend: { model: fakeModel, applyOptions: (_route, options) => options } };
  const workerCtx = (id: string) =>
    ({
      channel: { kind: "slack" },
      session: {
        id,
        auth: { current: { attributes: { team_id: "T1", channel_id: "C1", channel_type: "channel", is_private: "false", trust_checked: "true" }, principalId: "U1", principalType: "user" } },
      },
    }) as unknown as BindableContext;

  const drive = async (org: string, worker: boolean, tools: readonly unknown[], dropName?: string): Promise<AuditEntry[]> => {
    const id = session();
    await inSession(async () => {
      setWorkerWake(true);
      setNativeDelegationSeat("leaf");
      setWorkerToolsetIdentity(identity(org, `wrun_${org}`));
      await evaluateCut(makeToolset(), id);
      // The worker bit at RESOLVE time decides the wrap. A non-worker resolve sets it back to true
      // before the call, so a wrapper applied to every model would write a row here.
      setWorkerWake(worker);
      const model = await resolvePrimaryModel(workerCtx(id), { primary: { id: "vendor/default-model" } }, deps, { data: { turnId: `turn_${org}` } });
      setWorkerWake(true);
      const sent = dropName === undefined ? tools : tools.filter((t) => (t as { name: string }).name !== dropName);
      await model.doStream({ tools: sent, prompt: [] });
    });
    return worker ? settledRowsFor(org) : (await new Promise((r) => setTimeout(r, 300)), rowsFor(org));
  };

  const rows = await drive("org-model-call", true, callTools);
  ok(rows.length === 1, "🔴 a worker's model call through resolvePrimaryModel writes the row");
  ok(innerCalls.length > 0, "…and the call still reaches the backend model");
  const d = detailOf(rows[0]!);
  // A `leaf` worker's verdict withdraws the task-parent verbs, so the model-call cut
  // (`model/seat-tool-cut.ts`) takes them off the call before the evidence wrapper reads it.
  const TASK_PARENT = ["eve__task_cancel", "eve__task_wait"];
  assert.deepEqual(d.tools, offeredToolNames({ tools: callTools }).filter((name) => !TASK_PARENT.includes(name)));
  ok(true, "🔴 the row's `tools` equals the set the model is offered after the model-call cut, eve-mounted names included");
  assert.deepEqual(d.outsideSeatCut, [...EVE_MOUNTED, "web_search"].filter((name) => !TASK_PARENT.includes(name)).sort());
  ok(true, "…and `outsideSeatCut` names the offered tools that no seat-cut slot evaluated");
  ok(TASK_PARENT.every((name) => !(d.tools as string[]).includes(name)), "🔴 a name the model-call cut withholds is not in the row: the model never saw it");

  const dropped = await drive("org-model-call-drop", true, callTools, "ask_question");
  ok(!(detailOf(dropped[0]!).tools as string[]).includes("ask_question") && (detailOf(rows[0]!).tools as string[]).includes("ask_question"), "🔴 a name the call does not offer is not in the row: the row follows the call, not a fixed list");

  ok((await drive("org-model-call-seat", false, callTools)).length === 0, "NEGATIVE CONTROL: a model resolved on a non-worker wake is not wrapped, so its call writes no row even when the worker bit is set at call time");

  const plain = withWorkerToolsetEvidence(deps, undefined);
  await inSession(async () => {
    setWorkerWake(true);
    setWorkerToolsetIdentity(identity("org-model-call-noid", "wrun_NOID"));
    await plain.backend.model("vendor/x").doStream({ tools: callTools });
  });
  await new Promise((r) => setTimeout(r, 300));
  ok((await rowsFor("org-model-call-noid")).length === 0, "a model call with no session id writes no row and does not throw");
}

console.log("§9 the row names each connector operation the worker reaches only through `eve__tool`");
{
  const { connectorToolSet } = await import("../agent/connections/connector-tools.js");
  const { reachableThroughEveTool } = await import("../agent/access/seat-cut.js");
  const op = (name: string) => ({ name, description: `${name} op`, inputSchema: { type: "object", properties: {} }, hasOutputSchema: false });
  const source = { connection: "notion", url: "https://mcp.example.test/mcp", auth: (async () => ({})) as never };
  const connectorOps = () => connectorToolSet(source, [op("fetch"), op("search")]);
  const CONNECTOR_NAMES = Object.keys(connectorOps()).sort();
  ok(CONNECTOR_NAMES.length === 2 && CONNECTOR_NAMES.every((name) => name.startsWith("notion__")), "fixture guard: the real connector tool set names one `notion__` tool per listed operation");
  ok(Object.values(connectorOps()).every((entry) => reachableThroughEveTool(entry, true)), "🔴 each real connector operation entry is one eve's step catalog admits through `eve__tool`, on a delegated session too");

  // The predicate is a copy of eve's own call-time test. Pin it to eve's `callableOf` on a fixture
  // matrix, for a root session and a delegated one, so an eve upgrade that changes the rule turns red.
  const { callableOf } = (await import(pathToFileURL(join(eveRoot, "dist/src/execution/catalog/step-catalog.js")).href)) as {
    callableOf: (input: unknown) => { deferred: Map<string, unknown> };
  };
  const matrix: Record<string, Record<string, unknown>> = {
    plain: { description: "plain", execute: () => undefined },
    deferred: { description: "deferred", deferred: true, execute: () => undefined },
    deferredSubHidden: { description: "x", deferred: true, availableInSubagents: false, execute: () => undefined },
    deferredRootOnly: { description: "x", deferred: true, rootOnly: true, execute: () => undefined },
    deferredRootAvailability: { description: "x", deferred: true, behavior: { availability: ["root-session"] }, execute: () => undefined },
    ...connectorOps(),
  };
  for (const rootSessionId of [undefined, "wrun_ROOT"]) {
    const container = new ContextContainer();
    const eveSees = contextStorage.run(container, () =>
      callableOf({
        ctx: container,
        endsTurn: false,
        session: { rootSessionId },
        table: { connections: [], skills: new Map(), entries: new Map(Object.entries(matrix).map(([name, d]) => [name, { definition: { name, ...(d as object) } }])) },
      }),
    );
    const ours = Object.entries(matrix).flatMap(([name, entry]) => (reachableThroughEveTool(entry, rootSessionId !== undefined) ? [name] : []));
    assert.deepEqual(ours.sort(), [...eveSees.deferred.keys()].sort(), `🔴 reachableThroughEveTool drifted from eve's callableOf (rootSessionId=${String(rootSessionId)})`);
  }

  const DELEGATED = { rootSessionId: "wrun_PARENT", sessionId: "wrun_PARENT", callId: "call_7" };
  /** One worker model call: the seat cut evaluates the plain slots and the connector slot, then eve offers what it advertises. */
  const connectorCall = async (org: string, id: string, extra: Record<string, unknown>, offered: readonly string[], parent: unknown = DELEGATED) => {
    await inSession(async () => {
      setWorkerWake(true);
      setNativeDelegationSeat("leaf");
      setWorkerToolsetIdentity(identity(org, `wrun_${org}`));
      const kept = await evaluateCut(makeToolset(), id);
      await (seatCut("notion", { ...connectorOps(), ...extra }) as Record<symbol, (c: unknown) => unknown>)[DYNAMIC]!({ session: { id, parent } });
      recordOfferedWorkerToolset(id, [...kept, ...offered]);
    });
  };
  const hidden = { description: "hidden", deferred: true, availableInSubagents: false, execute: () => undefined };
  const withheldDeferred = { description: "stand_down", deferred: true, execute: () => undefined };

  const org = "org-eve-tool";
  await connectorCall(org, session(), { notion__admin_only: hidden, stand_down: withheldDeferred }, ["eve__search", "eve__tool"]);
  const rows = await settledRowsFor(org);
  ok(rows.length === 1, "one row for the worker's model call");
  const d = detailOf(rows[0]!);
  assert.deepEqual(d.throughEveTool, CONNECTOR_NAMES, "🔴 `throughEveTool` must name EVERY connector operation the worker reaches through `eve__tool`, and nothing else");
  ok(d.throughEveToolCount === CONNECTOR_NAMES.length, "…with its count");
  ok(!(d.throughEveTool as string[]).includes("notion__admin_only"), "NEGATIVE CONTROL: on a delegated worker, a deferred entry hidden from delegated sessions is NOT listed");
  ok(!(d.throughEveTool as string[]).includes("stand_down"), "NEGATIVE CONTROL: a deferred entry the worker seat withholds is NOT listed");
  ok((d.withheld as string[]).includes("stand_down"), "…fixture guard: the worker seat really did withhold it");
  // This unit test builds the offered list itself. The proof that eve leaves a deferred connector
  // operation out of the offered `tools` is the integration leg (connectors/connector-result-fence).
  assert.deepEqual(d.tools, ["bash", "connection_search", "eve__search", "eve__tool", "reply", "update_status"], "the existing `tools` field stays the offered list only");
  ok(d.seatCutSeen === true && Array.isArray(d.outsideSeatCut), "`seatCutSeen` and `outsideSeatCut` keep their shape");

  const rootOrg = "org-eve-tool-root";
  await connectorCall(rootOrg, session(), { notion__admin_only: hidden }, ["eve__search", "eve__tool"], null);
  const rootRow = detailOf((await settledRowsFor(rootOrg))[0]!);
  assert.deepEqual(rootRow.throughEveTool, [...CONNECTOR_NAMES, "notion__admin_only"].sort(), "🔴 a root-session worker (a task window) sees every deferred entry, so the row lists the entry hidden from delegated sessions too");

  const noCall = "org-eve-tool-absent";
  await connectorCall(noCall, session(), {}, ["eve__search"]);
  const nd = detailOf((await settledRowsFor(noCall))[0]!);
  assert.deepEqual(nd.throughEveTool, [], "NEGATIVE CONTROL: with no `eve__tool` offered, the list is empty");
  ok(nd.throughEveToolCount === 0, "NEGATIVE CONTROL: with no `eve__tool` offered, no deferred entry is reachable, so the count is zero");

  const noRound = "org-eve-tool-no-round";
  await inSession(async () => {
    setWorkerWake(true);
    setWorkerToolsetIdentity(identity(noRound, "wrun_NOROUND_EVE"));
    recordOfferedWorkerToolset(session(), ["reply", "eve__tool"]);
  });
  const rd = detailOf((await settledRowsFor(noRound))[0]!);
  ok(rd.throughEveTool === null && rd.throughEveToolCount === null, "🔴 with no seat-cut round visible, `throughEveTool` is null (unknown), never an empty list that reads as 'nothing reachable'");

  const grow = "org-eve-tool-grow";
  const gid = session();
  await inSession(async () => {
    setWorkerWake(true);
    setNativeDelegationSeat("leaf");
    setWorkerToolsetIdentity(identity(grow, "wrun_GROW"));
    const kept = await evaluateCut(makeToolset(), gid);
    const offered = [...kept, "eve__search", "eve__tool"];
    await (seatCut("notion", connectorToolSet(source, [op("fetch")])) as Record<symbol, (c: unknown) => unknown>)[DYNAMIC]!({ session: { id: gid, parent: DELEGATED } });
    recordOfferedWorkerToolset(gid, offered);
    await (seatCut("notion", connectorOps()) as Record<symbol, (c: unknown) => unknown>)[DYNAMIC]!({ session: { id: gid, parent: DELEGATED } });
    recordOfferedWorkerToolset(gid, offered);
  });
  const grown = await settledRowsFor(grow);
  ok(grown.length === 2, "🔴 a connector operation that appears with the offered list UNCHANGED writes a `changed` row (the dedupe key holds both reach paths)");
  const changed = grown.find((r) => detailOf(r).reason === "changed");
  ok(changed !== undefined && (detailOf(changed).throughEveTool as string[]).length === 2, "…and that row names the new connector operation");
}

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed`);
  process.exit(1);
}
console.log("\nall worker-toolset evidence assertions passed");
