import type { WakeMessageInput, WakeTrust } from "./wake-envelope.js";
import { tailTokenCap } from "./session-tail.js";

export interface NormalizedMessage {
  readonly id: string;
  readonly ms: number;
  readonly authorId?: string;
  readonly sender: "self" | "human" | "bot";
  readonly type: "channel" | "thread";
  readonly threadId?: string;
  readonly text: string;
}

const CHARS_PER_TOKEN = 4;

const PER_MESSAGE_OVERHEAD_TOKENS = 110;

export function approxMessageTokens(m: NormalizedMessage): number {
  return Math.ceil((m.text.length + (m.authorId?.length ?? 0)) / CHARS_PER_TOKEN) + PER_MESSAGE_OVERHEAD_TOKENS;
}

export type BackscrollTrustFor = (m: NormalizedMessage) => WakeTrust;

function toWakeMessage(m: NormalizedMessage, trustFor?: BackscrollTrustFor): WakeMessageInput {
  return {
    from: m.sender,
    author: m.authorId ?? "unknown",
    ...(m.authorId ? { authorId: m.authorId } : {}),
    id: m.id,
    sentAt: new Date(m.ms).toISOString(),
    trust: trustFor ? trustFor(m) : m.sender === "human" ? "unauth" : "relay",
    type: m.type,
    ...(m.threadId ? { threadRoot: m.threadId } : {}),
    body: m.text,
  };
}

export function fetchedBackscroll(
  messages: readonly NormalizedMessage[],
  capTokens: number = tailTokenCap(),
  trustFor?: BackscrollTrustFor,
): WakeMessageInput[] {
  if (messages.length === 0) return [];
  const sorted = [...messages].sort((a, b) => a.ms - b.ms);
  const kept: NormalizedMessage[] = [];
  let tokens = 0;
  for (let i = sorted.length - 1; i >= 0; i--) {
    const cost = approxMessageTokens(sorted[i]);
    if (tokens + cost > capTokens && kept.length > 0) break;
    tokens += cost;
    kept.unshift(sorted[i]);
  }
  return kept.map((m) => toWakeMessage(m, trustFor));
}
