import { parseWindowToken, isTaskWindowId } from "./window-key.js";
import type { UnifiedThreadRef } from "./unified-window.js";

export const THREAD_OWNER_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface ThreadOwnershipStore {
  putThreadOwner(org: string, channelKey: string, threadKey: string, taskToken: string, at: string, ttlMs: number): Promise<void>;
  getThreadOwner(org: string, channelKey: string, threadKey: string): Promise<string | null>;
  clearThreadOwner(org: string, channelKey: string, threadKey: string): Promise<boolean>;
}

export async function recordThreadOwner(store: ThreadOwnershipStore, org: string, ref: UnifiedThreadRef, taskToken: string, atIso: string): Promise<void> {
  await store.putThreadOwner(org, ref.channelKey, ref.threadKey, taskToken, atIso, THREAD_OWNER_TTL_MS);
}

export async function resolveThreadOwner(store: ThreadOwnershipStore, org: string, ref: UnifiedThreadRef): Promise<string | null> {
  try {
    return await store.getThreadOwner(org, ref.channelKey, ref.threadKey);
  } catch {
    return null;
  }
}

export async function clearThreadOwner(store: ThreadOwnershipStore, org: string, ref: UnifiedThreadRef): Promise<boolean> {
  try {
    return await store.clearThreadOwner(org, ref.channelKey, ref.threadKey);
  } catch {
    return false;
  }
}

export type ThreadRoute = { readonly kind: "task"; readonly token: string } | { readonly kind: "standing" };

export function routeThreadMessage(ownerToken: string | null, liveGeneration?: number): ThreadRoute {
  if (!ownerToken) return { kind: "standing" };
  const key = parseWindowToken(ownerToken);
  if (!key || !isTaskWindowId(key.windowId)) return { kind: "standing" };
  if (liveGeneration !== undefined && key.generation !== liveGeneration) return { kind: "standing" };
  return { kind: "task", token: ownerToken };
}
