import { defineState } from "eve/context";
import type { InvokerPosture } from "./invoker-posture.js";
import { readWakeSlot, writeWakeSlot } from "./wake-slot.js";

const SLOT = "open-everywhere.invoker-posture";
const slot = defineState<InvokerPosture>(SLOT, () => "interactive");

export function setInvokerPosture(posture: InvokerPosture): void {
  writeWakeSlot(SLOT, () => slot.update(() => posture));
}

export function currentInvokerPosture(): InvokerPosture {
  return readWakeSlot<InvokerPosture>(SLOT, () => slot.get(), { contextless: "interactive", restricting: "untrusted-remote" });
}
