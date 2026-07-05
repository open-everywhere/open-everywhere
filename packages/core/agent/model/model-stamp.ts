import { defineState } from "eve/context";

const slot = defineState<string | null>("open-everywhere.model-stamp", () => null);

export function stampModelCall(modelId: string): void {
  try {
    slot.update(() => modelId);
  } catch {
  }
}

export function readModelStamp(): string | null {
  try {
    return slot.get();
  } catch {
    return null;
  }
}
