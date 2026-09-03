import { defineState } from "eve/context";

export const SILENT_ROUTINE_DROP_REASON = "silent routine — terminal prose dropped";

const slot = defineState<boolean>("open-everywhere.silent-routine-turn", () => false);

export function markSilentRoutineTurn(): void {
  try {
    slot.update(() => true);
  } catch {
  }
}

export function clearSilentRoutineTurn(): void {
  try {
    slot.update(() => false);
  } catch {
  }
}

export function silentRoutineThisTurn(): boolean {
  try {
    return slot.get() === true;
  } catch {
    return false;
  }
}

import type { RoutineRunPermissionRefusal } from "../approvals/card-signal.js";

export const RUN_REFUSAL_HEADING = "This run asked for permissions it does not have:";

export function withRunRefusalBlock(text: string, refused: readonly RoutineRunPermissionRefusal[]): string {
  if (refused.length === 0) return text;
  const lines = refused.map((r) => `• ${r.permission} — ${pointerPhrase(r)}`);
  return `${text}\n\n${RUN_REFUSAL_HEADING}\n${lines.join("\n")}`;
}

function pointerPhrase(r: RoutineRunPermissionRefusal): string {
  if (r.cardCapped) return "no card was offered for it — this run reached its card limit";
  if (r.card !== null) return `its card is waiting at ${r.card}`;
  if (r.cardPosted) return "its card is waiting in the routine's own room";
  return r.cardKnown ? "no card is waiting for it" : "whether a card is waiting for it could not be read";
}
