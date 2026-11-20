import { defineDynamic, defineTool, type DynamicContext, type DynamicToolResult, type ToolDefinition } from "eve/tools";

/* eslint-disable @typescript-eslint/no-explicit-any */
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
import { classifySessionId, stripUnifiedSendPrefix } from "../channels/window-key.js";
import { setVariantProjectedName } from "./connector-result-fence.js";
import { WINDOW_GATED_TOOLS, withheldFromGrain, fullKit } from "./window-gate-manifest.js";
import { allowedOnRestrictedJobWake, jobFireStamped, resolveJobWakePosture } from "./job-posture.js";
import { isJobSession, jobWakeEscalated } from "./job-session-state.js";
import { allowedOnLeanSeat, resolveLeanSeatPosture } from "./lean-seat.js";
import { canDelegateFromSeat } from "./delegation-mount.js";
export { WINDOW_GATED_TOOLS, withheldFromGrain, fullKit } from "./window-gate-manifest.js";
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
  return !fullKit().includes(grain);
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
    if (sid.kind === "window" || sid.kind === "task" || sid.kind === "thread-seat" || sid.kind === "work") return sid.key.domain;
    if (sid.kind === "container-supervisor") return sid.containerKey.length > 0 ? sid.containerKey : "unknown";
    if (typeof raw !== "string") return "unknown";
    const token = stripUnifiedSendPrefix(raw);
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
    return (
      `${name} is not available on a standing (always-on watcher) seat — a worker runs it with ` +
      "the full toolset. Hand it to one if this seat holds a delegation verb; if it holds none, say " +
      "so rather than trying."
    );
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
    throw new Error(leanSeatRefusal(name, grain));
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

export interface MountedToolEntry {
  execute(input: any, ctx: any): any;
  readonly approval?: LooseApproval;
  toModelOutput?(output: any): any;
}

const MOUNTED_ENTRIES = new Map<string, Set<MountedToolEntry>>();

function mountedNameOf(slug: string, entryKey: string): string {
  return entryKey.startsWith("_") ? slug : entryKey;
}

function claimMountedName(mountedName: string, entry: MountedToolEntry): void {
  const held = MOUNTED_ENTRIES.get(mountedName);
  if (held === undefined) MOUNTED_ENTRIES.set(mountedName, new Set([entry]));
  else held.add(entry);
}

export function registeredMountedEntries(): ReadonlyMap<string, ReadonlySet<MountedToolEntry>> {
  return new Map(MOUNTED_ENTRIES);
}

export function authoredModelProjectionFor(mountedName: string): ((output: unknown) => unknown) | undefined {
  const held = MOUNTED_ENTRIES.get(mountedName);
  if (held === undefined) return undefined;
  if (held.size !== 1) {
    throw new Error(
      `authoredModelProjectionFor("${mountedName}"): ${held.size} entries mount under this name — a variant family has no single projection to return.`,
    );
  }
  const [entry] = held;
  const project = entry?.toModelOutput;
  if (typeof project !== "function") return undefined;
  return (output: unknown) => project(output);
}

export function registerMountedEntry(slug: string, entryKey: string, entry: MountedToolEntry): void {
  const mountedName = mountedNameOf(slug, entryKey);
  claimMountedName(mountedName, entry);
}

function registerMountedVariants(mountedName: string, variants: Readonly<Record<string, MountedToolEntry>>): void {
  if (Object.keys(variants).length < 2) {
    throw new Error(`registerMountedVariants("${mountedName}"): needs at least two variants — use registerMountedEntry for one.`);
  }
  installVariants(mountedName, variants);
}

const INCREMENTAL_VARIANTS = new Map<string, Record<string, MountedToolEntry>>();

export function registerMountedVariant(mountedName: string, entryKey: string, entry: MountedToolEntry): void {
  const held = INCREMENTAL_VARIANTS.get(mountedName) ?? {};
  held[entryKey] = entry;
  INCREMENTAL_VARIANTS.set(mountedName, held);
  installVariants(mountedName, held);
}

export function _resetMountedVariantsForTest(): void {
  INCREMENTAL_VARIANTS.clear();
}

function installVariants(mountedName: string, variants: Readonly<Record<string, MountedToolEntry>>): void {
  const entries = Object.values(variants);
  setVariantProjectedName(mountedName, entries.length > 0 && entries.every((entry) => typeof entry.toModelOutput === "function"));
  for (const entry of entries) claimMountedName(mountedName, entry);
}

type Memo = DynamicContext["memo"];

const DYNAMIC_FUNCTION = Symbol.for("eve.dynamic");

function sessionIdOf(ctx: unknown): string | null {
  const id = (ctx as { session?: { id?: unknown } } | undefined)?.session?.id;
  return typeof id === "string" ? id : null;
}

export function seatMemoKey(ctx: unknown): readonly unknown[] {
  return ["seat", sessionIdOf(ctx)];
}

export function turnMemoKey(ctx: unknown): readonly unknown[] {
  const turnId = (ctx as { turn?: { id?: unknown } | null } | undefined)?.turn?.id;
  return ["turn", sessionIdOf(ctx), typeof turnId === "string" ? turnId : null];
}

export async function memoized<T>(ctx: unknown, key: unknown, fn: () => T | Promise<T>): Promise<T> {
  const memo = (ctx as { memo?: Memo } | undefined)?.memo;
  if (typeof memo !== "function") return await fn();
  return await memo(key, () => fn());
}

function seatDecision<T>(ctx: unknown, fn: () => T): T | Promise<Awaited<T>> {
  const memo = (ctx as { memo?: Memo } | undefined)?.memo;
  if (typeof memo !== "function") return fn();
  return memo(seatMemoKey(ctx), async () => await fn()) as Promise<Awaited<T>>;
}

