import { getOperationalStore } from "../operational/provider.js";
import { webhookMaxSkewSeconds } from "./gate.js";

export function webhookReplayNonceTtlMs(): number {
  return (webhookMaxSkewSeconds() * 2 + 60) * 1000;
}

export function webhookReplayStoreKey(hookId: string, replayKey: string): string {
  return `webhook-replay:${hookId}:${replayKey}`;
}

export type MarkWebhookReplaySeen = (org: string, key: string, atIso: string, ttlMs: number) => Promise<boolean>;

let warnedReplayStore = false;

export function resetWebhookReplayWarnLatchForTest(): void {
  warnedReplayStore = false;
}

export interface WebhookReplayDeps {
  readonly markSeen?: MarkWebhookReplaySeen;
  readonly now?: () => Date;
}

export async function firstSightingOfWebhookDelivery(
  org: string,
  hookId: string,
  replayKey: string,
  deps: WebhookReplayDeps = {},
): Promise<boolean> {
  const markSeen = deps.markSeen ?? ((o: string, k: string, at: string, ttl: number) => getOperationalStore().markEventSeen(o, k, at, ttl));
  const nowIso = (deps.now?.() ?? new Date()).toISOString();
  const key = webhookReplayStoreKey(hookId, replayKey);
  try {
    return await markSeen(org, key, nowIso, webhookReplayNonceTtlMs());
  } catch (err) {
    if (!warnedReplayStore) {
      warnedReplayStore = true;
      console.warn(
        `[open-everywhere:webhooks] durable replay dedupe unavailable — a captured, validly-signed delivery could re-fire inside the skew window until the store recovers: ${String(err)}`,
      );
    }
    return true;
  }
}

export const WEBHOOK_REPLAY_KEY_PREFIX = "webhook-replay:";

export const REPLAYED_DELIVERY_AUDIT_REASON = "duplicate delivery rejected — an already-accepted delivery was replayed inside its skew window";

export const REPLAYED_DELIVERY_CALLER_BODY = "delivery refused";
