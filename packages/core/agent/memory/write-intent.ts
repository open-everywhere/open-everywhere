import { defineState } from "eve/context";

export const REMEMBER_ASK_PATTERNS: readonly RegExp[] = [
  /(?<!\b(?:i|we|you|they|he|she|it|nobody|everybody|everyone)\s)\bremember\s*(?::|\b(?:this|that|these|those|it|the|my|our|your|his|her|their|to)\b)/i,
  /\b(?:can|could|would|will)\s+you\s+(?:please\s+)?remember\b/i,
  /\b(?:save|store|put|add|commit|append)\b[^.!?\n]{0,40}?\b(?:to|in|into)\s+(?:the\s+|your\s+|our\s+|my\s+|team\s+)*(?:memory|notes?|silo|brain)\b/i,
  /\b(?:note|write|jot)\s+(?:this|that|it|these|those)\s+down\b|\bmake\s+a\s+note\s+of\b/i,
  /\bkeep\s+(?:this|that|it|these|those)\s+in\s+mind\b|\bdon'?t\s+forget\b/i,
];

export function isRememberAsk(text: string | undefined): boolean {
  if (typeof text !== "string" || text.length === 0) return false;
  return REMEMBER_ASK_PATTERNS.some((re) => re.test(text));
}

const slot = defineState<{ armed: boolean }>("open-everywhere.memory.writeIntent", () => ({ armed: false }));

export function noteWriteIntent(text: string | undefined): void {
  if (!isRememberAsk(text)) return;
  try {
    slot.update(() => ({ armed: true }));
  } catch {
  }
}

export function writeIntentArmed(): boolean {
  try {
    return slot.get().armed === true;
  } catch {
    return false;
  }
}

export function consumeWriteIntent(): void {
  try {
    slot.update(() => ({ armed: false }));
  } catch {
  }
}
