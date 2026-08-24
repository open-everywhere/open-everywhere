import { defineDynamic, defineTool, type ToolDefinition } from "eve/tools";

export interface GatedToolEntry {
  readonly description: string;
  readonly inputSchema: unknown;
  readonly outputSchema?: unknown;
  execute(input: any, ctx: any): any;
  readonly approval?: LooseApproval;
  toModelOutput?(output: any): any;
}

export type LooseApproval = ((ctx: any) => any) | { readonly request: (ctx: any) => any; readonly response?: (ctx: any) => any };

import { bindFrom, windowGrainOf, currentWakeId, currentWindowToken, deploymentOrg, FIRE_UNATTENDED_ATTR, type BindableContext, type WindowGrain } from "../identity/binding.js";
import { auditWindowToolGate } from "../audit/window-tool-gate.js";
import { classifySessionId } from "../channels/window-key.js";
import { registerReplayModelProjection, setVariantProjectedName } from "./untrusted-projection.js";
import { WINDOW_GATED_TOOLS, withheldFromGrain, FULL_KIT } from "./window-gate-manifest.js";
import { allowedOnRestrictedJobWake, jobFireStamped, resolveJobWakePosture } from "./job-posture.js";
import { isJobSession, jobWakeEscalated } from "./job-session-state.js";
import { allowedOnLeanSeat, resolveLeanSeatPosture } from "./lean-seat.js";
import { canDelegateFromSeat } from "./delegation-mount.js";
export { WINDOW_GATED_TOOLS, WINDOW_UNGATED_TOOLS, withheldFromGrain, checkWindowGateManifest, FULL_KIT } from "./window-gate-manifest.js";
export type { WindowToolSource } from "./window-gate-manifest.js";

export function approvalRequestOf(entry: { readonly approval?: LooseApproval }): ((ctx: any) => any) | undefined {
  const approval = entry.approval;
  if (approval === undefined) return undefined;
  if (typeof approval === "function") return approval.bind(entry);
  return approval.request.bind(approval);
}

export function approvalResponseOf(entry: { readonly approval?: LooseApproval }): ((ctx: any) => any) | undefined {
  const approval = entry.approval;
  if (approval === undefined || typeof approval === "function") return undefined;
  const response = approval.response;
  return response === undefined ? undefined : response.bind(approval);
}

function isNarrowedGrain(grain: WindowGrain): boolean {
  return !FULL_KIT.includes(grain);
}

function grainOf(ctx: BindableContext): WindowGrain {
  try {
    return windowGrainOf(ctx);
  } catch {
    return "standing";
  }
}

export function domainLabelOf(ctx: BindableContext): string {
  try {
    const raw = ctx.channel?.continuationToken ?? currentWindowToken(ctx);
    const sid = classifySessionId(raw);
    if (sid.kind === "window" || sid.kind === "task" || sid.kind === "thread-seat") return sid.key.domain;
    if (sid.kind === "container-supervisor") return sid.containerKey.length > 0 ? sid.containerKey : "unknown";
    if (typeof raw !== "string") return "unknown";
    const token = raw.startsWith("unified:") ? raw.slice("unified:".length) : raw;
    const suffix = token.lastIndexOf(":oe-sup:g");
    return suffix > 0 ? token.slice(0, suffix) : "unknown";
  } catch {
    return "unknown";
  }
}

const auditedSessions = new Set<string>();

async function auditGateOnce(ctx: BindableContext, grain: WindowGrain): Promise<void> {
  try {
    const sessionId = (ctx as { session?: { id?: string } }).session?.id ?? domainLabelOf(ctx);
    if (auditedSessions.has(sessionId)) return;
    auditedSessions.add(sessionId);
    await auditWindowToolGate({
      org: deploymentOrg(),
      domain: domainLabelOf(ctx),
      grain,
      withheld: withheldFromGrain(grain),
      wakeId: currentWakeId(ctx) ?? null,
      sessionId: (ctx as { session?: { id?: string } }).session?.id ?? null,
    });
  } catch {
  }
}

export function _resetWindowGateAuditForTest(): void {
  auditedSessions.clear();
}

function refusalFor(name: string, grain: WindowGrain): string {
  if (grain === "standing") {
    return `${name} is not available on a standing (always-on watcher) seat — hand the work to spawn_task; the worker owns the thread with the full toolset.`;
  }
  return `${name} is not available on a ${grain} session.`;
}

