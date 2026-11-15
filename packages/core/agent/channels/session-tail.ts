import type { WakeMessageInput, WakeTrust } from "./wake-envelope.js";
import { getSettings } from "../settings/settings.js";
import type { IngestedChatMessage } from "../identity/non-member.js";
import type { AuthorTrustQuery } from "../identity/author-trust.js";
import { redactMachineLinkCodes } from "../identity/link-challenge.js";

export interface SessionTailEntry {
  readonly kind: "wake" | "post";
  readonly at: string;
  readonly from: "self" | "human" | "bot";
  readonly trust: WakeTrust;
  readonly refuted?: boolean;
  readonly authorTrust?: AuthorTrustQuery;
  readonly author: string;
  readonly authorId?: string;
  readonly id?: string;
  readonly wake?: string;
  readonly platform?: string;
  readonly container?: string;
  readonly threadRoot?: string;
  readonly text: string;
}

export type SessionTailWakeRow = Omit<SessionTailEntry, "refuted"> & { readonly refuted: boolean };

export function tailAuthorGrain(facts: IngestedChatMessage): { readonly refuted: boolean; readonly authorTrust?: AuthorTrustQuery } {
  return { refuted: facts.refuted === true, ...(facts.authorTrust === undefined ? {} : { authorTrust: facts.authorTrust }) };
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
    ...(e.refuted === true ? { refuted: true } : {}),
    ...(e.refuted === undefined ? { ungraded: true } : {}),
    ...(e.authorTrust === undefined ? {} : { authorTrust: e.authorTrust }),
    ...(e.container ? { container: e.container } : {}),
    ...(e.threadRoot ? { type: "thread" as const, threadRoot: e.threadRoot } : {}),
    body: e.text,
  };
}

export function buildTail(ring: readonly SessionTailEntry[], capTokens: number = tailTokenCap()): WakeMessageInput[] {
  return selectTail(orderRing(ring), capTokens).map(tailEntryToWakeMessage);
}

function askWords(text: string): string {
  return text
    .replace(/^\s*(?:<@[^>]+>[\s,:]*)+/, "")
    .replace(/<[@#!]([^>|]+)(?:\|[^>]*)?>/g, " $1 ")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export function answeredRepeatOnRing(ring: readonly SessionTailEntry[], container?: string): boolean {
  const rows = orderRing(ring).filter((e) => container === undefined || e.container === undefined || e.container === container);
  let lastPost = -1;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i]!.kind === "post") {
      lastPost = i;
      break;
    }
  }
  const waiting = rows.slice(lastPost + 1).filter((e) => e.kind === "wake");
  if (waiting.length === 0) return false;
  const answered = new Set<string>();
  let segment: string[] = [];
  for (let i = 0; i <= lastPost; i++) {
    const e = rows[i]!;
    if (e.kind === "wake") segment.push(askWords(e.text));
    else {
      if (segment.length > 0 && segment[0] !== "" && segment.every((w) => w === segment[0])) answered.add(segment[0]!);
      segment = [];
    }
  }
  return waiting.every((w) => answered.has(askWords(w.text)));
}

function orderRing(ring: readonly SessionTailEntry[]): SessionTailEntry[] {
  return [...ring].sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.kind.localeCompare(b.kind));
}

export const CONVERSATION_SUMMARY_PARTITION = "oe-dm-summary";

export function admitToSummary(e: SessionTailEntry): boolean {
  return e.kind === "post" || e.refuted === false;
}

export function parseConversationSummary(json: string | undefined): SessionTailEntry[] {
  if (json === undefined) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((e): e is SessionTailEntry => typeof e === "object" && e !== null && typeof (e as SessionTailEntry).text === "string" && typeof (e as SessionTailEntry).at === "string");
}

export const SUMMARY_ENTRY_MAX_CHARS = 480;

export function conversationSummaryTokenCap(): number {
  return getSettings().rotation.dmSummaryTokenCap;
}

export function condenseTailEntry(e: SessionTailEntry): SessionTailEntry {
  const source = e.from === "human" ? e.text : redactMachineLinkCodes(e.text);
  const flat = source.replace(/\s+/g, " ").trim();
  const points = Array.from(flat);
  const text = points.length <= SUMMARY_ENTRY_MAX_CHARS ? flat : `${points.slice(0, SUMMARY_ENTRY_MAX_CHARS - 1).join("").trimEnd()}…`;
  return text === e.text ? e : { ...e, text };
}

export interface ConversationCarry {
  readonly summary: readonly SessionTailEntry[];
  readonly tail: readonly SessionTailEntry[];
  readonly record: readonly SessionTailEntry[];
}

export function planConversationCarry(
  prior: readonly SessionTailEntry[],
  ring: readonly SessionTailEntry[],
  caps: { readonly tailTokens: number; readonly summaryTokens: number } = { tailTokens: tailTokenCap(), summaryTokens: conversationSummaryTokenCap() },
  admit: (e: SessionTailEntry) => boolean = admitToSummary,
): ConversationCarry {
  const ordered = orderRing(ring);
  const tail = selectTail(ordered, caps.tailTokens);
  const candidates = [...orderRing(prior), ...ordered].filter(admit).map((source) => ({ source, entry: condenseTailEntry(source) }));
  const kept: { readonly source: SessionTailEntry; readonly entry: SessionTailEntry }[] = [];
  let tokens = 0;
  for (let i = candidates.length - 1; i >= 0 && kept.length < SESSION_TAIL_MAX_ENTRIES; i--) {
    const cost = approxEntryTokens(candidates[i].entry);
    if (tokens + cost > caps.summaryTokens && kept.length > 0) break;
    tokens += cost;
    kept.unshift(candidates[i]);
  }
  const record = kept.map((k) => k.entry);
  const inTail = new Set<SessionTailEntry>(tail);
  const summary = kept.filter((k) => !inTail.has(k.source)).map((k) => k.entry);
  return { summary, tail, record };
}
