import { defineState } from "eve/context";
import {
  isUnifiedWakeOrigin,
  sameUnifiedConversation,
  WAKE_TARGET_TTL_MS,
  type PendingUnifiedWake,
  type UnifiedWakeOrigin,
  type UnifiedWakeRecord,
} from "./unified-window.js";

export interface ReplyFreshnessStore {
  getUnifiedWakeRecord(org: string, wakeId: string): Promise<UnifiedWakeRecord | null>;
  listPendingUnifiedWakes(org: string, windowToken: string, afterIso: string, limit: number): Promise<readonly PendingUnifiedWake[]>;
}

export const MAX_NEWER_WAKES = 20;

export const REPLY_STALE_REFUSAL_REASON = "stale-conversation";

export const REPLY_FORCED_AUDIT_REASON = "stale-conversation-forced";

export type ReplyFreshness =
  | { readonly stale: false }
  | { readonly stale: true; readonly newer: number; readonly capped: boolean };

async function stampOf(store: ReplyFreshnessStore, org: string, wakeId: string | undefined): Promise<number | undefined> {
  if (typeof wakeId !== "string" || wakeId.length === 0 || wakeId.length > 200) return undefined;
  let row: UnifiedWakeRecord | null;
  try {
    row = await store.getUnifiedWakeRecord(org, wakeId);
  } catch {
    return undefined;
  }
  if (!row) return undefined;
  const at = Date.parse(row.createdAt);
  return Number.isFinite(at) ? at : undefined;
}

export async function replyFreshness(
  store: ReplyFreshnessStore,
  org: string,
  input: {
    readonly target: UnifiedWakeOrigin;
    readonly windowToken: string | undefined;
    readonly inputWake: string;
    readonly turnWake: string | undefined;
  },
  nowMs?: number,
): Promise<ReplyFreshness> {
  const fresh: ReplyFreshness = { stale: false };
  if (!input.windowToken) return fresh;
  const [inputAt, turnAt] = await Promise.all([stampOf(store, org, input.inputWake), stampOf(store, org, input.turnWake)]);
  if (inputAt === undefined && turnAt === undefined) return fresh;
  const anchorMs = Math.max(inputAt ?? Number.NEGATIVE_INFINITY, turnAt ?? Number.NEGATIVE_INFINITY);
  let rows: readonly PendingUnifiedWake[];
  try {
    rows = await store.listPendingUnifiedWakes(org, input.windowToken, new Date(anchorMs).toISOString(), MAX_NEWER_WAKES + 1);
  } catch {
    return fresh;
  }
  const now = nowMs ?? Date.now();
  let newer = 0;
  for (const row of rows) {
    if (row.wakeId === input.inputWake || row.wakeId === input.turnWake) continue;
    const at = Date.parse(row.createdAt);
    if (!Number.isFinite(at) || at <= anchorMs) continue;
    if (now - at > WAKE_TARGET_TTL_MS) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.targetJson);
    } catch {
      continue;
    }
    if (!isUnifiedWakeOrigin(parsed)) continue;
    if (!sameUnifiedConversation(parsed, input.target)) continue;
    newer += 1;
  }
  if (newer === 0) return fresh;
  return { stale: true, newer: Math.min(newer, MAX_NEWER_WAKES), capped: newer > MAX_NEWER_WAKES };
}

export function staleReplyRefusalMessage(freshness: Extract<ReplyFreshness, { stale: true }>): string {
  const count = freshness.capped ? `at least ${freshness.newer}` : `${freshness.newer}`;
  const plural = freshness.newer === 1 && !freshness.capped ? "message" : "messages";
  return (
    `reply: this conversation has moved on — ${count} newer ${plural} arrived after the ones you have seen. ` +
    "NOTHING was posted. Those messages are already queued and reach you as your next wake, so the best move is " +
    "to end this turn now (`no_reply`) and answer them together with this one — the wake stays open and unanswered. " +
    "Posting now is DISCOURAGED, not blocked: send this same call again, or pass `force: true`, and it posts. " +
    "It costs the room an answer that ignores the newest messages, and the override is recorded."
  );
}

interface StaleRefusedWakes {
  readonly turnId: string;
  readonly wakes: readonly string[];
}

const refusedSlot = defineState<StaleRefusedWakes | null>("open-everywhere.reply-stale-refused", () => null);

const MAX_REFUSED_WAKES = 32;

export function markStaleRefusedThisTurn(turnId: string | undefined, wake: string): void {
  if (turnId === undefined || turnId.length === 0) return;
  if (typeof wake !== "string" || wake.length === 0) return;
  try {
    refusedSlot.update((prev) => {
      const wakes = prev !== null && prev.turnId === turnId ? prev.wakes : [];
      if (wakes.includes(wake) || wakes.length >= MAX_REFUSED_WAKES) return { turnId, wakes };
      return { turnId, wakes: [...wakes, wake] };
    });
  } catch {
  }
}

export function wasStaleRefusedThisTurn(turnId: string | undefined, wake: string): boolean {
  if (turnId === undefined || turnId.length === 0) return false;
  try {
    const cur = refusedSlot.get();
    return cur !== null && cur.turnId === turnId && cur.wakes.includes(wake);
  } catch {
    return false;
  }
}
