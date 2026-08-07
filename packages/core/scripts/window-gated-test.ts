import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

process.env.OE_SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "oe-window-gated-")), "ops.sqlite3");
delete process.env.OE_ORG;

import { defineTool } from "eve/tools";
import { z } from "zod";
import { memoryRecallRouteFor } from "../agent/access/window-gate-manifest.js";
import { canDelegateFromSeat } from "../agent/access/delegation-mount.js";
import {
  WINDOW_GATED_TOOLS,
  withheldFromGrain,
  windowGated,
  windowGatedKit,
  replayStepNames,
  preRegisterDynamicEntry,
  resolveWindowGated,
  _resetWindowGateAuditForTest,
  type GatedToolEntry,
} from "../agent/access/window-gated.js";
import { formatWindowToken, taskWindowId, threadSeatWindowId } from "../agent/channels/window-key.js";
import { readAudit } from "../agent/audit/audit.js";
import type { BindableContext, WindowGrain } from "../agent/identity/binding.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};
const eq = (a: unknown, b: unknown, label: string) => {
  assert.deepStrictEqual(a, b, label);
  n++;
};

const STANDING_TOKEN = `unified:${formatWindowToken({ domain: "payments", windowId: "payments", generation: 2 })}`;
const PER_CONTAINER_TOKEN = "slack/T1/C_PAY:oe-sup:g2";
const TASK_TOKEN = `unified:${formatWindowToken({ domain: "payments", windowId: taskWindowId("slack/C1", "1720.5"), generation: 2 })}`;
const THREAD_TOKEN = `unified:${formatWindowToken({ domain: "payments", windowId: threadSeatWindowId("slack/C1", "1720.5"), generation: 2 })}`;
const NATIVE_TOKEN = "cse_native123";

let sessionSeq = 0;
function ctxOf(token: string | undefined, opts: { grainStamp?: string; sessionId?: string; wakeId?: string } = {}): BindableContext {
  const attributes: Record<string, unknown> = {};
  if (opts.grainStamp) attributes.oe_grain = opts.grainStamp;
  if (opts.wakeId) attributes.oe_wake_id = opts.wakeId;
  return {
    channel: token === undefined ? { kind: "unified" } : { kind: "unified", continuationToken: token },
    session: { id: opts.sessionId ?? `sess-${++sessionSeq}`, auth: { current: { attributes } } },
  } as BindableContext;
}

const grainCtx: Record<WindowGrain, () => BindableContext> = {
  standing: () => ctxOf(STANDING_TOKEN),
  task: () => ctxOf(TASK_TOKEN, { grainStamp: "task" }),
  native: () => ctxOf(NATIVE_TOKEN),
  thread: () => ctxOf(THREAD_TOKEN, { grainStamp: "thread" }),
};

function stubEntry(name: string): GatedToolEntry {
  return defineTool({
    description: `stub ${name}`,
    inputSchema: z.object({ v: z.string().optional() }),
    outputSchema: z.object({ ran: z.string() }),
    async execute() {
      return { ran: name };
    },
  }) as unknown as GatedToolEntry;
}

console.log("0. WINDOW_GATED_TOOLS table pins:");
const WIDE_HANDS = ["bash", "glob", "grep", "read_file", "write_file", "web_fetch", "checkout_repo", "open_pull_request", "post_file", "create_skill", "delete_skill"] as const;
for (const name of WIDE_HANDS) {
  eq(WINDOW_GATED_TOOLS[name], ["task", "native"], `"${name}" mounts on task+native only, flag-off (withheld from standing)`);
}
eq(WINDOW_GATED_TOOLS.spawn_task, ["standing"], "spawn_task is standing-only (no recursive spawn; native has no window to mint into)");
eq(WINDOW_GATED_TOOLS.spawn_thread_session, ["standing"], "spawn_thread_session is standing-only (window-only mint; no recursive thread trees)");
eq(WINDOW_GATED_TOOLS.complete_task, ["task"], "complete_task is task-only (only a worker owns a thread)");
eq(WINDOW_GATED_TOOLS.complete_thread, ["thread"], "complete_thread is thread-only (only a thread seat owns a thread)");
eq(WINDOW_GATED_TOOLS.return_result, ["task"], "return_result is task-only (only a one-shot task returns a result)");
eq(WINDOW_GATED_TOOLS.agent, ["standing", "thread"], "agent is grain-gated to the conversational-root seats (standing+thread) — absent on native, and NEVER on a task worker leaf");
eq(Object.keys(WINDOW_GATED_TOOLS).length, WIDE_HANDS.length + 6, "the gated table is EXACTLY the 11 wide-hands tools + the 6 delegation/lifecycle tools (agent/spawn_task/spawn_thread_session/complete_task/complete_thread/return_result) — nothing else narrows");
eq([...withheldFromGrain("standing")].sort(), [...WIDE_HANDS, "complete_task", "complete_thread", "return_result"].sort(), "standing withholds the 11 wide-hands tools + complete_task + complete_thread + return_result (it KEEPS agent + the spawners — a standing seat is what delegates)");

