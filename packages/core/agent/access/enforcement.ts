import { defineState } from "eve/context";

const slot = defineState<boolean>("open-everywhere.egress-enforced", () => true);

export function stampEnforcement(enforced: boolean): void {
  try {
    slot.update(() => enforced);
  } catch {
  }
}

export function isEnforced(): boolean {
  try {
    return slot.get();
  } catch {
    return true;
  }
}