function thenOrNow<T, R>(value: T | Promise<T>, next: (resolved: T) => R): R | Promise<R> {
  return value instanceof Promise ? value.then(next) : next(value);
}

function dynamicFunctionOf(sentinel: unknown): (ctx: unknown) => unknown {
  const fn = typeof sentinel === "object" && sentinel !== null ? (sentinel as Record<symbol, unknown>)[DYNAMIC_FUNCTION] : undefined;
  if (typeof fn !== "function") throw new Error("evaluateDynamic: not a defineDynamic() value");
  return fn as (ctx: unknown) => unknown;
}

export async function evaluateDynamic(sentinel: unknown, ctx: unknown): Promise<unknown> {
  return await dynamicFunctionOf(sentinel)(ctx);
}

export function _dynamicResolverForTest(sentinel: unknown): (event: unknown, ctx: unknown) => any {
  const fn = dynamicFunctionOf(sentinel);
  return (_event, ctx) => fn(ctx);
}

export function sessionMountedTool(
  slug: string,
  entry: MountedToolEntry,
  mount?: (ctx: BindableContext) => boolean | Promise<boolean>,
): unknown {
  registerMountedEntry(slug, "_single", entry);
  const mounted = entry as unknown as DynamicToolResult;
  return defineDynamic((ctx) => {
    if (mount === undefined) return mounted;
    return thenOrNow(
      seatDecision(ctx, () => thenOrNow(mount(ctx as unknown as BindableContext), (allowed) => allowed === true)),
      (allowed) => (allowed ? mounted : null),
    );
  });
}

export function sessionVariantTool(
  mountedName: string,
  variants: Readonly<Record<string, MountedToolEntry>>,
  pick: (ctx: BindableContext) => string | null,
): unknown {
  registerMountedVariants(mountedName, variants);
  return defineDynamic((ctx) =>
    thenOrNow(seatDecision(ctx, () => pick(ctx as unknown as BindableContext)), (key) => {
      if (key === null) return null;
      const entry = variants[key];
      if (entry === undefined) throw new Error(`Dynamic tool "${mountedName}" has no variant "${key}".`);
      return entry as unknown as DynamicToolResult;
    }),
  );
}

function armEntry(name: string, entry: GatedToolEntry): GatedToolEntry {
  return defineTool({ ...entry, execute: gatedExecute(name, entry) } as unknown as ToolDefinition) as unknown as GatedToolEntry;
}

export function windowGated(name: string, entry: GatedToolEntry, mountGate?: (ctx: BindableContext) => boolean): unknown {
  if (WINDOW_GATED_TOOLS[name] === undefined) {
    throw new Error(`windowGated("${name}"): not in WINDOW_GATED_TOOLS — add the kit row (the table is the single source of truth)`);
  }
  const armed = armEntry(name, entry);
  registerMountedEntry(name, "_single", armed);
  return defineDynamic(async (ctx) => {
    const seat = await memoized(ctx, seatMemoKey(ctx), async () => {
      const c = ctx as unknown as BindableContext;
      const grain = grainOf(c);
      if (!WINDOW_GATED_TOOLS[name].includes(grain)) {
        if (isNarrowedGrain(grain)) await auditGateOnce(c, grain);
        return { grain, mounted: false };
      }
      return { grain, mounted: !(mountGate && !mountGate(c)) };
    });
    return seat.mounted && WINDOW_GATED_TOOLS[name].includes(seat.grain) ? (armed as unknown as DynamicToolResult) : null;
  });
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
    registerMountedEntry(slug, name, armed[name]);
  }
  for (const name of Object.keys(mountGates)) {
    if (armed[name] === undefined) {
      throw new Error(`windowGatedKit("${slug}"): mountGates names "${name}", which is not a key of this kit — a predicate on a name the kit doesn't provide gates nothing (fix the name)`);
    }
  }
  return defineDynamic(async (ctx) => {
    const seat = await memoized(ctx, seatMemoKey(ctx), async () => {
      const c = ctx as unknown as BindableContext;
      const grain = grainOf(c);
      const kept: string[] = [];
      let withheldAny = false;
      for (const name of Object.keys(armed)) {
        if (!WINDOW_GATED_TOOLS[name].includes(grain)) {
          withheldAny = true;
          continue;
        }
        const gate = mountGates[name];
        if (gate && !gate(c)) continue;
        kept.push(name);
      }
      if (withheldAny && isNarrowedGrain(grain)) await auditGateOnce(c, grain);
      return { grain, names: kept };
    });
    const mounted: Record<string, GatedToolEntry> = {};
    for (const name of seat.names) {
      if (armed[name] !== undefined && WINDOW_GATED_TOOLS[name].includes(seat.grain)) mounted[name] = armed[name];
    }
    return Object.keys(mounted).length > 0 ? (mounted as unknown as DynamicToolResult) : null;
  });
}

export async function resolveWindowGated(gated: unknown, ctx: BindableContext): Promise<unknown> {
  return await evaluateDynamic(gated, ctx);
}

export function leanSeatRefusal(name: string, grain: string): string {
  const handOff =
    grain === "thread"
      ? "Hand the job to a worker (`agent`) and relay its result: this thread's task runs through your own work session."
      : "Hand the job to a worker (`agent`) and relay its result, or, when the task needs real orchestration, hand the whole task to a thread session (`spawn_thread_session`) as your Routing section says.";
  return `${name} is not held by this conversational seat — this seat talks and delegates. ${handOff} A worker holds the full kit.`;
}