{
  const OFF = { wide: ["task", "native"] as const, armed: false };
  const ON = { wide: ["task"] as const, armed: true };
  eq(memoryRecallRouteFor("task", OFF.wide, OFF.armed), "file-tools", "recall/flag-off: a task worker reads its own memory directly");
  eq(memoryRecallRouteFor("native", OFF.wide, OFF.armed), "file-tools", "recall/flag-off: a native @mention seat keeps its wide hands, so it reads directly");
  eq(memoryRecallRouteFor("standing", OFF.wide, OFF.armed), "spawn_task", "recall/flag-off: a standing seat has no file tools — it delegates via spawn_task (the verb it mounts flag-off)");
  eq(memoryRecallRouteFor("thread", OFF.wide, OFF.armed), "none", "recall/flag-off: a thread seat has neither file tools nor a delegation verb — the index must say so, not point at a tool");
  eq(memoryRecallRouteFor("task", ON.wide, ON.armed), "file-tools", "recall/flag-on: the one-shot worker is the sole seat with file tools");
  eq(memoryRecallRouteFor("standing", ON.wide, ON.armed), "agent", "recall/flag-on: a standing seat delegates the lookup via `agent` — THE OPE-121 route");
  eq(memoryRecallRouteFor("thread", ON.wide, ON.armed), "agent", "recall/flag-on: a thread seat delegates too (agent is the conversational-root pair)");
  eq(memoryRecallRouteFor("native", ON.wide, ON.armed), "none", "recall/flag-on: a NATIVE @mention seat can neither read memory nor delegate (T5 gap — pinned so the regression is visible, not silent)");

  eq(memoryRecallRouteFor("standing", ON.wide, ON.armed, false), "none", "recall/seat: a standing seat with NO WINDOW (a DM root) is `none`, not `agent` — the verb's window wall refuses there every time");
  eq(memoryRecallRouteFor("standing", OFF.wide, OFF.armed, false), "none", "recall/seat: …and flag-off the same seat is `none`, not `spawn_task` (both verbs share the window requirement)");
  eq(memoryRecallRouteFor("thread", ON.wide, ON.armed, false), "none", "recall/seat: a thread seat with no window token is `none` too — the seat half is grain-independent");
  eq(memoryRecallRouteFor("task", ON.wide, ON.armed, false), "file-tools", "recall/seat: a worker's OWN file tools are unaffected — the seat half only ever downgrades a DELEGATION answer");
  eq(memoryRecallRouteFor("standing", ON.wide, ON.armed, true), memoryRecallRouteFor("standing", ON.wide, ON.armed), "recall/seat: the parameter DEFAULTS TRUE — every ctx-less caller keeps today's answer byte-for-byte");
}

{
  const can = (ctx: BindableContext) => canDelegateFromSeat(ctx);
  ok(can(ctxOf(STANDING_TOKEN)), "seat: a unified WINDOW token carries a domain+generation ⇒ can delegate");
  ok(can(ctxOf(TASK_TOKEN, { grainStamp: "task" })), "seat: a task token is a window token too (the recursion guard is a SEPARATE wall — this predicate is only about having a window)");
  ok(!can(ctxOf(NATIVE_TOKEN)), "seat: a native token (the DM / group-DM root) has no window ⇒ CANNOT delegate");
  ok(!can(ctxOf(PER_CONTAINER_TOKEN)), "seat: a per-container `<chan>:oe-sup:g` token has no window either ⇒ CANNOT delegate");
  ok(can(ctxOf(undefined)), "seat: NO readable identity ⇒ fail-OPEN (mount; the execute wall stays authoritative)");
  const bomb = { channel: { kind: "unified", get continuationToken(): string { throw new Error("boom"); } }, session: { auth: { current: { attributes: {} } } } } as unknown as BindableContext;
  ok(can(bomb), "seat: an identity read that THROWS ⇒ fail-OPEN as well (never fewer signals than the wall behind it)");
}
eq([...withheldFromGrain("task")].sort(), ["agent", "complete_thread", "spawn_task", "spawn_thread_session"].sort(), "task (the worker) withholds agent + the standing-only spawners + complete_thread (it has its own wide hands + complete_task + return_result; a worker leaf must not delegate recursively — since #96 that is ABSENCE, not an execute refusal)");
eq([...withheldFromGrain("native")].sort(), ["agent", "complete_task", "complete_thread", "return_result", "spawn_task", "spawn_thread_session"].sort(), "native withholds agent + the delegation/lifecycle set; flag-off it KEEPS the wide hands (the byte-identical Stage-C state — narrowing is flag-on)");
eq([...withheldFromGrain("thread")].sort(), [...WIDE_HANDS, "complete_task", "return_result", "spawn_task", "spawn_thread_session"].sort(), "a thread seat withholds the wide hands + complete_task + return_result + the spawners (it keeps the conversational kit + agent + complete_thread)");

