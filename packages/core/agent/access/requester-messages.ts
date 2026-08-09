import { defineState } from "eve/context";

interface RequesterMessagesState {
  readonly turn?: string;
  readonly messages: readonly string[];
}

const slot = defineState<RequesterMessagesState>("open-everywhere.requester-messages", () => ({ messages: [] }));

const MAX_MESSAGES = 6;
const MAX_MESSAGE_CHARS = 2000;

function readState(v: unknown): RequesterMessagesState {
  if (typeof v === "object" && v !== null && Array.isArray((v as { messages?: unknown }).messages)) {
    const s = v as { turn?: unknown; messages: unknown[] };
    return {
      turn: typeof s.turn === "string" ? s.turn : undefined,
      messages: s.messages.filter((m): m is string => typeof m === "string"),
    };
  }
  return { messages: [] };
}

export function recordRequesterMessage(turnId: string | undefined, text: string): void {
  const clipped = text.length > MAX_MESSAGE_CHARS ? `${text.slice(0, MAX_MESSAGE_CHARS)}…[truncated]` : text;
  if (clipped.trim().length === 0) return;
  try {
    slot.update((cur) => {
      const state = readState(cur);
      const sameTurn = turnId !== undefined && state.turn === turnId;
      const messages = [...(sameTurn ? state.messages : []), clipped].slice(-MAX_MESSAGES);
      return { ...(turnId !== undefined ? { turn: turnId } : {}), messages };
    });
  } catch {
  }
}

export function requesterMessagesThisTurn(): readonly string[] {
  try {
    return readState(slot.get()).messages;
  } catch {
    return [];
  }
}
