export const PLAIN_SUMMARY_MAX = 150;

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

export function finishPlainSentence(sentence: string): string {
  const one = sentence.replace(/\s+/gu, " ").trim();
  const capped = cutClean(one, PLAIN_SUMMARY_MAX);
  return /[.!?…]$/u.test(capped) ? capped : `${capped}.`;
}

const LINK_MARKUP = /[<>[\]|]/gu;

export function linkSafeLine(value: string, max: number): string {
  const cleaned = value.replace(LINK_MARKUP, "").replace(BROADCAST_MENTION, "").replace(/\s+/gu, " ").trim();
  return cutClean(cleaned, max);
}
