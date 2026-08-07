import { defineState } from "eve/context";

interface TaintState {
  readonly turn?: string;
  readonly tainted: boolean;
}

const slot = defineState<TaintState>("open-everywhere.untrusted-ingested", () => ({ tainted: false }));

function readState(v: unknown): TaintState {
  if (v === true) return { tainted: true };
  if (v === false || v === undefined || v === null) return { tainted: false };
  if (typeof v === "object" && "tainted" in (v as Record<string, unknown>)) {
    const s = v as { turn?: unknown; tainted?: unknown };
    return { turn: typeof s.turn === "string" ? s.turn : undefined, tainted: s.tainted === true };
  }
  return { tainted: false };
}

export function beginTaintTurn(turnId: string | undefined): void {
  try {
    slot.update((cur) => {
      const state = readState(cur);
      if (turnId === undefined) return state;
      if (state.turn === turnId) return state;
      return { turn: turnId, tainted: false };
    });
  } catch {
  }
}

export function markUntrustedIngestedThisTurn(): void {
  try {
    slot.update((cur) => {
      const state = readState(cur);
      return state.tainted ? state : { turn: state.turn, tainted: true };
    });
  } catch {
  }
}

export function untrustedIngestedThisTurn(): boolean {
  try {
    return readState(slot.get()).tainted;
  } catch {
    return false;
  }
}

export const OE_TAINTED_FIRE_ATTR = "oe_tainted_fire";

export function taintedFireAttrs(tainted: boolean): Record<string, string> {
  return tainted ? { [OE_TAINTED_FIRE_ATTR]: "true" } : {};
}

export const OE_RESULT_TAINTED_ATTR = "oe_result_tainted";

export function resultTaintedAttrs(tainted: boolean): Record<string, string> {
  return tainted ? { [OE_RESULT_TAINTED_ATTR]: "true" } : {};
}
