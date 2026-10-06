import { defineState } from "eve/context";
import { readWakeSlot, writeWakeSlot } from "./wake-slot.js";

const SLOT = "open-everywhere.halted";
const slot = defineState<boolean | null>(SLOT, () => null);

export function stampHalted(halted: boolean): void {
  writeWakeSlot(SLOT, () => slot.update(() => halted));
}

export function currentHaltStamp(): boolean | null {
  return readWakeSlot<boolean | null>(SLOT, () => slot.get(), { contextless: null, restricting: true });
}
