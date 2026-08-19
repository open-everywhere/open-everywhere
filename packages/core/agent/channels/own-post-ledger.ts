import { createHash } from "node:crypto";
import { getOperationalStore } from "../operational/provider.js";

export const OWN_POST_KEY_PREFIX = "ownpost:";

export const OWN_POST_TTL_MS = 6 * 60 * 60_000;

export interface OwnPostLocus {
  readonly platform: string;
  readonly channelId: string;
}

export interface OwnPostLedgerDeps {
  readonly markEventSeen?: (org: string, key: string, atIso: string, ttlMs: number) => Promise<boolean>;
  readonly hasEventSeen?: (org: string, key: string, atIso: string, ttlMs: number) => Promise<boolean>;
  readonly now?: () => number;
}

export function ownPostKey(locus: OwnPostLocus, messageId: string): string {
  const digest = createHash("sha256").update([locus.platform, locus.channelId, messageId].join(" ")).digest("hex");
  return `${OWN_POST_KEY_PREFIX}${locus.platform}:${digest}`;
}

export async function recordOwnPost(org: string | undefined, locus: OwnPostLocus, messageId: string, deps: OwnPostLedgerDeps = {}): Promise<void> {
  if (!org || !messageId || !locus.channelId) return;
  if (!isRecordableMessageId(messageId)) return;
  const mark = deps.markEventSeen ?? ((o, k, at, ttl) => getOperationalStore().markEventSeen(o, k, at, ttl));
  const at = new Date((deps.now ?? Date.now)()).toISOString();
  await mark(org, ownPostKey(locus, messageId), at, OWN_POST_TTL_MS).catch(() => undefined);
}

export async function isOwnPost(org: string | undefined, locus: OwnPostLocus, messageId: string, deps: OwnPostLedgerDeps = {}): Promise<boolean> {
  if (!org || !messageId || !locus.channelId) return false;
  const has = deps.hasEventSeen ?? ((o, k, at, ttl) => getOperationalStore().hasEventSeen(o, k, at, ttl));
  const at = new Date((deps.now ?? Date.now)()).toISOString();
  try {
    return await has(org, ownPostKey(locus, messageId), at, OWN_POST_TTL_MS);
  } catch {
    return false;
  }
}

const DEDUPE_SENTINEL = "deduped:reply";

function isRecordableMessageId(messageId: string): boolean {
  return messageId !== DEDUPE_SENTINEL;
}
