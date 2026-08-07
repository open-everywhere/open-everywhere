import { defineState } from "eve/context";
import type { LeanSeatPosture } from "./lean-seat.js";

interface LeanSeatWake {
  readonly lean: boolean;
  readonly dmSeat: boolean;
}

const leanSeatSlot = defineState<LeanSeatWake>("open-everywhere.lean-seat", () => ({ lean: false, dmSeat: false }));

export function setLeanSeatWake(lean: boolean, dmSeat = false): void {
  try {
    leanSeatSlot.update(() => ({ lean, dmSeat }));
  } catch {
  }
}

export function currentLeanSeatPosture(): LeanSeatPosture {
  try {
    return leanSeatSlot.get().lean ? "lean" : "full";
  } catch {
    return "full";
  }
}

export function currentLeanSeatIsDm(): boolean {
  try {
    return leanSeatSlot.get().dmSeat;
  } catch {
    return false;
  }
}
