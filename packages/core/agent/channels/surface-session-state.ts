import { admitProviderRegistration } from "../access/provider-selection.js";
import { isWorkSessionContext } from "../access/work-session.js";
import { bindFrom, channelPlatform, isSubagentChildContext, type BindableContext } from "../identity/binding.js";

export const SURFACE_SIGN_CLEARED_ACTION = "surface.working_sign_cleared";

export type SurfaceSessionStatus = "processing" | "active" | "suspended";

export interface SurfaceTurnEnd {
  readonly failed?: true;
}

export type SurfaceSessionSetter = (attributes: Readonly<Record<string, unknown>>, status: SurfaceSessionStatus, end?: SurfaceTurnEnd) => Promise<string | undefined>;

export type SurfaceSessionStepper = (attributes: Readonly<Record<string, unknown>>, actions: readonly unknown[]) => Promise<void>;

export type SurfaceSessionAnswerer = (attributes: Readonly<Record<string, unknown>>) => Promise<string | undefined>;

export type SurfaceSessionPinner = (attributes: Readonly<Record<string, unknown>>) => { readonly id: string; readonly attributes: Readonly<Record<string, string>> } | undefined;

export interface SurfaceSessionPin {
  readonly platform: string;
  readonly id: string;
  readonly attributes: Readonly<Record<string, string>>;
}

const setters = new Map<string, SurfaceSessionSetter>();
const pinners = new Map<string, SurfaceSessionPinner>();
const steppers = new Map<string, SurfaceSessionStepper>();
const answerers = new Map<string, SurfaceSessionAnswerer>();

export function registerSurfaceSessionState(platform: string, setter: SurfaceSessionSetter, pinner?: SurfaceSessionPinner, stepper?: SurfaceSessionStepper, answerer?: SurfaceSessionAnswerer): void {
  if (!admitProviderRegistration(platform, "surface-session-state")) return;
  setters.set(platform, setter);
  if (pinner) pinners.set(platform, pinner);
  else pinners.delete(platform);
  if (stepper) steppers.set(platform, stepper);
  else steppers.delete(platform);
  if (answerer) answerers.set(platform, answerer);
  else answerers.delete(platform);
}

export function _resetSurfaceSessionStateForTest(): void {
  setters.clear();
  pinners.clear();
  steppers.clear();
  answerers.clear();
}

export function pinSurfaceSession(turn: SurfaceTurn | undefined): SurfaceSessionPin | undefined {
  if (!turn) return undefined;
  const pinner = pinners.get(turn.platform);
  if (!pinner) return undefined;
  try {
    const pinned = pinner(turn.attributes);
    return pinned && pinned.id.length > 0 ? { platform: turn.platform, id: pinned.id, attributes: { ...pinned.attributes } } : undefined;
  } catch (err) {
    console.warn(`[open-everywhere:surface-session] ${turn.platform} pin failed: ${String(err)}`);
    return undefined;
  }
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

export async function markSurfaceSession(platform: string | undefined, attributes: Readonly<Record<string, unknown>> | undefined, status: SurfaceSessionStatus, end?: SurfaceTurnEnd): Promise<string | undefined> {
  if (!platform || !attributes) return undefined;
  const setter = setters.get(platform);
  if (!setter) return undefined;
  try {
    return await (end === undefined ? setter(attributes, status) : setter(attributes, status, end));
  } catch (err) {
    console.warn(`[open-everywhere:surface-session] ${platform} ${status} failed: ${String(err)}`);
    return undefined;
  }
}

export async function stepSurfaceSession(turn: SurfaceTurn, actions: readonly unknown[]): Promise<void> {
  const stepper = steppers.get(turn.platform);
  if (!stepper) return;
  try {
    await stepper(turn.attributes, actions);
  } catch (err) {
    console.warn(`[open-everywhere:surface-session] ${turn.platform} step failed: ${String(err)}`);
  }
}

export async function answerSurfaceSession(turn: SurfaceTurn): Promise<string | undefined> {
  const answerer = answerers.get(turn.platform);
  if (!answerer) return undefined;
  try {
    return await answerer(turn.attributes);
  } catch (err) {
    console.warn(`[open-everywhere:surface-session] ${turn.platform} answer failed: ${String(err)}`);
    return undefined;
  }
}
