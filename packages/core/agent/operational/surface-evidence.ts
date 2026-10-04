import { getOperationalStore } from "./provider.js";
import type { OperationalStore } from "./store.js";

export const SURFACE_EVENT_VERIFIED_META_PREFIX = "surface_event_verified:";

export const SURFACE_EVENT_STAMP_PERIOD_MS = 60 * 60 * 1000;

const PLATFORM_ID = /^[a-z][a-z0-9-]{0,31}$/;

export function surfaceEventVerifiedMetaKey(platform: string): string {
  if (!PLATFORM_ID.test(platform)) throw new Error(`surface-evidence: "${platform}" is not a platform id`);
  return `${SURFACE_EVENT_VERIFIED_META_PREFIX}${platform}`;
}

const lastStampStartedAt = new Map<string, number>();

export interface SurfaceEvidenceDeps {
  readonly store?: Pick<OperationalStore, "getMeta" | "setMeta">;
  readonly now?: () => number;
}

export async function stampSurfaceEventVerified(platform: string, deps: SurfaceEvidenceDeps = {}): Promise<boolean> {
  const now = deps.now ?? Date.now;
  let key: string;
  try {
    key = surfaceEventVerifiedMetaKey(platform);
  } catch {
    return false;
  }
  const at = now();
  const last = lastStampStartedAt.get(platform);
  if (last !== undefined && at - last < SURFACE_EVENT_STAMP_PERIOD_MS) return false;
  lastStampStartedAt.set(platform, at);
  try {
    await (deps.store ?? getOperationalStore()).setMeta(key, new Date(at).toISOString());
    return true;
  } catch {
    if (lastStampStartedAt.get(platform) === at) lastStampStartedAt.delete(platform);
    return false;
  }
}

export async function surfaceEventVerifiedAt(platform: string, deps: Pick<SurfaceEvidenceDeps, "store"> = {}): Promise<string | null> {
  try {
    const value = await (deps.store ?? getOperationalStore()).getMeta(surfaceEventVerifiedMetaKey(platform));
    if (value === null || Number.isNaN(Date.parse(value))) return null;
    return value;
  } catch {
    return null;
  }
}

export function _resetSurfaceEventStampMemoForTest(): void {
  lastStampStartedAt.clear();
}
