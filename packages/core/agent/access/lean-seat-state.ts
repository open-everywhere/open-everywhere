import { defineState } from "eve/context";
import type { LeanSeatPosture } from "./lean-seat.js";

const leanSeatSlot = defineState<boolean>("open-everywhere.lean-seat", () => false);

export function setLeanSeatWake(lean: boolean): void {
  try {
    leanSeatSlot.update(() => lean);
  } catch {
  }
}

export function currentLeanSeatPosture(): LeanSeatPosture {
  try {
    return leanSeatSlot.get() ? "lean" : "full";
  } catch {
    return "full";
  }
}
