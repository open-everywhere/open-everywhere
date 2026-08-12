import { defineState } from "eve/context";
import type { InvokerPosture } from "./invoker-posture.js";

const slot = defineState<InvokerPosture>("open-everywhere.invoker-posture", () => "interactive");

export function setInvokerPosture(posture: InvokerPosture): void {
  try {
    slot.update(() => posture);
  } catch {
  }
}

export function currentInvokerPosture(): InvokerPosture {
  try {
    return slot.get();
  } catch {
    return "interactive";
  }
}
