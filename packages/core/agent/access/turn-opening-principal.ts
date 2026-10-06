import { defineState } from "eve/context";
import { authPrincipalId, currentTurnId, isSubagentChildContext, type BindableContext } from "../identity/binding.js";

interface OpeningState {
  readonly turn?: string;
  readonly principal?: string | null;
}

const slot = defineState<OpeningState>("open-everywhere.turn-opening-principal", () => ({}));

function readState(v: unknown): OpeningState {
  if (v === null || typeof v !== "object") return {};
  const s = v as { turn?: unknown; principal?: unknown };
  if (typeof s.turn !== "string" || s.turn.length === 0) return {};
  if (s.principal !== null && (typeof s.principal !== "string" || s.principal.length === 0)) return {};
  return { turn: s.turn, principal: s.principal };
}

export function noteTurnOpeningPrincipal(ctx: BindableContext): void {
  try {
    if (isSubagentChildContext(ctx)) return;
    const turn = currentTurnId(ctx);
    if (turn === undefined) return;
    const principal = authPrincipalId(ctx) ?? null;
    slot.update(() => ({ turn, principal }));
  } catch {
  }
}

export function liveAuthIsAnotherPrincipal(ctx: BindableContext): boolean {
  try {
    const turn = currentTurnId(ctx);
    if (turn === undefined) return false;
    const state = readState(slot.get());
    if (state.turn !== turn || state.principal === undefined) return false;
    return (authPrincipalId(ctx) ?? null) !== state.principal;
  } catch {
    return false;
  }
}
