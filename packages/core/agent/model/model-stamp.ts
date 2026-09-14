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

const GATEWAY_MODEL_ID_PREFIX = "gateway/";

const hostSlot = defineState<string | null>("open-everywhere.host-step-model", () => null);

export function registryModelIdFrom(hostModelId: unknown): string | undefined {
  if (typeof hostModelId !== "string") return undefined;
  const id = hostModelId.trim();
  if (id.length === 0) return undefined;
  const rest = id.startsWith(GATEWAY_MODEL_ID_PREFIX) ? id.slice(GATEWAY_MODEL_ID_PREFIX.length) : id;
  return rest.includes("/") ? rest : id;
}

export function noteHostStepModel(hostModelId: unknown): void {
  const id = registryModelIdFrom(hostModelId);
  if (id === undefined) return;
  try {
    hostSlot.update(() => id);
  } catch {
  }
}

export function readHostStepModel(): string | null {
  try {
    return hostSlot.get();
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
