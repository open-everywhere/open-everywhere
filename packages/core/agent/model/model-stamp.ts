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

export function swapModelStamp(modelId: string | null): string | null {
  try {
    const prev = slot.get();
    slot.update(() => modelId);
    return prev;
  } catch {
    return null;
  }
}

export async function withModelStampScope<T>(modelId: string, fn: () => Promise<T>): Promise<T> {
  const prev = swapModelStamp(modelId);
  try {
    return await fn();
  } finally {
    swapModelStamp(prev);
  }
}
