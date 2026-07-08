import { defineState } from "eve/context";

export type NoReplyReason = "addressed_to_other" | "nothing_to_add" | "awaiting_context" | "duplicate" | "noise_reduction";

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
