import { defineState } from "eve/context";

const slot = defineState<boolean>("open-everywhere.untrusted-ingested", () => false);

export function markUntrustedIngestedThisTurn(): void {
  try {
    slot.update(() => true);
  } catch {
  }
}

export function untrustedIngestedThisTurn(): boolean {
  try {
    return slot.get();
  } catch {
    return false;
  }
}

export const OE_TAINTED_FIRE_ATTR = "oe_tainted_fire";

export function taintedFireAttrs(tainted: boolean): Record<string, string> {
  return tainted ? { [OE_TAINTED_FIRE_ATTR]: "true" } : {};
}
