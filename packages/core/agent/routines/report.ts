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
