import { defineState } from "eve/context";
import { untrustedIngestedThisTurn } from "./taint-signal.js";

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

export function currentNativeDelegationSeat(): NativeDelegationVerdict {
  try {
    return slot.get();
  } catch {
    return "unclassified";
  }
}

export function nativeAgentAllowedNow(): boolean {
  if (currentNativeDelegationSeat() !== "allow") return false;
  return !untrustedIngestedThisTurn();
}
