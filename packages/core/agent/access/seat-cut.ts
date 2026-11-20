import { defineDynamic, type DynamicToolResult } from "eve/tools";
import { restrictToolsetForJobWake, type JobWakePosture } from "./job-posture.js";
import { currentJobWakePosture } from "./job-session-state.js";
import { restrictToolsetForLeanSeat, restrictToolsetForWorkSession, WORK_CANCEL_TOOL, WORK_FORWARD_TOOL } from "./lean-seat.js";
import { currentLeanSeatIsDm, currentLeanSeatPosture, currentWorkTier, type WorkTierVerdict } from "./lean-seat-state.js";
import { restrictToolsetForWorkerSeat } from "./worker-seat.js";
import { currentWorkerWake } from "./worker-seat-state.js";
import { restrictToolsetForInvokerPosture, type InvokerPosture } from "./invoker-posture.js";
import { currentInvokerPosture } from "./invoker-posture-state.js";
import { currentHaltStamp } from "./halt-state.js";
import { nativeAgentAllowedNow } from "./native-delegation-state.js";
import { TASK_PARENT_TOOL_NAMES } from "./background-tasks.js";
import { claimWorkerToolsetEvidence, currentWorkerToolsetIdentity } from "./worker-toolset-state.js";
import { auditWorkerToolset, type WorkerToolsetProvenance } from "../audit/worker-toolset.js";
import { nativeAgentRefusal } from "./native-delegation-gate.js";
import { transformAuthoredToolset } from "./authored-tool-transforms.js";
import { testValveArmed } from "../testing/test-valves.js";

export { SEAT_CUT_STATIC_SLOTS, seatCutApplies } from "./seat-cut-slots.js";

const NATIVE_QUESTION_TOOL = "ask_question";
const WORK_QUESTION_TOOL = "ask_room";

export const HALTED_WITHHELD_TOOLS: readonly string[] = ["web_search", "web_fetch"];

export interface SeatCutPosture {
  readonly workTier: WorkTierVerdict;
  readonly jobWake: JobWakePosture;
  readonly lean: boolean;
  readonly dmSeat: boolean;
  readonly worker: boolean;
  readonly invoker: InvokerPosture;
  readonly halted: boolean;
  readonly agentAllowed: boolean;
}

function currentSeatCutPosture(): SeatCutPosture {
  return {
    workTier: currentWorkTier(),
    jobWake: currentJobWakePosture(),
    lean: currentLeanSeatPosture() === "lean",
    dmSeat: currentLeanSeatIsDm(),
    worker: currentWorkerWake(),
    invoker: currentInvokerPosture(),
    halted: currentHaltStamp() === true,
    agentAllowed: nativeAgentAllowedNow(),
  };
}

export interface SeatCutResult {
  readonly withheld: readonly string[];
  readonly workerWithheld: readonly string[];
}

export function seatCutToolset(toolset: Record<string, unknown>, posture: SeatCutPosture = currentSeatCutPosture()): SeatCutResult {
  const before = Object.keys(toolset);
  const { workTier } = posture;
  if (workTier === "work") restrictToolsetForWorkSession(toolset);
  else if (posture.jobWake === "restricted") restrictToolsetForJobWake(toolset);
  else if (posture.lean) restrictToolsetForLeanSeat(toolset, posture.dmSeat);
  if (workTier !== "forwards") {
    delete toolset[WORK_FORWARD_TOOL];
    delete toolset[WORK_CANCEL_TOOL];
  }
  if (workTier === "child") delete toolset[NATIVE_QUESTION_TOOL];
  else delete toolset[WORK_QUESTION_TOOL];

  const workerWithheld = posture.worker ? restrictToolsetForWorkerSeat(toolset) : [];
  restrictToolsetForInvokerPosture(toolset, posture.invoker, posture.worker);

  if (posture.halted) {
    for (const name of HALTED_WITHHELD_TOOLS) delete toolset[name];
  }

  if (!posture.agentAllowed) {
    delete toolset["agent"];
    for (const name of TASK_PARENT_TOOL_NAMES) delete toolset[name];
  }

  const kept = new Set(Object.keys(toolset));
  return { withheld: before.filter((name) => !kept.has(name)).sort(), workerWithheld };
}

