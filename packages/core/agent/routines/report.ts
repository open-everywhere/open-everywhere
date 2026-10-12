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

export const RUN_REFUSAL_HEADING = "This run couldn't do these steps without approval:";

export function withRunRefusalBlock(text: string, refused: readonly RoutineRunPermissionRefusal[]): string {
  if (refused.length === 0) return text;
  const lines = refused.map((r) => `• ${r.permission} — ${pointerPhrase(r)}`);
  return `${text}\n\n${RUN_REFUSAL_HEADING}\n${lines.join("\n")}`;
}

function pointerPhrase(r: RoutineRunPermissionRefusal): string {
  if (r.cardCapped) return "not asked this time, because this run already sent as many requests as it may";
  if (r.card !== null) return `waiting for approval: ${r.card}`;
  if (r.cardPosted) return "waiting for approval in this routine's channel";
  return r.cardKnown ? "no approval request is open" : "I couldn't check whether an approval request is open";
}
