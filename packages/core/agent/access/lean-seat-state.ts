import { defineState } from "eve/context";
import type { LeanSeatPosture } from "./lean-seat.js";
import { readWakeSlot, writeWakeSlot } from "./wake-slot.js";

interface LeanSeatWake {
  readonly lean: boolean;
  readonly dmSeat: boolean;
}

const SLOT = "open-everywhere.lean-seat";
const leanSeatSlot = defineState<LeanSeatWake>(SLOT, () => ({ lean: false, dmSeat: false }));

export function setLeanSeatWake(lean: boolean, dmSeat = false): void {
  writeWakeSlot(SLOT, () => leanSeatSlot.update(() => ({ lean, dmSeat })));
}

export function currentLeanSeatPosture(): LeanSeatPosture {
  return readWakeSlot<LeanSeatPosture>(SLOT, () => (leanSeatSlot.get().lean ? "lean" : "full"), { contextless: "full", restricting: "lean" });
}

export function currentLeanSeatIsDm(): boolean {
  return readWakeSlot(SLOT, () => leanSeatSlot.get().dmSeat, { contextless: false, restricting: false });
}

export type WorkTierVerdict = "work" | "forwards" | "child" | "none";

const workTierSlot = defineState<WorkTierVerdict>("open-everywhere.work-tier", () => "none");

export function setWorkTierWake(verdict: WorkTierVerdict): void {
  try {
    workTierSlot.update(() => verdict);
  } catch {
  }
}

const workSessionTokenSlot = defineState<string | undefined>("open-everywhere.work-session-token", () => undefined);

export function setWorkSessionToken(token: string | undefined): void {
  try {
    workSessionTokenSlot.update(() => token);
  } catch {
  }
}

export function currentWorkSessionToken(): string | undefined {
  try {
    return workSessionTokenSlot.get();
  } catch {
    return undefined;
  }
}

export function currentWorkTier(): WorkTierVerdict {
  try {
    return workTierSlot.get();
  } catch {
    return "none";
  }
}
