import type { WakeMessageInput, WakeTrust } from "./wake-envelope.js";
import { tailTokenCap } from "./session-tail.js";
import { admitToSeat, type SeatAdmissionFn } from "./seat-admission.js";

export interface NormalizedMessage {
  readonly id: string;
  readonly ms: number;
  readonly authorId?: string;
  readonly sender: "self" | "human" | "bot";
  readonly type: "channel" | "thread";
  readonly threadId?: string;
  readonly text: string;
}

export function catchUpSender(f: { readonly self: boolean; readonly bot?: boolean }): NormalizedMessage["sender"] {
  if (f.self) return "self";
  return f.bot === true ? "bot" : "human";
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

export function seatCatchUpSinceMs(lastWakeAt: string | null | undefined, nowMs: number, maxReachbackHours: number): number {
  const floor = nowMs - maxReachbackHours * 3600_000;
  if (typeof lastWakeAt !== "string" || lastWakeAt.length === 0) return floor;
  const at = Date.parse(lastWakeAt);
  if (!Number.isFinite(at)) return floor;
  return Math.max(at, floor);
}

export function fetchedBackscroll(
  messages: readonly NormalizedMessage[],
  capTokens: number = tailTokenCap(),
  trustFor?: BackscrollTrustFor,
  admit?: SeatAdmissionFn,
): WakeMessageInput[] {
  if (messages.length === 0) return [];
  const graded = [...messages]
    .sort((a, b) => a.ms - b.ms)
    .map((m) => ({ ...m, trust: trustFor ? trustFor(m) : m.sender === "human" ? ("unauth" as const) : ("relay" as const) }));
  const admitted = admit ? admitToSeat(graded, admit) : graded;
  const kept: Array<NormalizedMessage & { trust: WakeTrust }> = [];
  let tokens = 0;
  for (let i = admitted.length - 1; i >= 0; i--) {
    const cost = approxMessageTokens(admitted[i]);
    if (tokens + cost > capTokens && kept.length > 0) break;
    tokens += cost;
    kept.unshift(admitted[i]);
  }
  return kept.map((m) => toWakeMessage(m, () => m.trust));
}
