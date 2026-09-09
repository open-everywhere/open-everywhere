import { defineState } from "eve/context";

export type NativeDelegationVerdict =
  | "allow"
  | "leaf"
  | "no-seat"
  | "unclassified";

const slot = defineState<NativeDelegationVerdict>("open-everywhere.native-delegation", () => "unclassified");

export function setNativeDelegationSeat(verdict: NativeDelegationVerdict): void {
  try {
    slot.update(() => verdict);
  } catch {
  }
}

function currentNativeDelegationSeat(): NativeDelegationVerdict {
  try {
    return slot.get();
  } catch {
    return "unclassified";
  }
}

export function nativeAgentAllowedNow(): boolean {
  return currentNativeDelegationSeat() === "allow";
}
