import { getConfig } from "../access/config.js";
import { resolveAccess, type EffectiveAccess, type ResolveRequest } from "../access/resolver.js";
import { scopeGrantsRead } from "../access/read-grant.js";
import type { Partition } from "../memory/partition.js";
import { admitProviderRegistration } from "../access/provider-selection.js";
import { innermostScope, type NormalizedEvent, type ScopeStep } from "./event-model.js";
import { webhookScheme } from "./scheme-name.js";
import { routinePartition } from "./partition.js";
import type { Routine } from "./routine.js";

export interface EventScopeGrant {
  readonly source: string;
  readonly provider?: string;
  grantsRead(scope: readonly ScopeStep[], access: EffectiveAccess): boolean;
}

const GRANTS = new Map<string, EventScopeGrant>();

export function registerEventScopeGrant(grant: EventScopeGrant): boolean {
  if (grant.provider !== undefined && !admitProviderRegistration(grant.provider, "event-scope-grant")) return false;
  GRANTS.set(grant.source, grant);
  return true;
}

export function eventScopeGrant(source: string | undefined): EventScopeGrant | undefined {
  return source === undefined ? undefined : GRANTS.get(source);
}

export function registeredEventGrantSources(): readonly string[] {
  return [...GRANTS.keys()].sort();
}

export function resetEventScopeGrantsForTest(): void {
  GRANTS.clear();
}

export type EventGrantVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "no-grant-adapter" | "no-scope" | "unresolvable" | "refused"; readonly partition?: string };

export interface EventGrantDeps {
  readonly resolve?: (p: Partition) => EffectiveAccess;
}

export function requestForPartition(p: Partition): ResolveRequest {
  return {
    mode: "channel",
    platform: p.platform,
    workspace: p.workspace,
    channel: p.surface,
    domains: getConfig().domainsForSurface({ workspaceKey: p.workspaceKey, surface: p.surface }),
  };
}

export function resolveAccessForPartition(p: Partition): EffectiveAccess {
  const cfg = getConfig();
  return resolveAccess(requestForPartition(p), cfg.loadBundles(), cfg.loadBindings(), cfg.pluginRegistry, cfg.loadProviders?.() ?? []);
}

export function eventGrantPartitions(r: Routine): readonly Partition[] {
  const own = routinePartition(r);
  const report = r.report;
  if (report === undefined) return [own];
  switch (report.kind) {
    case "silent":
      return [own];
    case "surface":
      return [own, routinePartition({ org: r.org, surfaceKey: report.surfaceKey })];
    default: {
      const exhaustive: never = report;
      throw new Error(
        `unhandled RoutineReport kind "${String((exhaustive as { kind?: unknown }).kind)}" — a report arm that names its OWN destination must contribute ` +
          "that destination's partition here, or the event read-grant check would authorize delivery into a room on the " +
          "strength of a different domain's grant.",
      );
    }
  }
}

export function checkEventReadGrant(
  ev: NormalizedEvent,
  partitions: readonly Partition[],
  deps: EventGrantDeps = {},
): EventGrantVerdict {
  const declared = ev.readableBy;
  const adapter = declared ? undefined : eventScopeGrant(webhookScheme(ev));
  if (!declared && !adapter) return { ok: false, reason: "no-grant-adapter" };
  if (!innermostScope(ev.scope)) return { ok: false, reason: "no-scope" };
  if (partitions.length === 0) return { ok: false, reason: "unresolvable" };
  const resolve = deps.resolve ?? resolveAccessForPartition;
  for (const p of partitions) {
    let access: EffectiveAccess;
    try {
      access = resolve(p);
    } catch {
      return { ok: false, reason: "unresolvable", partition: p.surfaceKey };
    }
    let granted: boolean;
    try {
      granted = declared ? scopeGrantsRead(declared, access) : adapter!.grantsRead(ev.scope, access);
    } catch {
      return { ok: false, reason: "unresolvable", partition: p.surfaceKey };
    }
    if (!granted) return { ok: false, reason: "refused", partition: p.surfaceKey };
  }
  return { ok: true };
}