export function seatHolds(name: string, posture: SeatCutPosture = currentSeatCutPosture()): boolean {
  const probe: Record<string, unknown> = { [name]: true };
  seatCutToolset(probe, posture);
  return name in probe;
}

/** The posture of the current wake, read from the per-wake state slots. */
export function seatCutPostureNow(): SeatCutPosture {
  return currentSeatCutPosture();
}

/**
 * eve's catalog routes. Each one reaches entries by name, and the seat cut removes each entry it
 * withholds from the step's catalog (`cutResolvedTools`), so a route reaches only what the seat
 * holds. The model-call cut therefore judges a route by its reach and never removes the route
 * itself. A restricted job wake keeps `eve__tool` because of this, and through it reaches only the
 * read ops that its cut kept.
 */
const SEAT_CUT_ROUTE_TOOLS: ReadonlySet<string> = new Set(["eve__tool", "eve__search"]);

/**
 * The names in `offered` that the seat cut withholds, for one model call. eve 1.x mounts some tools
 * outside every seat-cut slot: its own built-ins (`agent`, `ask_question`, `web_search`, `glob`,
 * `grep`, `eve__skill`, `eve__task_wait`, `eve__task_cancel`) and each declared subagent. eve offers
 * no way to take one of those off one seat's list: `disableTool()` is a build-time sentinel that
 * removes a tool for every session, and a `defineDynamic` cannot return a built-in workflow tool or a
 * provider tool. So the model wrapper (`model/seat-tool-cut.ts`) applies the same cut to the list
 * that the model call offers, as the eve 0.x projection seam did before each model call. A name that
 * a seat-cut slot mounts is already absent, so the second pass changes nothing for it.
 */
export function seatWithheldFromModelCall(offered: readonly string[], posture: SeatCutPosture = currentSeatCutPosture()): string[] {
  const stubAdded = testValveArmed("scripted-model") ? stubAddedNames() : undefined;
  const probe: Record<string, unknown> = {};
  for (const name of offered) if (!SEAT_CUT_ROUTE_TOOLS.has(name) && stubAdded?.has(name) !== true) probe[name] = true;
  const { withheld } = seatCutToolset(probe, posture);
  return [...withheld];
}

/**
 * The call-time backstop for a name that the model call did not offer. eve runs a tool call against
 * the session's whole catalog, not against the list the model saw, so a model that names a withheld
 * tool still reaches it. The root `approval` policy calls this before each call that eve passes to
 * the policy: an authored tool, a declared subagent, a connector op and the built-in `agent`. eve
 * does NOT pass a framework action (`eve__task_wait`, `eve__task_cancel`), an interaction-only tool
 * (`ask_question`), a catalog route (`eve__skill`) or a provider tool (`web_search`) to the policy.
 * For those names the model-call cut is the only enforcement.
 */
export function seatCutCallRefusal(toolName: string, posture: SeatCutPosture = currentSeatCutPosture()): string | undefined {
  if (SEAT_CUT_ROUTE_TOOLS.has(toolName) || seatHolds(toolName, posture)) return undefined;
  if (testValveArmed("scripted-model") && stubAddedNames().has(toolName)) return undefined;
  return `${toolName}: this conversation does not hold this tool. The call was NOT started. Use a tool from your tool list, or answer yourself. Do not retry this call.`;
}

const DYNAMIC_SENTINEL = Symbol.for("eve.dynamic");
const TOOL_BRAND = Symbol.for("eve:tool-brand");
const WORKFLOW_TOOL_BRAND = Symbol.for("eve:workflow-tool-brand");

function dynamicFunctionOf(value: unknown): ((ctx: unknown) => unknown) | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const fn = (value as Record<symbol, unknown>)[DYNAMIC_SENTINEL];
  return typeof fn === "function" ? (fn as (ctx: unknown) => unknown) : undefined;
}

function isSingleToolEntry(value: object): boolean {
  const branded = value as Record<symbol, unknown>;
  if (branded[TOOL_BRAND] === true || branded[WORKFLOW_TOOL_BRAND] === true) return true;
  const plain = value as Record<string, unknown>;
  return typeof plain.description === "string" || "inputSchema" in plain || typeof plain.execute === "function";
}

