import { getOperationalStore } from "../operational/provider.js";
import type { TurnAnchorRow, TurnAnchorWrite } from "../operational/store.js";
import { UNIFIED_SEND_PREFIX } from "./window-key.js";

export const TURN_ANCHOR_TTL_MS = 45 * 60_000;

export function turnAnchorKey(platform: string | undefined, channelId: string | undefined, messageId: string | undefined): string | undefined {
  return platform && channelId && messageId ? `${platform}:${channelId}:${messageId}` : undefined;
}

export function turnChannelKey(platform: string | undefined, channelId: string | undefined): string | undefined {
  return platform && channelId ? `${platform}:${channelId}` : undefined;
}

export interface TurnAnchorAddress {
  readonly channelId?: string;
  readonly messageId?: string;
}

export function turnAnchorAddress(binding: {
  readonly anchorChannelId?: string;
  readonly anchorMessageId?: string;
  readonly threadTs?: string;
  readonly target?: Readonly<Record<string, unknown>>;
}): TurnAnchorAddress {
  const fromTarget = typeof binding.target?.["channelId"] === "string" ? (binding.target["channelId"] as string) : undefined;
  const channelId = binding.anchorChannelId && binding.anchorChannelId.length > 0 ? binding.anchorChannelId : fromTarget;
  const messageId = binding.threadTs ?? binding.anchorMessageId;
  return { ...(channelId ? { channelId } : {}), ...(messageId ? { messageId } : {}) };
}

export async function recordTurnAnchor(org: string, anchor: TurnAnchorWrite, atIso: string): Promise<void> {
  try {
    await getOperationalStore().putTurnAnchor(org, anchor, atIso, TURN_ANCHOR_TTL_MS);
  } catch (err) {
    console.warn(`[open-everywhere:turn-anchor] putTurnAnchor failed (${anchor.windowKey}): ${String(err)}`);
  }
}

export async function clearTurnAnchor(org: string, windowKey: string): Promise<void> {
  try {
    await getOperationalStore().clearTurnAnchor(org, windowKey);
  } catch (err) {
    console.warn(`[open-everywhere:turn-anchor] clearTurnAnchor failed (${windowKey}): ${String(err)}`);
  }
}

export interface TurnAnchorQuery {
  readonly anchorKey?: string;
  readonly windowKey?: string;
  readonly channelKey?: string;
}

function windowKeySpellings(windowKey: string): readonly string[] {
  return windowKey.startsWith(UNIFIED_SEND_PREFIX)
    ? [windowKey, windowKey.slice(UNIFIED_SEND_PREFIX.length)]
    : [windowKey, `${UNIFIED_SEND_PREFIX}${windowKey}`];
}

export async function resolveTurnAnchor(org: string, q: TurnAnchorQuery): Promise<TurnAnchorRow | null> {
  const store = getOperationalStore();
  try {
    if (q.anchorKey) {
      const byAnchor = await store.getTurnAnchorByAnchor(org, q.anchorKey);
      if (byAnchor) return byAnchor;
    }
    if (q.windowKey) {
      for (const key of windowKeySpellings(q.windowKey)) {
        const byWindow = await store.getTurnAnchorByWindow(org, key);
        if (byWindow) return byWindow;
      }
    }
    if (q.channelKey) {
      const byChannel = await store.getLatestTurnAnchorForChannel(org, q.channelKey);
      if (byChannel) return byChannel;
    }
    return null;
  } catch (err) {
    console.warn(`[open-everywhere:turn-anchor] resolve failed: ${String(err)}`);
    return null;
  }
}
