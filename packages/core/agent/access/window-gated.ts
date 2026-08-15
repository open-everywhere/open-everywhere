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

import { bindFrom, windowGrainOf, currentWakeId, deploymentOrg, FIRE_UNATTENDED_ATTR, type BindableContext, type WindowGrain } from "../identity/binding.js";
import { auditWindowToolGate } from "../audit/window-tool-gate.js";
import { classifySessionId } from "../channels/window-key.js";
import { registerReplayModelProjection } from "./untrusted-projection.js";
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
    const raw = ctx.channel?.continuationToken;
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

export function replayStepNames(slug: string, entryKey: string): { execute: string; approval: string; approvalResponse: string } {
  return {
    execute: `eve:framework-dynamic:${slug}:${entryKey}`,
    approval: `eve:dynamic-tool-approval:${slug}:${entryKey}`,
    approvalResponse: `eve:dynamic-tool-approval-response:${slug}:${entryKey}`,
  };
}

export interface ReplayableToolEntry {
  execute(input: any, ctx: any): any;
  readonly approval?: LooseApproval;
  toModelOutput?(output: any): any;
}

export function preRegisterDynamicEntry(slug: string, entryKey: string, entry: ReplayableToolEntry): void {
  const names = replayStepNames(slug, entryKey);
  const reg = stepRegistry();
  reg.set(names.execute, (_cv: unknown, input: unknown, ctx: unknown) => entry.execute(input, ctx));
  const approval = approvalRequestOf(entry);
  if (approval !== undefined) {
    reg.set(names.approval, (_cv: unknown, actx: unknown) => approval(actx));
  }
  const approvalResponse = approvalResponseOf(entry);
  if (approvalResponse !== undefined) {
    reg.set(names.approvalResponse, (_cv: unknown, rctx: unknown) => approvalResponse(rctx));
  }
  (entry as unknown as Record<string, unknown>).__executeStepFn = { stepId: names.execute };
  (entry as unknown as Record<string, unknown>).__closureVars = {};
  if (typeof entry.toModelOutput === "function") {
    const mountedName = entryKey.startsWith("_") ? slug : entryKey;
    registerReplayModelProjection(mountedName, entry.toModelOutput.bind(entry));
  }
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