interface WorkerRound {
  readonly tools: Set<string>;
  readonly withheld: Set<string>;
  readonly deferred: Set<string>;
}

/** eve's catalog meta-tool that calls a deferred entry by name (`execution/catalog/catalog-tools.js`). */
const EVE_CALL_TOOL = "eve__tool";

/**
 * True when eve's step catalog admits `entry` by name through `eve__tool`. This copies eve's own test
 * (`execution/catalog/step-catalog.js#callableOf` with its `isVisible`, and
 * `catalog-tools.js#callableByName`). The entry is `deferred: true`, so the step catalog keeps it out
 * of the advertised list and `eve__tool` resolves it. On a delegated session the entry must also be
 * visible: not `rootOnly`, not `availableInSubagents: false`, and no `root-session` availability. A
 * root session sees every entry. `test:worker-toolset` §9 checks this copy against eve's `callableOf`.
 */
export function reachableThroughEveTool(entry: unknown, delegated: boolean): boolean {
  if (entry === null || typeof entry !== "object") return false;
  const e = entry as { deferred?: unknown; rootOnly?: unknown; availableInSubagents?: unknown; behavior?: { availability?: unknown } };
  if (e.deferred !== true) return false;
  if (!delegated) return true;
  if (e.rootOnly === true || e.availableInSubagents === false) return false;
  const availability = e.behavior?.availability;
  return !(Array.isArray(availability) && availability.includes("root-session"));
}

/**
 * True when eve treats the session as delegated. eve's step session takes its `rootSessionId` from the
 * parent lineage (`execution/eve-workflow-attributes.js#readParentLineage`), and only a set
 * `rootSessionId` hides an entry from the session. A worker with no parent lineage is a root session.
 */
function delegatedSession(ctx: unknown): boolean {
  const root = (ctx as { session?: { parent?: { rootSessionId?: unknown } } } | undefined)?.session?.parent?.rootSessionId;
  return typeof root === "string" && root.length > 0;
}

const MAX_WORKER_ROUNDS = 1024;

const workerRounds = new Map<string, WorkerRound>();

