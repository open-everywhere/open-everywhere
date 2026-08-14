import { ingestUntrusted } from "../access/untrusted.js";
import { noteIngestionVerdict } from "../access/taint-enforcement.js";
import { taintMarkLands } from "../access/taint-signal.js";
import { UNAUTH_SYSTEM_NOTE, type WakeTrust } from "./wake-envelope.js";
import type { AuthorTrustQuery } from "../identity/author-trust.js";

export const MAX_MESSAGES = 10;
export const MAX_CHARS = 12_000;

export const WAKE_BACKSCROLL_MAX = 10;

export type SenderType = "user" | "bot" | "agent" | "unknown";

export interface ContextLine {
  readonly senderType: SenderType;
  readonly senderId?: string;
  readonly ts: string;
  readonly text: string;
  readonly trust?: WakeTrust;
  readonly refuted?: boolean;
  readonly authorTrust?: AuthorTrustQuery;
}

export function contextLineIngestion(l: ContextLine): { readonly trust?: WakeTrust; readonly refuted?: boolean; readonly authorTrust?: AuthorTrustQuery } {
  return { trust: l.trust, refuted: l.refuted, authorTrust: l.authorTrust };
}

function attribution(l: ContextLine): string {
  const trustPart = l.trust === "unauth" ? " trust=unauth" : "";
  if (l.senderType === "agent") return "[sender_type=agent]";
  if (l.senderId) return `[sender_type=${l.senderType} sender_id=${l.senderId}${trustPart}]`;
  return `[sender_type=${l.senderType}${trustPart}]`;
}

export function renderContext(
  lines: readonly ContextLine[],
  source: string,
  opts: { readonly readMoreHint?: string } = {},
): string | null {
  const kept: string[] = [];
  let chars = 0;
  let hasUnauth = false;
  for (let i = lines.length - 1; i >= 0 && kept.length < MAX_MESSAGES; i--) {
    const l = lines[i];
    const text = l.text.trim();
    if (!text) continue;
    const rendered = `${attribution(l)} ${text}`;
    if (chars + rendered.length > MAX_CHARS && kept.length > 0) break;
    chars += rendered.length;
    kept.unshift(rendered);
    if (l.trust === "unauth") hasUnauth = true;
  }
  if (kept.length === 0) return null;
  const body = `Recent conversation (oldest first), for context:\n${kept.join("\n")}`;
  noteIngestionVerdict({ kind: "chat-message", label: "context-render" }, taintMarkLands());
  const wrapped = ingestUntrusted(body, { source });
  const withNote = hasUnauth ? `${wrapped}\n\n${UNAUTH_SYSTEM_NOTE}` : wrapped;
  return kept.length === MAX_MESSAGES && opts.readMoreHint ? `${withNote}\n\n${opts.readMoreHint}` : withNote;
}

export function capLines(
  lines: readonly ContextLine[],
  opts: { readonly maxMessages?: number; readonly maxChars?: number } = {},
): ContextLine[] {
  const maxMessages = opts.maxMessages ?? MAX_MESSAGES;
  const maxChars = opts.maxChars ?? MAX_CHARS;
  const kept: ContextLine[] = [];
  let chars = 0;
  for (let i = lines.length - 1; i >= 0 && kept.length < maxMessages; i--) {
    const l = lines[i];
    const text = l.text.trim();
    if (!text) continue;
    if (chars + text.length > maxChars && kept.length > 0) break;
    chars += text.length;
    kept.unshift(l);
  }
  return kept;
}

export function sinceLastAgentReply(lines: readonly ContextLine[]): ContextLine[] {
  let lastAgent = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].senderType === "agent") {
      lastAgent = i;
      break;
    }
  }
  return lastAgent >= 0 ? lines.slice(lastAgent + 1) : [...lines];
}