export async function grainBackstopAtExecute(
  name: string,
  allowed: readonly WindowGrain[],
  ctx: BindableContext,
  refusal: (grain: WindowGrain) => string = (grain) => refusalFor(name, grain),
): Promise<void> {
  const grain = grainOf(ctx);
  if (jobWakeWithholds(name, ctx)) {
    await auditWindowToolGate({
      org: deploymentOrg(),
      domain: domainLabelOf(ctx),
      grain,
      withheld: [name],
      wakeId: currentWakeId(ctx) ?? null,
      sessionId: (ctx as { session?: { id?: string } }).session?.id ?? null,
      reason: "job-wake",
    }).catch(() => undefined);
    throw new Error(
      `${name} is not available on an un-escalated durable-job fire — a job runs on its own schedule with nobody in the room, so it keeps reads, its replies and its own progress ledger. Report what you found and record it with record_job_state; a person in this thread can take the step that needs ${name}.`,
    );
  }
  if (leanSeatWithholds(name, ctx)) {
    await auditWindowToolGate({
      org: deploymentOrg(),
      domain: domainLabelOf(ctx),
      grain,
      withheld: [name],
      wakeId: currentWakeId(ctx) ?? null,
      sessionId: (ctx as { session?: { id?: string } }).session?.id ?? null,
      reason: "lean-seat",
    }).catch(() => undefined);
    throw new Error(
      `${name} is not held by this conversational seat — this seat talks and delegates. Hand the work to a worker (\`agent\`, or \`spawn_thread_session\` for anything long): the worker holds the full kit, and its result comes back to you to relay.`,
    );
  }
  if (allowed.includes(grain)) return;
  await auditWindowToolGate({
    org: deploymentOrg(),
    domain: domainLabelOf(ctx),
    grain,
    withheld: [name],
    wakeId: currentWakeId(ctx) ?? null,
    sessionId: (ctx as { session?: { id?: string } }).session?.id ?? null,
  }).catch(() => undefined);
  throw new Error(refusal(grain));
}

function isDmFamilySeat(ctx: BindableContext): boolean {
  try {
    const mode = bindFrom(ctx).mode;
    return mode === "dm" || mode === "mpim";
  } catch {
    return false;
  }
}

function leanSeatWithholds(name: string, ctx: BindableContext): boolean {
  try {
    if (allowedOnLeanSeat(name, isDmFamilySeat(ctx))) return false;
    const attrs = ctx.session?.auth?.current?.attributes;
    const v = attrs?.[FIRE_UNATTENDED_ATTR];
    const unattended = (typeof v === "string" ? v : Array.isArray(v) ? v[0] : undefined) === "true";
    if (unattended || jobFireStamped(attrs)) return false;
    const posture = resolveLeanSeatPosture({ grain: grainOf(ctx), canDelegate: canDelegateFromSeat(ctx), unattendedFire: false });
    return posture === "lean";
  } catch {
    return false;
  }
}

function jobWakeWithholds(name: string, ctx: BindableContext): boolean {
  try {
    const attrs = ctx.session?.auth?.current?.attributes ?? ctx.session?.auth?.initiator?.attributes;
    const posture = resolveJobWakePosture({
      jobFire: jobFireStamped(attrs),
      jobSession: isJobSession(),
      humanPrincipal: jobWakeEscalated(),
    });
    return posture === "restricted" && !allowedOnRestrictedJobWake(name);
  } catch {
    return false;
  }
}

function gatedExecute(name: string, entry: GatedToolEntry): (input: unknown, ctx: unknown) => Promise<unknown> {
  return async (input: unknown, ctx: unknown) => {
    await grainBackstopAtExecute(name, WINDOW_GATED_TOOLS[name] ?? [], ctx as BindableContext);
    return entry.execute(input, ctx);
  };
}

const STEP_REGISTRY_KEY = Symbol.for("@workflow/core//registeredSteps");

function stepRegistry(): Map<string, unknown> {
  const g = globalThis as Record<symbol, unknown>;
  let reg = g[STEP_REGISTRY_KEY] as Map<string, unknown> | undefined;
  if (reg === undefined) {
    reg = new Map();
    g[STEP_REGISTRY_KEY] = reg;
  }
  return reg;
}

export function replayStepNames(slug: string, entryKey: string): { execute: string; approval: string; approvalResponse: string; toModelOutput: string } {
  return {
    execute: `eve:framework-dynamic:${slug}:${entryKey}`,
    approval: `eve:dynamic-tool-approval:${slug}:${entryKey}`,
    approvalResponse: `eve:dynamic-tool-approval-response:${slug}:${entryKey}`,
    toModelOutput: `eve:dynamic-tool-model-output:${slug}:${entryKey}`,
  };
}

const DURABLE_TOOL_CALLBACKS = Symbol.for("eve:durable-dynamic-tool-callbacks");

