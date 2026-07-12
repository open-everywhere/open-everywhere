import { defineState } from "eve/context";

export type NoReplyReason =
  | "addressed_to_other"
  | "reacted_instead"
  | "nothing_to_add"
  | "not_relevant"
  | "duplicate"
  | "user_requested_silence"
  | "awaiting_context"
  | "noise_reduction"
  | "other";

const slot = defineState<NoReplyReason | null>("open-everywhere.no-reply-tool-called", () => null);

export function markNoReplyThisTurn(reason: NoReplyReason): void {
  try {
    slot.update(() => reason);
  } catch {
  }
}

export function peekNoReplyThisTurn(): NoReplyReason | null {
  try {
    return slot.get();
  } catch {
    return null;
  }
}

export function consumeNoReplyThisTurn(): NoReplyReason | null {
  try {
    const was = slot.get();
    slot.update(() => null);
    return was;
  } catch {
    return null;
  }
}
