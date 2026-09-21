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

export const MAX_UNSERVED_POSTS = 4;

interface WriteIntentState {
  readonly armed: boolean;
  readonly unserved: number;
}

const slot = defineState<WriteIntentState>("open-everywhere.memory.writeIntent", () => ({ armed: false, unserved: 0 }));

function readState(v: unknown): WriteIntentState {
  const s = (v ?? {}) as { armed?: unknown; unserved?: unknown };
  const unserved = typeof s.unserved === "number" && Number.isFinite(s.unserved) && s.unserved > 0 ? s.unserved : 0;
  return { armed: s.armed === true, unserved };
}

export function noteWriteIntent(text: string | undefined): void {
  if (!isRememberAsk(text)) return;
  try {
    slot.update(() => ({ armed: true, unserved: 0 }));
  } catch {
  }
}

export function writeIntentArmed(): boolean {
  try {
    return readState(slot.get()).armed;
  } catch {
    return false;
  }
}

export function noteUnservedPost(): void {
  try {
    slot.update((s) => {
      const state = readState(s);
      if (!state.armed) return state;
      const unserved = state.unserved + 1;
      return unserved >= MAX_UNSERVED_POSTS ? { armed: false, unserved: 0 } : { armed: true, unserved };
    });
  } catch {
  }
}

export function consumeWriteIntent(): void {
  try {
    slot.update(() => ({ armed: false, unserved: 0 }));
  } catch {
  }
}