type ReplayCallback = (closure: Record<string, never>, ...args: never[]) => unknown;

type CallbackPhase = "approvalRequest" | "approvalResponse" | "execute" | "toModelOutput";

interface DurableCallbackReference {
  readonly callback: ReplayCallback;
  readonly closure: Record<string, never>;
}

function isDurableClosureSerializable(value: unknown, seen: WeakSet<object> = new WeakSet()): boolean {
  if (value === null || typeof value === "boolean" || typeof value === "string") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((item) => isDurableClosureSerializable(item, seen));
  if (typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  if (proto !== null && proto !== Object.prototype) return false;
  if (seen.has(value)) return false;
  seen.add(value);
  for (const item of Object.values(value)) {
    if (item === undefined) continue;
    if (!isDurableClosureSerializable(item, seen)) return false;
  }
  seen.delete(value);
  return true;
}

function fillDurableCallbackDescriptors(
  entry: ReplayableToolEntry,
  callbacks: Partial<Record<CallbackPhase, ReplayCallback>>,
  options: { readonly closure?: Record<string, string>; readonly overwrite?: boolean } = {},
): void {
  const holder = entry as unknown as Record<symbol, unknown>;
  const existing = (holder[DURABLE_TOOL_CALLBACKS] as Record<string, DurableCallbackReference | undefined> | undefined) ?? {};
  const next: Record<string, DurableCallbackReference> = {};
  for (const [phase, reference] of Object.entries(existing)) if (reference !== undefined) next[phase] = reference;
  const closure = (options.closure ?? {}) as Record<string, never>;
  for (const [phase, callback] of Object.entries(callbacks)) {
    if (callback === undefined) continue;
    const held = next[phase];
    if (held !== undefined && options.overwrite !== true) {
      if (isDurableClosureSerializable(held.closure)) continue;
      console.error(
        `[open-everywhere:dynamic-tools] the build transform's "${phase}" descriptor carries a non-serializable ` +
          "capture, which eve would refuse — taking the slot back with an empty closure. Hoist the callback out of " +
          "the defineTool literal into a module-level factory (OPE-1063; see scripts/dynamic-callback-closure-bundle-test.ts).",
      );
    }
    next[phase] = { callback, closure: { ...closure } };
  }
  Object.defineProperty(holder, DURABLE_TOOL_CALLBACKS, { configurable: true, value: next });
}

export interface ReplayableToolEntry {
  execute(input: any, ctx: any): any;
  readonly approval?: LooseApproval;
  toModelOutput?(output: any): any;
}

const MOUNTED_ENTRIES = new Map<string, { readonly entries: Set<ReplayableToolEntry>; variantManaged: boolean }>();

function mountedNameOf(slug: string, entryKey: string): string {
  return entryKey.startsWith("_") ? slug : entryKey;
}

function claimMountedName(mountedName: string, entry: ReplayableToolEntry, variantManaged: boolean): void {
  const held = MOUNTED_ENTRIES.get(mountedName);
  if (held === undefined) {
    MOUNTED_ENTRIES.set(mountedName, { entries: new Set([entry]), variantManaged });
    return;
  }
  held.entries.add(entry);
  if (variantManaged) held.variantManaged = true;
}

export interface MountedEntryCollision {
  readonly name: string;
  readonly entryCount: number;
  readonly variantManaged: boolean;
  readonly distinctExecuteCallbacks: number;
}

export function mountedEntryCollisions(): MountedEntryCollision[] {
  const out: MountedEntryCollision[] = [];
  for (const [name, held] of MOUNTED_ENTRIES) {
    if (held.entries.size < 2) continue;
    const callbacks = new Set<unknown>();
    for (const entry of held.entries) {
      const described = (entry as unknown as Record<symbol, unknown>)[DURABLE_TOOL_CALLBACKS] as
        | Record<string, DurableCallbackReference | undefined>
        | undefined;
      callbacks.add(described?.execute?.callback);
    }
    out.push({ distinctExecuteCallbacks: callbacks.size, entryCount: held.entries.size, name, variantManaged: held.variantManaged });
  }
  return out;
}

export function preRegisterDynamicVariants(mountedName: string, variants: Readonly<Record<string, ReplayableToolEntry>>): void {
  const entryKeys = Object.keys(variants);
  if (entryKeys.length < 2) {
    throw new Error(`preRegisterDynamicVariants("${mountedName}"): needs at least two variants — use preRegisterDynamicEntry for one.`);
  }
  installVariants(mountedName, variants);
}

const INCREMENTAL_VARIANTS = new Map<string, Record<string, ReplayableToolEntry>>();

export function registerDynamicVariant(mountedName: string, entryKey: string, entry: ReplayableToolEntry): void {
  const held = INCREMENTAL_VARIANTS.get(mountedName) ?? {};
  held[entryKey] = entry;
  INCREMENTAL_VARIANTS.set(mountedName, held);
  installVariants(mountedName, held);
}

export function _resetDynamicVariantsForTest(): void {
  INCREMENTAL_VARIANTS.clear();
}

function installVariants(mountedName: string, variants: Readonly<Record<string, ReplayableToolEntry>>): void {
  const entryKeys = Object.keys(variants);
  const pick = (closure: unknown): { entryKey: string; entry: ReplayableToolEntry } => {
    const entryKey = (closure as { entryKey?: unknown } | undefined)?.entryKey;
    if (typeof entryKey !== "string" || variants[entryKey] === undefined) {
      throw new Error(
        `Dynamic tool "${mountedName}" was replayed with no variant key in its durable closure (got ${JSON.stringify(entryKey)}). ` +
          `Its metadata predates the variant dispatcher and cannot say which implementation the session mounted. Start a new session.`,
      );
    }
    return { entry: variants[entryKey], entryKey };
  };
  const shared: Partial<Record<CallbackPhase, ReplayCallback>> = {};
  shared.execute = ((closure: unknown, input: unknown, ctx: unknown) => pick(closure).entry.execute(input, ctx)) as ReplayCallback;
  const hasApprovalRequest = entryKeys.some((k) => approvalRequestOf(variants[k]) !== undefined);
  const hasApprovalResponse = entryKeys.some((k) => approvalResponseOf(variants[k]) !== undefined);
  if (hasApprovalRequest) {
    shared.approvalRequest = ((closure: unknown, actx: unknown) => {
      const { entry, entryKey } = pick(closure);
      const request = approvalRequestOf(entry);
      if (request === undefined) throw new Error(`Dynamic tool "${mountedName}" variant "${entryKey}" has no approval request policy.`);
      return request(actx);
    }) as ReplayCallback;
  }
  if (hasApprovalResponse) {
    shared.approvalResponse = ((closure: unknown, rctx: unknown) => {
      const { entry, entryKey } = pick(closure);
      const response = approvalResponseOf(entry);
      if (response === undefined) throw new Error(`Dynamic tool "${mountedName}" variant "${entryKey}" has no approval response policy.`);
      return response(rctx);
    }) as ReplayCallback;
  }
  const hasModelOutput = entryKeys.some((k) => typeof variants[k].toModelOutput === "function");
  if (hasModelOutput) {
    shared.toModelOutput = ((closure: unknown, out: unknown) => {
      const { entry, entryKey } = pick(closure);
      const project = entry.toModelOutput;
      if (typeof project !== "function") throw new Error(`Dynamic tool "${mountedName}" variant "${entryKey}" authors no toModelOutput.`);
      return project.call(entry, out);
    }) as ReplayCallback;
  }
  setVariantProjectedName(mountedName, entryKeys.length > 0 && entryKeys.every((k) => typeof variants[k].toModelOutput === "function"));
  const reg = stepRegistry();
  for (const entryKey of entryKeys) {
    const entry = variants[entryKey];
    const names = replayStepNames(mountedName, entryKey);
    reg.set(names.execute, ((_cv: unknown, input: unknown, ctx: unknown) => entry.execute(input, ctx)) as ReplayCallback);
    const approval = approvalRequestOf(entry);
    if (approval !== undefined) reg.set(names.approval, ((_cv: unknown, actx: unknown) => approval(actx)) as ReplayCallback);
    const approvalResponse = approvalResponseOf(entry);
    if (approvalResponse !== undefined) reg.set(names.approvalResponse, ((_cv: unknown, rctx: unknown) => approvalResponse(rctx)) as ReplayCallback);
    const project = entry.toModelOutput;
    if (typeof project === "function") reg.set(names.toModelOutput, ((_cv: unknown, out: unknown) => project.call(entry, out)) as ReplayCallback);
    const own: Partial<Record<CallbackPhase, ReplayCallback>> = { execute: shared.execute };
    if (approval !== undefined) own.approvalRequest = shared.approvalRequest;
    if (approvalResponse !== undefined) own.approvalResponse = shared.approvalResponse;
    if (typeof project === "function") own.toModelOutput = shared.toModelOutput;
    fillDurableCallbackDescriptors(entry, own, { closure: { entryKey }, overwrite: true });
    claimMountedName(mountedName, entry, true);
  }
}

export function preRegisterDynamicEntry(slug: string, entryKey: string, entry: ReplayableToolEntry): void {
  const names = replayStepNames(slug, entryKey);
  const reg = stepRegistry();
  claimMountedName(mountedNameOf(slug, entryKey), entry, false);
  const callbacks: Partial<Record<CallbackPhase, ReplayCallback>> = {};
  callbacks.execute = ((_cv: unknown, input: unknown, ctx: unknown) => entry.execute(input, ctx)) as ReplayCallback;
  reg.set(names.execute, callbacks.execute);
  const approval = approvalRequestOf(entry);
  if (approval !== undefined) {
    callbacks.approvalRequest = ((_cv: unknown, actx: unknown) => approval(actx)) as ReplayCallback;
    reg.set(names.approval, callbacks.approvalRequest);
  }
  const approvalResponse = approvalResponseOf(entry);
  if (approvalResponse !== undefined) {
    callbacks.approvalResponse = ((_cv: unknown, rctx: unknown) => approvalResponse(rctx)) as ReplayCallback;
    reg.set(names.approvalResponse, callbacks.approvalResponse);
  }
  if (typeof entry.toModelOutput === "function") {
    registerReplayModelProjection(mountedNameOf(slug, entryKey), entry.toModelOutput.bind(entry));
    callbacks.toModelOutput = ((_cv: unknown, out: unknown) => (entry.toModelOutput as (o: unknown) => unknown)(out)) as ReplayCallback;
    reg.set(names.toModelOutput, callbacks.toModelOutput);
  }
  fillDurableCallbackDescriptors(entry, callbacks);
}

function armEntry(name: string, entry: GatedToolEntry): GatedToolEntry {
  return defineTool({ ...entry, execute: gatedExecute(name, entry) } as unknown as ToolDefinition) as unknown as GatedToolEntry;
}

export function windowGated(name: string, entry: GatedToolEntry, mountGate?: (ctx: BindableContext) => boolean): unknown {
  const grains = WINDOW_GATED_TOOLS[name];
  if (grains === undefined) {
    throw new Error(`windowGated("${name}"): not in WINDOW_GATED_TOOLS — add the kit row (the table is the single source of truth)`);
  }
  const armed = armEntry(name, entry);
  preRegisterDynamicEntry(name, "_single", armed);
  const dyn = defineDynamic({
    events: {
      "session.started": async (_event, ctx) => {
        const c = ctx as BindableContext;
        const grain = grainOf(c);
        if (!grains.includes(grain)) {
          if (isNarrowedGrain(grain)) await auditGateOnce(c, grain);
          return null;
        }
        if (mountGate && !mountGate(c)) return null;
        return armed;
      },
    },
  });
  return dyn;
}

export function windowGatedKit(
  slug: string,
  entries: Readonly<Record<string, GatedToolEntry>>,
  mountGates: Readonly<Record<string, (ctx: BindableContext) => boolean>> = {},
): unknown {
  const armed: Record<string, GatedToolEntry> = {};
  for (const [name, entry] of Object.entries(entries)) {
    if (WINDOW_GATED_TOOLS[name] === undefined) {
      throw new Error(`windowGatedKit("${slug}"): "${name}" is not in WINDOW_GATED_TOOLS — add the kit row`);
    }
    armed[name] = armEntry(name, entry);
    preRegisterDynamicEntry(slug, name, armed[name]);
  }
  for (const name of Object.keys(mountGates)) {
    if (armed[name] === undefined) {
      throw new Error(`windowGatedKit("${slug}"): mountGates names "${name}", which is not a key of this kit — a predicate on a name the kit doesn't provide gates nothing (fix the name)`);
    }
  }
  return defineDynamic({
    events: {
      "session.started": async (_event, ctx) => {
        const c = ctx as BindableContext;
        const grain = grainOf(c);
        const mounted: Record<string, GatedToolEntry> = {};
        let withheldAny = false;
        for (const name of Object.keys(armed)) {
          if (!WINDOW_GATED_TOOLS[name].includes(grain)) { withheldAny = true; continue; }
          const gate = mountGates[name];
          if (gate && !gate(c)) continue;
          mounted[name] = armed[name];
        }
        if (withheldAny && isNarrowedGrain(grain)) await auditGateOnce(c, grain);
        return Object.keys(mounted).length > 0 ? mounted : null;
      },
    },
  });
}

export async function resolveWindowGated(gated: unknown, ctx: BindableContext): Promise<unknown> {
  const resolver = (gated as { events?: Record<string, (event: unknown, ctx: unknown) => unknown> }).events?.["session.started"];
  if (typeof resolver !== "function") throw new Error("resolveWindowGated: not a windowGated dynamic tool");
  return await resolver({ type: "session.started" }, ctx);
}
