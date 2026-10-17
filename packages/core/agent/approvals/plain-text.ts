export const PLAIN_SUMMARY_MAX = 150;

export const CONSEQUENCE_MAX = 160;

export const QUOTE_MAX = 1400;

const PLAIN_VALUE_MAX = 60;

const MARKUP = /[<>[\]*_~`|]/gu;

const BROADCAST_MENTION = /@+(?=(?:everyone|here)\b)/giu;

function cutClean(text: string, max: number): string {
  const cut = text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
  return cut.replace(BROADCAST_MENTION, "");
}

export function plainValue(value: unknown, max: number = PLAIN_VALUE_MAX): string {
  const raw = typeof value === "string" ? value : typeof value === "number" && Number.isFinite(value) ? String(value) : "";
  const cleaned = raw.replace(MARKUP, "").replace(BROADCAST_MENTION, "").replace(/\s+/gu, " ").trim();
  if (cleaned.length === 0) return "(unnamed)";
  return cutClean(cleaned, max);
}

const EM_DASH = /\s*—\s*/gu;

export function withoutDashes(line: string): string {
  return line
    .split(/(“[^”]*”|"[^"]*")/u)
    .map((part, i) => (i % 2 === 1 ? part : part.replace(EM_DASH, ", ").replace(/,\s*([,.;:!?])/gu, "$1")))
    .join("")
    .replace(/^,\s*/u, "")
    .replace(/,\s*$/u, "")
    .trim();
}

export function finishPlainLine(line: string, max: number): string {
  return cutClean(withoutDashes(line.replace(/\s+/gu, " ").trim()), max);
}

export function finishPlainSentence(sentence: string): string {
  const one = withoutDashes(sentence.replace(/\s+/gu, " ").trim());
  const capped = cutClean(one, PLAIN_SUMMARY_MAX);
  return /[.!?…]$/u.test(capped) ? capped : `${capped}.`;
}

const LINK_MARKUP = /[<>[\]|]/gu;

export function linkSafeLine(value: string, max: number): string {
  const cleaned = value.replace(LINK_MARKUP, "").replace(BROADCAST_MENTION, "").replace(/\s+/gu, " ").trim();
  return cutClean(cleaned, max);
}

export function plainQuote(value: unknown, max: number): string {
  const whole = typeof value === "string" ? linkSafeLine(value, Number.MAX_SAFE_INTEGER) : "";
  if (whole.length === 0) return "“(empty)”";
  if (whole.length + 2 <= max) return `“${whole}”`;
  const room = Math.max(40, max - 2 - 40);
  const shown = linkSafeLine(whole.slice(0, room), room).replace(/…$/u, "");
  return `“${shown}…” (${whole.length - shown.length} more characters not shown)`;
}
