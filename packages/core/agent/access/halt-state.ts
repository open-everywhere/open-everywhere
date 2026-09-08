import { defineState } from "eve/context";

const slot = defineState<boolean | null>("open-everywhere.halted", () => null);

export function stampHalted(halted: boolean): void {
  try {
    slot.update(() => halted);
  } catch {
  }
}

export function currentHaltStamp(): boolean | null {
  try {
    return slot.get();
  } catch {
    return null;
  }
}