function sessionIdOf(ctx: unknown): string | null {
  const id = (ctx as { session?: { id?: unknown } } | undefined)?.session?.id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

function noteWorkerRound(ctx: unknown, kept: readonly string[], withheld: readonly string[], deferred: readonly string[]): void {
  const sessionId = sessionIdOf(ctx);
  if (sessionId === null) return;
  let round = workerRounds.get(sessionId);
  if (round === undefined) {
    if (workerRounds.size >= MAX_WORKER_ROUNDS) {
      const oldest = workerRounds.keys().next().value;
      if (oldest !== undefined) workerRounds.delete(oldest);
    }
    round = { tools: new Set(), withheld: new Set(), deferred: new Set() };
    workerRounds.set(sessionId, round);
  }
  for (const name of kept) round.tools.add(name);
  for (const name of withheld) round.withheld.add(name);
  for (const name of deferred) round.deferred.add(name);
}

export function recordWorkerToolset(tools: readonly string[], withheld: readonly string[], provenance?: WorkerToolsetProvenance): void {
  try {
    const who = currentWorkerToolsetIdentity();
    if (who === null) return;
    // The dedupe key holds both reach paths, so a step that opens a new connector operation (a
    // sign-in, a later listing) writes a `changed` row even when the offered list stays the same.
    const reachable = provenance?.throughEveTool;
    const key = { tools: [...tools].sort(), throughEveTool: reachable === undefined || reachable === null ? null : [...reachable].sort() };
    const reason = claimWorkerToolsetEvidence(JSON.stringify(key));
    if (reason === null) return;
    void auditWorkerToolset({ who, reason, tools, withheld, ...provenance }).catch(() => undefined);
  } catch {
  }
}

/**
 * Records the tools that one model call of a worker offers, from the call's own `tools` list
 * (`model/worker-toolset-evidence.ts` reads it). The list is the set eve sends to the model, so it
 * holds the tools eve mounts outside the seat cut too: its own `eve__*` tools, a static slot such as
 * `ask_question`, a declared subagent and a connector mount. The seat cut's round of this turn adds
 * three facts. `withheld` names what the worker subtraction and the tool transforms removed, and
 * `outsideSeatCut` names each offered tool the cut never evaluated in this turn. `throughEveTool`
 * names each deferred entry the cut mounted in this turn so far: eve keeps it out of the offered list,
 * and the worker reaches it only by name through `eve__tool`. A connector operation is such an entry.
 * The list is empty when the call does not offer `eve__tool`, because no deferred entry is then
 * reachable. With no round
 * visible, `outsideSeatCut` and `throughEveTool` are `null`, `seatCutSeen` is `false`, and
 * `withheld` is empty only because nothing is known. `refused` names each offered tool that a
 * call-time gate refuses whatever its input (the native `agent` verdict).
 */
export function recordOfferedWorkerToolset(sessionId: string | null | undefined, offered: readonly string[]): void {
  try {
    if (typeof sessionId !== "string") return;
    if (!currentWorkerWake()) return;
    const round = workerRounds.get(sessionId);
    const names = [...new Set(offered)];
    const offeredSet = new Set(names);
    const throughEveTool =
      round === undefined ? null : offeredSet.has(EVE_CALL_TOOL) ? [...round.deferred].filter((name) => !offeredSet.has(name)) : [];
    recordWorkerToolset(names, round === undefined ? [] : [...round.withheld], {
      outsideSeatCut: round === undefined ? null : names.filter((name) => !round.tools.has(name)),
      refused: names.filter((name) => nativeAgentRefusal(name) !== undefined),
      throughEveTool,
    });
  } catch {
  }
}

export function dropWorkerRound(sessionId: string | null | undefined): void {
  if (typeof sessionId === "string") workerRounds.delete(sessionId);
}

/**
 * The seat-toolset stub seam, for tests. It receives the tools that one slot resolves to, after the
 * seat cut and the transforms, and before eve mounts them. It can replace an entry or add one.
 * eve 1.x mounts every tool slot except a static one (`SEAT_CUT_STATIC_SLOTS`, which holds
 * `ask_question`) through `seatCut`, so this seam reaches each tool a seat holds from such a slot. It
 * does not reach a static slot or eve's own built-in tools (`eve__*`).
 *
 * A stub runs after the cut, so it can give a seat a tool the cut withheld. The seat cut therefore
 * calls a stub only while the `scripted-model` test valve is armed: the integration harness arms it at
 * boot, and no shipped agent code arms a valve (`test:test-valves` §4). Where the valve is armed, the
 * model is scripted too. The key is a global symbol, so the module instance that eve loads and the
 * one a test imports share one stub.
 */
export type SeatToolsetStub = (slug: string, toolset: Record<string, unknown>) => void;

const SEAT_TOOLSET_STUB = Symbol.for("open-everywhere.seat-toolset-stub");

/**
 * The names a stub ADDED to a slot's resolution while it was installed. The model-call cut
 * (`seatWithheldFromModelCall`) leaves them in place and the call-time backstop
 * (`seatCutCallRefusal`) admits them, so a stub can still give a seat a tool the cut withholds. Installing or clearing a stub empties the set. Like the stub, it acts only while the
 * `scripted-model` test valve is armed.
 */
const SEAT_TOOLSET_STUB_ADDED = Symbol.for("open-everywhere.seat-toolset-stub-added");

function stubAddedNames(): Set<string> {
  const g = globalThis as Record<symbol, unknown>;
  let names = g[SEAT_TOOLSET_STUB_ADDED];
  if (!(names instanceof Set)) {
    names = new Set<string>();
    g[SEAT_TOOLSET_STUB_ADDED] = names;
  }
  return names as Set<string>;
}

function installedSeatToolsetStub(): SeatToolsetStub | undefined {
  const stub = (globalThis as Record<symbol, unknown>)[SEAT_TOOLSET_STUB];
  return typeof stub === "function" ? (stub as SeatToolsetStub) : undefined;
}

function seatToolsetStub(): SeatToolsetStub | undefined {
  return testValveArmed("scripted-model") ? installedSeatToolsetStub() : undefined;
}

/** Installs `stub` (or clears the seam with `undefined`) and returns the stub it replaced. */
export function setSeatToolsetStubForTest(stub: SeatToolsetStub | undefined): SeatToolsetStub | undefined {
  const previous = installedSeatToolsetStub();
  const g = globalThis as Record<symbol, unknown>;
  stubAddedNames().clear();
  if (stub === undefined) delete g[SEAT_TOOLSET_STUB];
  else g[SEAT_TOOLSET_STUB] = stub;
  return previous;
}

/**
 * Replaces one tool's `execute` with `stub` for every seat that holds the tool, until the returned
 * restore runs. It chains onto the stub installed before it and swaps the tool for a copy whose
 * `execute` is the stub, so the authored entry and the transformed copy stay untouched. The stub
 * receives the arguments eve passes to the tool's `execute`: the input, then eve's tool context.
 * Restore in reverse order: each restore puts back the stub that was installed before its call.
 */
export function stubToolExecuteForTest(toolName: string, stub: (...args: unknown[]) => unknown): () => void {
  const previous = setSeatToolsetStubForTest(undefined);
  setSeatToolsetStubForTest((slug, toolset) => {
    previous?.(slug, toolset);
    const tool = toolset[toolName];
    if (tool === null || typeof tool !== "object" || typeof (tool as { execute?: unknown }).execute !== "function") return;
    const copy = Object.create(Object.getPrototypeOf(tool) as object | null, Object.getOwnPropertyDescriptors(tool)) as { execute: unknown };
    copy.execute = stub;
    toolset[toolName] = copy;
  });
  return () => {
    setSeatToolsetStubForTest(previous);
  };
}

export function cutResolvedTools(slug: string, resolved: unknown, posture: SeatCutPosture, ctx?: unknown): unknown {
  if (resolved === null || resolved === undefined || typeof resolved !== "object") return null;
  const single = isSingleToolEntry(resolved);
  const toolset: Record<string, unknown> = single ? { [slug]: resolved } : { ...(resolved as Record<string, unknown>) };
  const { workerWithheld } = seatCutToolset(toolset, posture);
  // The tool transforms (outbound filter, nullable-optional rewrite, test-run fence) run on every
  // tool the seat keeps. Each kept entry becomes a transformed copy; the authored object is shared by
  // every session and stays untouched. An outbound sink the filter cannot reach is withheld here, and
  // a worker's toolset row names it with the other withheld tools.
  const transformWithheld = transformAuthoredToolset(toolset);
  const stub = seatToolsetStub();
  if (stub !== undefined) {
    const before = new Set(Object.keys(toolset));
    stub(slug, toolset);
    for (const name of Object.keys(toolset)) if (!before.has(name)) stubAddedNames().add(name);
  }
  if (posture.worker) {
    const delegated = delegatedSession(ctx);
    const deferred = Object.entries(toolset).flatMap(([name, entry]) => (reachableThroughEveTool(entry, delegated) ? [name] : []));
    noteWorkerRound(ctx, Object.keys(toolset), [...workerWithheld, ...transformWithheld], deferred);
  }
  // A single entry stays a single entry, so eve names it by its slot. A stub that adds a tool makes
  // the result a map, and eve names each map entry by its key.
  if (single && Object.keys(toolset).every((name) => name === slug)) return toolset[slug] ?? null;
  return Object.keys(toolset).length > 0 ? toolset : null;
}

export function seatCut(slug: string, tool: unknown): unknown {
  if (tool !== null && typeof tool === "object" && (tool as Record<symbol, unknown>)[WORKFLOW_TOOL_BRAND] === true) {
    throw new Error(
      `seatCut("${slug}"): the module exports a workflow tool, and eve throws when a defineDynamic() returns a built-in workflow tool. Add the slot to SEAT_CUT_STATIC_SLOTS (access/seat-cut-slots.ts) with its reason, so the shim stays static.`,
    );
  }
  const inner = dynamicFunctionOf(tool);
  return defineDynamic(async (ctx) => {
    const resolved = inner === undefined ? tool : await inner(ctx);
    return cutResolvedTools(slug, resolved, currentSeatCutPosture(), ctx) as DynamicToolResult;
  });
}
