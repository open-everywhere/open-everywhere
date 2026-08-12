import { defineState } from "eve/context";

const slot = defineState<boolean>("open-everywhere.worker-seat", () => false);

export function setWorkerWake(worker: boolean): void {
  try {
    slot.update(() => worker);
  } catch {
  }
}

export function currentWorkerWake(): boolean {
  try {
    return slot.get();
  } catch {
    return false;
  }
}
