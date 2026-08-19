import { defineState } from "eve/context";
import { currentLeanSeatPosture } from "./lean-seat-state.js";

export const SEAT_RECOVERY_READ_BUDGET = 4;

export function seatReadBudgetRefusal(toolName: string, used: number): string | null {
  if (used <= SEAT_RECOVERY_READ_BUDGET) return null;
  return (
    `\`${toolName}\` is refused: you have used your ${SEAT_RECOVERY_READ_BUDGET} recovery reads on this turn. ` +
    `Reading is how you recover a message somebody referred to that you cannot see — it is not how you work ` +
    `through a room. Do one of three things now. Answer from what you have already read. Or say plainly what ` +
    `you looked at and that you could not find it, which is a good answer. Or delegate a worker, which reads ` +
    `without this limit and reports back. Do not guess the content you could not find.`
  );
}

export class SeatReadBudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SeatReadBudgetError";
  }
}

const slot = defineState<number>("open-everywhere.seat-read-budget", () => 0);

export function noteSeatRead(): number {
  try {
    const next = slot.get() + 1;
    slot.update(() => next);
    return next;
  } catch {
    return 0;
  }
}

export function resetSeatReadBudget(): void {
  try {
    slot.update(() => 0);
  } catch {
  }
}

export function assertSeatReadBudget(toolName: string): void {
  if (currentLeanSeatPosture() !== "lean") return;
  const refusal = seatReadBudgetRefusal(toolName, noteSeatRead());
  if (refusal !== null) throw new SeatReadBudgetError(refusal);
}
