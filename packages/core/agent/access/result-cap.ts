import { SETTINGS, getSettings } from "../settings/settings.js";

export const DEFAULT_MAX_RESULT_CHARS = SETTINGS.tools.maxResultChars.shipped;

export function maxResultChars(): number {
  return getSettings().tools.maxResultChars;
}

const HEAD_FRACTION = 0.8;

export function capResult(content: string, limit: number = maxResultChars()): string {
  const original = content.length;
  if (original <= limit) return content;
  const mkMarker = (dropped: number): string => `\n\n…[truncated ${dropped} of ${original} chars]…\n\n`;
  const budget = Math.max(0, limit - mkMarker(original).length);
  const headLen = Math.floor(budget * HEAD_FRACTION);
  const tailLen = budget - headLen;
  const head = content.slice(0, headLen);
  const tail = tailLen > 0 ? content.slice(original - tailLen) : "";
  const dropped = original - head.length - tail.length;
  return head + mkMarker(dropped) + tail;
}
