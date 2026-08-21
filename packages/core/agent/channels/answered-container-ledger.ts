import { createHash } from "node:crypto";
import { getOperationalStore } from "../operational/provider.js";
import { wakeOriginCodec } from "./wake-origin-codec.js";
import type { UnifiedWakeOrigin } from "./unified-window.js";

export const ANSWERED_CONTAINER_KEY_PREFIX = "answered:";

export const ANSWERED_CONTAINER_TTL_MS = 30 * 60_000;

export interface AnsweredContainerDeps {
  readonly markEventSeen?: (org: string, key: string, atIso: string, ttlMs: number) => Promise<boolean>;
  readonly hasEventSeen?: (org: string, key: string, atIso: string, ttlMs: number) => Promise<boolean>;
  readonly forgetEventSeen?: (org: string, key: string) => Promise<void>;
  readonly now?: () => number;
}

export function answeredContainerKey(origin: UnifiedWakeOrigin): string | null {
  const channelKey = wakeOriginCodec(origin.platform)?.threadRef(origin)?.channelKey;
  if (typeof channelKey !== "string" || channelKey.length === 0) return null;
  const digest = createHash("sha256").update(channelKey).digest("hex");
  return `${ANSWERED_CONTAINER_KEY_PREFIX}${origin.platform}:${digest}`;
}

export async function recordContainerAnswered(org: string | undefined, origin: UnifiedWakeOrigin, deps: AnsweredContainerDeps = {}): Promise<void> {
  if (!org) return;
  const key = answeredContainerKey(origin);
  if (key === null) return;
  const forget = deps.forgetEventSeen ?? ((o, k) => getOperationalStore().forgetEventSeen(o, k));
  const mark = deps.markEventSeen ?? ((o, k, at, ttl) => getOperationalStore().markEventSeen(o, k, at, ttl));
  const at = new Date((deps.now ?? Date.now)()).toISOString();
  await forget(org, key).catch(() => undefined);
  await mark(org, key, at, ANSWERED_CONTAINER_TTL_MS).catch(() => undefined);
}

export async function containerAnsweredSince(org: string | undefined, origin: UnifiedWakeOrigin, sinceIso: string | undefined, deps: AnsweredContainerDeps = {}): Promise<boolean> {
  if (!org || !sinceIso) return false;
  const sinceMs = Date.parse(sinceIso);
  if (!Number.isFinite(sinceMs)) return false;
  const nowMs = (deps.now ?? Date.now)();
  const window = nowMs - sinceMs;
  if (!(window > 0)) return false;
  const ttlMs = Math.min(window, ANSWERED_CONTAINER_TTL_MS);
  const key = answeredContainerKey(origin);
  if (key === null) return false;
  const has = deps.hasEventSeen ?? ((o, k, at, ttl) => getOperationalStore().hasEventSeen(o, k, at, ttl));
  try {
    return await has(org, key, new Date(nowMs).toISOString(), ttlMs);
  } catch {
    return false;
  }
}
