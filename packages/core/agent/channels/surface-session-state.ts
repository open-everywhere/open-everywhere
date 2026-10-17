import { admitProviderRegistration } from "../access/provider-selection.js";
import { isWorkSessionContext } from "../access/work-session.js";
import { bindFrom, channelPlatform, isSubagentChildContext, type BindableContext } from "../identity/binding.js";

export type SurfaceSessionStatus = "processing" | "active" | "suspended";

export type SurfaceSessionSetter = (attributes: Readonly<Record<string, unknown>>, status: SurfaceSessionStatus) => Promise<string | undefined>;

const setters = new Map<string, SurfaceSessionSetter>();

export function registerSurfaceSessionState(platform: string, setter: SurfaceSessionSetter): void {
  if (!admitProviderRegistration(platform, "surface-session-state")) return;
  setters.set(platform, setter);
}

export function _resetSurfaceSessionStateForTest(): void {
  setters.clear();
}

export function hasSurfaceSessionSetter(platform: string | undefined): boolean {
  return platform !== undefined && setters.has(platform);
}

export interface SurfaceTurn {
  readonly platform: string;
  readonly attributes: Readonly<Record<string, unknown>>;
}

export function surfaceTurnOf(ctx: unknown): SurfaceTurn | undefined {
  try {
    const c = ctx as BindableContext | undefined;
    if (!c || isSubagentChildContext(c) || isWorkSessionContext(c)) return undefined;
    const platform = channelPlatform(c) ?? bindFrom(c).platform;
    if (!hasSurfaceSessionSetter(platform)) return undefined;
    const attributes = (c as { session?: { auth?: { current?: { attributes?: Record<string, unknown> } } } }).session?.auth?.current?.attributes;
    return attributes ? { platform, attributes } : undefined;
  } catch (err) {
    console.warn(`[open-everywhere:surface-session] lookup failed: ${String(err)}`);
    return undefined;
  }
}

export function parkedSurfaceStatus(needsPerson: boolean): SurfaceSessionStatus {
  return needsPerson ? "suspended" : "active";
}

export async function markSurfaceSession(platform: string | undefined, attributes: Readonly<Record<string, unknown>> | undefined, status: SurfaceSessionStatus): Promise<string | undefined> {
  if (!platform || !attributes) return undefined;
  const setter = setters.get(platform);
  if (!setter) return undefined;
  try {
    return await setter(attributes, status);
  } catch (err) {
    console.warn(`[open-everywhere:surface-session] ${platform} ${status} failed: ${String(err)}`);
    return undefined;
  }
}
