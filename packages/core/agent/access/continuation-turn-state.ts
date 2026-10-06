import { defineState } from "eve/context";
import { currentSessionId, currentTurnId, isUnifiedWindowContext, type BindableContext } from "../identity/binding.js";

export interface ContinuationTurn {
  readonly sessionId: string;
  readonly turnId: string;
  readonly unified: boolean;
}

const slot = defineState<ContinuationTurn | null>("open-everywhere.continuation-turn", () => null);

export function noteContinuationTurn(ctx: BindableContext): void {
  let next: ContinuationTurn | null = null;
  try {
    const sessionId = currentSessionId(ctx);
    const turnId = currentTurnId(ctx);
    if (sessionId !== undefined && turnId !== undefined) next = { sessionId, turnId, unified: isUnifiedWindowContext(ctx) };
  } catch {
    next = null;
  }
  try {
    slot.update(() => next);
  } catch {
  }
}

export function currentContinuationTurn(): ContinuationTurn | null {
  try {
    return slot.get();
  } catch {
    return null;
  }
}
