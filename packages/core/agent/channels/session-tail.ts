import type { WakeMessageInput, WakeTrust } from "./wake-envelope.js";
import { getSettings } from "../settings/settings.js";

export interface SessionTailEntry {
  readonly kind: "wake" | "post";
  readonly at: string;
  readonly from: "self" | "human" | "bot";
  readonly trust: WakeTrust;
  readonly author: string;
  readonly authorId?: string;
  readonly id?: string;
  readonly platform?: string;
  readonly container?: string;
  readonly threadRoot?: string;
  readonly text: string;
}

export const SESSION_TAIL_MAX_ENTRIES = 200;

const CHARS_PER_TOKEN = 4;

const PER_ENTRY_OVERHEAD_TOKENS = 110;

export function approxEntryTokens(e: SessionTailEntry): number {
  return Math.ceil((e.text.length + (e.author.length ?? 0)) / CHARS_PER_TOKEN) + PER_ENTRY_OVERHEAD_TOKENS;
}

export function tailTokenCap(): number {
  return getSettings().rotation.tailTokenCap;
}

export function selectTail(ring: readonly SessionTailEntry[], capTokens: number = tailTokenCap()): SessionTailEntry[] {
  const kept: SessionTailEntry[] = [];
  let tokens = 0;
  for (let i = ring.length - 1; i >= 0; i--) {
    const cost = approxEntryTokens(ring[i]);
    if (tokens + cost > capTokens && kept.length > 0) break;
    tokens += cost;
    kept.unshift(ring[i]);
  }
  return kept;
}

export function tailEntryToWakeMessage(e: SessionTailEntry): WakeMessageInput {
  return {
    from: e.from,
    author: e.author,
    ...(e.authorId ? { authorId: e.authorId } : {}),
    id: e.id ?? `${e.kind}:${e.at}`,
    sentAt: e.at,
    trust: e.trust,
    ...(e.container ? { container: e.container } : {}),
    ...(e.threadRoot ? { type: "thread" as const, threadRoot: e.threadRoot } : {}),
    body: e.text,
  };
}

export function buildTail(ring: readonly SessionTailEntry[], capTokens: number = tailTokenCap()): WakeMessageInput[] {
  const ordered = [...ring].sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.kind.localeCompare(b.kind));
  return selectTail(ordered, capTokens).map(tailEntryToWakeMessage);
}
