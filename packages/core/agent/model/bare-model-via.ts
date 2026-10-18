import { processRegistrySlot } from "../lib/process-registry.js";
import { DEFAULT_MODEL_VIA, type ResolvableModel } from "./targets.js";

export interface BareModelRoutes {
  readonly byId: ReadonlyMap<string, string>;
  readonly fallback: string;
}

export interface BareModelVia {
  readonly via: string;
  readonly source: "role" | "default";
}

export function bareModelRoutes(roles: readonly ResolvableModel[]): BareModelRoutes {
  const byId = new Map<string, string>();
  for (const r of roles) if (r.id !== "" && !byId.has(r.id)) byId.set(r.id, r.via ?? DEFAULT_MODEL_VIA);
  return { byId, fallback: roles[0]?.via ?? DEFAULT_MODEL_VIA };
}

const registeredSlot = processRegistrySlot<BareModelRoutes>("model.bareRoutes.v1");

export function registerBareModelRoutes(roles: readonly ResolvableModel[]): void {
  registeredSlot.set(bareModelRoutes(roles));
}

export function bareModelRoutesUnregistered(routes: BareModelRoutes, registered: BareModelRoutes | null = registeredSlot.get()): boolean {
  return registered === null && [routes.fallback, ...routes.byId.values()].some((v) => v !== DEFAULT_MODEL_VIA);
}

export function bareModelRoutesRegistered(): boolean {
  return registeredSlot.get() !== null;
}

export function _resetBareModelRoutesForTest(): void {
  registeredSlot.set(null);
}

export function bareModelVia(id: string, routes: BareModelRoutes | undefined = registeredSlot.get() ?? undefined): BareModelVia {
  const byRole = routes?.byId.get(id);
  if (byRole !== undefined) return { via: byRole, source: "role" };
  return { via: routes?.fallback ?? DEFAULT_MODEL_VIA, source: "default" };
}

export interface BareModelFallback {
  readonly where: string;
  readonly id: string;
  readonly via: string;
}

export function bareModelFallbacks(bare: readonly { readonly where: string; readonly id: string }[], routes: BareModelRoutes): BareModelFallback[] {
  const out = new Map<string, BareModelFallback>();
  for (const b of bare) {
    const r = bareModelVia(b.id, routes);
    if (r.source === "default") out.set(`${b.where}\u0000${b.id}`, { where: b.where, id: b.id, via: r.via });
  }
  return [...out.values()];
}
