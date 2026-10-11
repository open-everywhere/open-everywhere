import type { InboundEmail } from "./transport.js";

export interface SplitEmailBody {
  readonly subject: string;
  readonly ownText: string;
  readonly remainder: string;
  readonly truncated: boolean;
  readonly quotedInOwn: boolean;
}

const SUBJECT_MAX = 300;

function cap(s: string, max: number): { readonly text: string; readonly cut: boolean } {
  return s.length <= max ? { text: s, cut: false } : { text: `${s.slice(0, max)}\n[… truncated]`, cut: true };
}

function clean(s: string): string {
  return s
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => l.replace(/\s+$/u, ""))
    .join("\n")
    .trim();
}

const QUOTE_MARKERS: readonly RegExp[] = [
  /^\s*>/,
  /^\s*On\b.{0,300}\bwrote:\s*$/i,
  /^\s*-{2,}\s*(Forwarded message|Original Message)\s*-{2,}/i,
  /^\s*Begin forwarded message:/i,
  /^_{8,}\s*$/,
];

const PASTED_HEADER = /^\s*(From|Sent|Date|To|Cc|Subject):\s+\S/i;

function showsQuoteMarker(text: string): boolean {
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (QUOTE_MARKERS.some((re) => re.test(l))) return true;
    if (PASTED_HEADER.test(l) && PASTED_HEADER.test(lines[i + 1] ?? "")) return true;
  }
  return false;
}

export function splitEmailBody(mail: Pick<InboundEmail, "subject" | "newText" | "fullText">, maxChars: number): SplitEmailBody {
  const subject = clean(mail.subject).replace(/\s+/g, " ").slice(0, SUBJECT_MAX);
  const full = clean(mail.fullText);
  const own = mail.newText === undefined ? "" : clean(mail.newText);
  let remainder: string;
  if (own === "") remainder = full;
  else if (full.startsWith(own)) remainder = full.slice(own.length).trim();
  else {
    const at = full.indexOf(own);
    remainder = at >= 0 ? `${full.slice(0, at)}\n${full.slice(at + own.length)}`.trim() : full === own ? "" : full;
  }
  const ownCapped = cap(own, maxChars);
  const restBudget = Math.max(0, maxChars - ownCapped.text.length);
  const restCapped = cap(remainder, restBudget);
  return {
    subject,
    ownText: ownCapped.text,
    remainder: restBudget === 0 && remainder !== "" ? "[… truncated]" : restCapped.text,
    truncated: ownCapped.cut || restCapped.cut || (restBudget === 0 && remainder !== ""),
    quotedInOwn: showsQuoteMarker(own),
  };
}

export function remainderTaints(body: SplitEmailBody): boolean {
  return body.remainder.length > 0 || body.quotedInOwn;
}
