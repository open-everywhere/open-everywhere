import { createHash } from "node:crypto";
import { triggerAuthors, triggerMessageBody, wakeIdsFromEnvelope, isWakeEnvelopeShaped } from "../channels/wake-envelope.js";
import type { QuestionLedgerEntry } from "../operational/store.js";

export const QUESTION_LEDGER_KEEP_DAYS = 42;
export const QUESTION_WORDS_MAX = 160;
export const QUESTION_MIN_WORDS = 3;
export const QUESTION_MAX_WORDS = 24;

const ADDRESSED_REASONS = new Set(["dm", "mention"]);
const ADDRESSED_ADDRESSING = new Set(["direct", "direct-mention"]);

export interface LedgerQuestion {
  readonly words: string;
  readonly fingerprint: string;
}

export function questionOf(text: string): LedgerQuestion | undefined {
  const trimmed = text.trim();
  if (trimmed.length === 0 || /[\r\n]/u.test(trimmed) || !trimmed.endsWith("?")) return undefined;
  if (/https?:\/\/|www\.|`|<(?:https?|mailto):/iu.test(trimmed)) return undefined;
  const plain = trimmed.replace(/<[@#!][^>]*>/gu, " ");
  const words = plain
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, " ")
    .split(/\s+/u)
    .filter((w) => w.length > 0 && w !== "'");
  if (words.length < QUESTION_MIN_WORDS || words.length > QUESTION_MAX_WORDS) return undefined;
  const normalized = `${words.join(" ")}?`;
  if (normalized.length > QUESTION_WORDS_MAX) return undefined;
  return { words: normalized, fingerprint: createHash("sha256").update(normalized).digest("hex").slice(0, 16) };
}

function wakeAttributes(text: string): { readonly reason?: string; readonly addressing?: string } | undefined {
  const openers = [...text.matchAll(/<wake\b([^>]*)>/gu)];
  if (openers.length !== 1) return undefined;
  const attrs = openers[0]![1] ?? "";
  const reason = /\breason="([^"]*)"/u.exec(attrs)?.[1];
  const addressing = /\baddressing="([^"]*)"/u.exec(attrs)?.[1];
  return { ...(reason !== undefined ? { reason } : {}), ...(addressing !== undefined ? { addressing } : {}) };
}

export function askedText(message: string, mode: "dm" | "channel", actingId: string): string | undefined {
  if (!isWakeEnvelopeShaped(message)) return mode === "dm" ? message : undefined;
  if (wakeIdsFromEnvelope(message).length > 1) return undefined;
  const authors = triggerAuthors(message);
  if (authors.length !== 1 || authors[0]!.from !== "human" || authors[0]!.authorId !== actingId) return undefined;
  if (mode === "channel") {
    const wake = wakeAttributes(message);
    if (!wake) return undefined;
    if (!ADDRESSED_REASONS.has(wake.reason ?? "") && !ADDRESSED_ADDRESSING.has(wake.addressing ?? "")) return undefined;
  }
  return triggerMessageBody(message);
}

export function questionEntry(input: { readonly org: string; readonly ts: string; readonly surfaceKey: string; readonly mode: "dm" | "channel"; readonly principalId: string; readonly question: LedgerQuestion }): QuestionLedgerEntry {
  return {
    org: input.org,
    ts: input.ts,
    surfaceKey: input.surfaceKey,
    surfaceMode: input.mode,
    principalId: input.principalId,
    fingerprint: input.question.fingerprint,
    words: input.question.words,
  };
}

export function questionPruneBefore(ts: string): string {
  return new Date(Date.parse(ts) - QUESTION_LEDGER_KEEP_DAYS * 86_400_000).toISOString();
}
