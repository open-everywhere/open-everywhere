import { wrapUntrusted } from "../access/untrusted.js";

export const MAX_MESSAGES = 10;
export const MAX_CHARS = 12_000;

export const WAKE_BACKSCROLL_MAX = 10;

export type SenderType = "user" | "bot" | "agent" | "unknown";

export interface ContextLine {
  readonly senderType: SenderType;
  readonly senderId?: string;
  readonly ts: string;
  readonly text: string;
}

function attribution(l: ContextLine): string {
  if (l.senderType === "agent") return "[sender_type=agent]";
  if (l.senderId) return `[sender_type=${l.senderType} sender_id=${l.senderId}]`;
  return `[sender_type=${l.senderType}]`;
}

export function renderContext(
  lines: readonly ContextLine[],
  source: string,
  opts: { readonly readMoreHint?: string } = {},
): string | null {
  const kept: string[] = [];
  let chars = 0;
  for (let i = lines.length - 1; i >= 0 && kept.length < MAX_MESSAGES; i--) {
    const l = lines[i];
    const text = l.text.trim();
    if (!text) continue;
    const rendered = `${attribution(l)} ${text}`;
    if (chars + rendered.length > MAX_CHARS && kept.length > 0) break;
    chars += rendered.length;
    kept.unshift(rendered);
  }
  if (kept.length === 0) return null;
  const body = `Recent conversation (oldest first), for context:\n${kept.join("\n")}`;
  const wrapped = wrapUntrusted(body, { source });
  return kept.length === MAX_MESSAGES && opts.readMoreHint ? `${wrapped}\n\n${opts.readMoreHint}` : wrapped;
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
