import { defineDynamic, defineTool, type ToolDefinition } from "eve/tools";

export interface GatedToolEntry {
  readonly description: string;
  readonly inputSchema: unknown;
  readonly outputSchema?: unknown;
  execute(input: any, ctx: any): any;
  approval?(ctx: any): any;
  toModelOutput?(output: any): any;
}
import { windowGrainOf, currentWakeId, deploymentOrg, type BindableContext, type WindowGrain } from "../identity/binding.js";
import { auditWindowToolGate } from "../audit/window-tool-gate.js";
import { parseWindowToken } from "../channels/window-key.js";
import { WINDOW_GATED_TOOLS, withheldFromGrain, FULL_KIT } from "./window-gate-manifest.js";
export { WINDOW_GATED_TOOLS, WINDOW_UNGATED_TOOLS, withheldFromGrain, checkWindowGateManifest, FULL_KIT } from "./window-gate-manifest.js";
export type { WindowToolSource } from "./window-gate-manifest.js";

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

function domainLabelOf(ctx: BindableContext): string {
  try {
    const raw = ctx.channel?.continuationToken;
    if (typeof raw !== "string") return "unknown";
    const token = raw.startsWith("unified:") ? raw.slice("unified:".length) : raw;
    const parsed = parseWindowToken(token);
    if (parsed) return parsed.domain;
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

export function replayStepNames(slug: string, entryKey: string): { execute: string; approval: string } {
  return {
    execute: `eve:framework-dynamic:${slug}:${entryKey}`,
    approval: `eve:dynamic-tool-approval:${slug}:${entryKey}`,
  };
}

function preRegisterReplay(slug: string, entryKey: string, entry: GatedToolEntry): void {
  const names = replayStepNames(slug, entryKey);
  const reg = stepRegistry();
  reg.set(names.execute, (_cv: unknown, input: unknown, ctx: unknown) => entry.execute(input, ctx));
  const approval = entry.approval?.bind(entry);
  if (approval !== undefined) {
    reg.set(names.approval, (_cv: unknown, actx: unknown) => approval(actx));
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
  preRegisterReplay(name, "_single", armed);
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

export function windowGatedKit(slug: string, entries: Readonly<Record<string, GatedToolEntry>>): unknown {
  const armed: Record<string, GatedToolEntry> = {};
  for (const [name, entry] of Object.entries(entries)) {
    if (WINDOW_GATED_TOOLS[name] === undefined) {
      throw new Error(`windowGatedKit("${slug}"): "${name}" is not in WINDOW_GATED_TOOLS — add the kit row`);
    }
    armed[name] = armEntry(name, entry);
    preRegisterReplay(slug, name, armed[name]);
  }
  return defineDynamic({
    events: {
      "session.started": async (_event, ctx) => {
        const c = ctx as BindableContext;
        const grain = grainOf(c);
        const mounted: Record<string, GatedToolEntry> = {};
        let withheldAny = false;
        for (const name of Object.keys(armed)) {
          if (WINDOW_GATED_TOOLS[name].includes(grain)) mounted[name] = armed[name];
          else withheldAny = true;
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