console.log("1. presence/absence matrix (windowGated):");
for (const [name, grains] of Object.entries(WINDOW_GATED_TOOLS)) {
  const gated = windowGated(name, stubEntry(name));
  for (const grain of ["standing", "task", "native", "thread"] as const) {
    const resolved = await resolveWindowGated(gated, grainCtx[grain]());
    if (grains.includes(grain)) {
      ok(resolved !== null && typeof (resolved as GatedToolEntry).execute === "function", `"${name}" RESOLVES on ${grain}`);
    } else {
      eq(resolved, null, `"${name}" is ABSENT on ${grain}`);
    }
  }
}
assert.throws(() => windowGated("not_a_gated_tool", stubEntry("x")), /WINDOW_GATED_TOOLS/, "windowGated throws at module load for a name with no kit row");
n++;

{
  const bomb = { channel: { kind: "unified", get continuationToken(): string { throw new Error("boom"); } }, session: { auth: { current: { attributes: {} } } } } as unknown as BindableContext;
  const resolved = await resolveWindowGated(windowGated("bash", stubEntry("bash")), bomb);
  eq(resolved, null, "a grain read that THROWS fails closed to standing ⇒ wide-hands tool absent (A7)");
}

{
  const spoof = ctxOf(PER_CONTAINER_TOKEN, { grainStamp: "task" });
  eq(await resolveWindowGated(windowGated("bash", stubEntry("bash")), spoof), null, "a model-side `task` claim on a standing token resolves NOTHING (grain is unforgeable)");
}

console.log("2. windowGatedKit:");
{
  const kit = windowGatedKit("test_kit", { bash: stubEntry("bash"), web_fetch: stubEntry("web_fetch") });
  eq(await resolveWindowGated(kit, grainCtx.standing()), null, "kit resolves NULL on standing (all entries withheld)");
  const onTask = (await resolveWindowGated(kit, grainCtx.task())) as Record<string, GatedToolEntry>;
  eq(Object.keys(onTask).sort(), ["bash", "web_fetch"], "kit resolves BOTH entries on task grain, under their bare names");
  const onNative = (await resolveWindowGated(kit, grainCtx.native())) as Record<string, GatedToolEntry>;
  eq(Object.keys(onNative).sort(), ["bash", "web_fetch"], "kit resolves both entries on native grain");
  assert.throws(() => windowGatedKit("bad_kit", { not_gated: stubEntry("x") }), /WINDOW_GATED_TOOLS/, "kit throws for an entry with no kit row");
  n++;
}

