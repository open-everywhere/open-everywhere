import { defineState } from "eve/context";

interface WrapState {
  readonly turn?: string;
  readonly wrapped: boolean;
}

const slot = defineState<WrapState>("open-everywhere.memory.envelope-wrapped", () => ({ wrapped: false }));

function readState(v: unknown): WrapState {
  if (typeof v !== "object" || v === null) return { wrapped: false };
  const s = v as { turn?: unknown; wrapped?: unknown };
  return { ...(typeof s.turn === "string" ? { turn: s.turn } : {}), wrapped: s.wrapped === true };
}

export function beginMemoryProvenanceTurn(turnId: string | undefined): void {
  try {
    slot.update((cur) => {
      const state = readState(cur);
      if (turnId !== undefined && state.turn === turnId) return state;
      return { ...(turnId !== undefined ? { turn: turnId } : {}), wrapped: false };
    });
  } catch {
  }
}

export function noteEnvelopeWrapThisTurn(): void {
  try {
    slot.update((cur) => {
      const state = readState(cur);
      return state.wrapped ? state : { ...state, wrapped: true };
    });
  } catch {
  }
}

export function envelopeWrappedThisTurn(turnId: string | undefined): boolean {
  try {
    const state = readState(slot.get());
    return state.wrapped && state.turn === turnId;
  } catch {
    return false;
  }
}