console.log("3. resolve-time audit (turn.tool_gated):");
_resetWindowGateAuditForTest();
{
  const countRows = async () => (await readAudit({ action: "turn.tool_gated" })).length;
  const rowsFor = async (sessionId: string) =>
    (await readAudit({ action: "turn.tool_gated" })).filter((r) => (r.detail as Record<string, unknown>).sessionId === sessionId);
  const base = await countRows();
  const sessionId = "sess-audit-1";
  const wakeId = "wake-audit-1";
  const mk = () => ctxOf(STANDING_TOKEN, { sessionId, wakeId });
  await resolveWindowGated(windowGated("bash", stubEntry("bash")), mk());
  await resolveWindowGated(windowGated("checkout_repo", stubEntry("checkout_repo")), mk());
  await resolveWindowGated(windowGated("complete_task", stubEntry("complete_task")), mk());
  const rows = await rowsFor(sessionId);
  eq(rows.length, 1, "many gated resolvers on ONE session ⇒ exactly one turn.tool_gated row");
  eq(await countRows(), base + 1, "…and exactly one row was ADDED overall");
  const detail = rows[0].detail as Record<string, unknown>;
  eq(detail.grain, "standing", "row records the standing grain");
  eq([...(detail.withheld as string[])].sort(), withheldFromGrain("standing").sort(), "row lists the FULL standing withheld set (not just the resolvers that fired)");
  eq(detail.withheldCount, withheldFromGrain("standing").length, "withheldCount matches");
  eq(detail.wakeId, wakeId, "row is wakeId-stamped (the e2e join key)");
  eq(detail.sessionId, sessionId, "row carries the sessionId");
  eq(rows[0].workspace, "payments", "row is domain-labelled from the window token");
  eq(Object.keys(detail).sort(), ["grain", "sessionId", "wakeId", "withheld", "withheldCount"].sort(), "detail carries names+counts+ids ONLY (GDPR taint rule)");

  await resolveWindowGated(windowGated("bash", stubEntry("bash")), ctxOf(STANDING_TOKEN, { sessionId: "sess-audit-2" }));
  eq((await rowsFor("sess-audit-2")).length, 1, "a second gated session emits its own row");

  const beforeFull = await countRows();
  await resolveWindowGated(windowGated("spawn_task", stubEntry("spawn_task")), grainCtx.task());
  await resolveWindowGated(windowGated("spawn_task", stubEntry("spawn_task")), grainCtx.native());
  eq(await countRows(), beforeFull, "withholding spawn_task/complete_task from task/native seats emits NO resolve-time row");

  await resolveWindowGated(windowGated("bash", stubEntry("bash")), ctxOf(PER_CONTAINER_TOKEN, { sessionId: "sess-audit-3" }));
  const rows3 = await rowsFor("sess-audit-3");
  eq(rows3.length, 1, "a per-container standing seat audits too");
  ok(rows3.some((r) => r.workspace === "slack/T1/C_PAY"), "per-container row is labelled with its channel key (an OE-minted pointer)");
}

console.log("4. execute backstop:");
_resetWindowGateAuditForTest();
{
  const gated = windowGated("bash", stubEntry("bash"));
  const entry = (await resolveWindowGated(gated, grainCtx.task())) as GatedToolEntry;
  eq(await entry.execute({ v: "x" }, grainCtx.task()), { ran: "bash" }, "backstop passes an allowed grain through to the tool");
  const before = (await readAudit({ action: "turn.tool_gated" })).length;
  await assert.rejects(() => Promise.resolve(entry.execute({ v: "x" }, ctxOf(STANDING_TOKEN, { sessionId: "sess-backstop", wakeId: "wake-backstop" }))), /not held by this conversational seat/, "backstop refuses a delegating standing-seat execute fail-closed (the lean arm speaks first)");
  n++;
  const rows = await readAudit({ action: "turn.tool_gated" });
  eq(rows.length, before + 1, "backstop stamps a per-ATTEMPT turn.tool_gated row");
  await assert.rejects(() => Promise.resolve(entry.execute({ v: "x" }, ctxOf(PER_CONTAINER_TOKEN, { sessionId: "sess-backstop-dm" }))), /not available on a standing/, "a NON-delegating standing seat still gets the grain refusal — the lean arm never touches it");
  n++;
  const attemptRow = rows.find((r) => (r.detail as Record<string, unknown>).wakeId === "wake-backstop");
  ok(attemptRow !== undefined, "the attempt row is wakeId-locatable");
  const attempt = attemptRow!.detail as Record<string, unknown>;
  eq(attempt.withheld, ["bash"], "the attempt row names the ONE tool attempted — never its input");
  eq(attempt.wakeId, "wake-backstop", "the attempt row is wakeId-stamped");
  const ct = (await resolveWindowGated(windowGated("complete_task", stubEntry("complete_task")), grainCtx.task())) as GatedToolEntry;
  await assert.rejects(() => Promise.resolve(ct.execute({}, grainCtx.native())), /not available on a native session/, "complete_task's backstop refuses a native-grain execute");
  n++;
}

console.log("5. replay pre-registration (eve step registry):");
{
  const reg = (globalThis as Record<symbol, unknown>)[Symbol.for("@workflow/core//registeredSteps")] as Map<string, unknown>;
  ok(reg instanceof Map, "the @workflow/core step registry exists on globalThis");
  const single = replayStepNames("bash", "_single");
  ok(typeof reg.get(single.execute) === "function", "windowGated pre-registered bash's execute under eve's replay name");
  const kitNames = replayStepNames("test_kit", "web_fetch");
  ok(typeof reg.get(kitNames.execute) === "function", "windowGatedKit pre-registered each map entry under <slug>:<entryKey>");

  const fn = reg.get(single.execute) as (cv: unknown, input: unknown, ctx: unknown) => Promise<unknown>;
  eq(await fn({}, { v: "y" }, grainCtx.native()), { ran: "bash" }, "the replayed execute runs the real tool on an allowed grain");
  await assert.rejects(() => fn({}, { v: "y" }, ctxOf(STANDING_TOKEN, { sessionId: "sess-replay" })), /not held by this conversational seat/, "the replayed execute STILL carries the backstop (replay cannot shed the gate; on a delegating standing seat the lean arm speaks)");
  n++;

  const approvalCalls: unknown[] = [];
  const withApproval = defineTool({
    description: "stub approval tool",
    inputSchema: z.object({ html: z.boolean() }),
    approval: (actx: { toolInput?: { html?: boolean } }) => {
      approvalCalls.push(actx);
      return actx.toolInput?.html ? "user-approval" : "not-applicable";
    },
    async execute() {
      return { ok: true };
    },
  }) as unknown as GatedToolEntry;
  windowGated("post_file", withApproval);
  const approvalName = replayStepNames("post_file", "_single").approval;
  const approvalFn = reg.get(approvalName) as (cv: unknown, actx: unknown) => unknown;
  ok(typeof approvalFn === "function", "an approval-bearing gated tool pre-registers its approval under eve's replay name");
  eq(approvalFn({}, { toolInput: { html: true } }), "user-approval", "the replayed approval applies the real input-aware policy (publish gate survives resumption)");
  eq(approvalFn({}, { toolInput: { html: false } }), "not-applicable", "…and stays ungated for the benign path");

  const require2 = createRequire(import.meta.url);
  const eveRoot = dirname(require2.resolve("eve/package.json"));
  const lifecycle = (await import(pathToFileURL(join(eveRoot, "dist/src/context/dynamic-tool-lifecycle.js")).href)) as {
    replayDynamicSessionTools(meta: readonly unknown[], ctx?: unknown): { name: string; execute: unknown }[];
  };
  const replayed = lifecycle.replayDynamicSessionTools([
    {
      name: "bash",
      description: "stub bash",
      inputSchema: { type: "object", properties: {} },
      resolverSlug: "bash",
      entryKey: "_single",
      executeStepFnName: single.execute,
      closureVars: {},
    },
  ]);
  eq(replayed.length, 1, "eve's replay path finds the pre-registered step fn (no skip) — the seam name is pinned against the installed eve");
  eq(replayed[0]?.name, "bash", "the replayed tool carries its mounted name");

  const rawEntry = defineTool({
    description: "raw pre-registered tool",
    inputSchema: z.object({ q: z.string().optional() }),
    async execute(input: { q?: string }) {
      return { echoed: input.q ?? "none" };
    },
  }) as unknown as GatedToolEntry;
  preRegisterDynamicEntry("pretend_reply", "_unified", rawEntry);
  const customNames = replayStepNames("pretend_reply", "_unified");
  ok(typeof reg.get(customNames.execute) === "function", "preRegisterDynamicEntry registers a custom entryKey under eve's deterministic name at module load");
  eq((rawEntry as unknown as Record<string, { stepId?: string }>).__executeStepFn?.stepId, customNames.execute, "the entry is STAMPED with the deterministic stepId (eve's resolve records it durably — never the transform's counter key)");
  eq((rawEntry as unknown as Record<string, unknown>).__closureVars, {}, "the entry is stamped with empty __closureVars (a metadata row without closureVars is SKIPPED on replay)");
  ok(reg.get(customNames.approval) === undefined, "an approval-less entry registers NO approval step (absent approval === never() on both paths)");
  const replayedCustom = lifecycle.replayDynamicSessionTools([
    {
      name: "reply",
      description: "raw pre-registered tool",
      inputSchema: { type: "object", properties: {} },
      resolverSlug: "pretend_reply",
      entryKey: "_unified",
      executeStepFnName: customNames.execute,
      closureVars: {},
    },
  ]);
  eq(replayedCustom.length, 1, "eve replays a custom-entryKey pre-registered entry (no skip)");
  const armedBash = (await resolveWindowGated(windowGated("bash", stubEntry("bash")), grainCtx.task())) as unknown as Record<string, { stepId?: string }>;
  eq(armedBash.__executeStepFn?.stepId, replayStepNames("bash", "_single").execute, "windowGated entries are stamped with the same deterministic stepId");
}

console.log(`\nwindow-gated: ${n} assertions passed.`);
