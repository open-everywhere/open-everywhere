import { defineState } from "eve/context";

export function markInSet(set: Set<string>, connector: string): void {
  set.add(connector);
}

export function hasInSet(set: Set<string>, connector: string): boolean {
  return set.has(connector);
}

export function clearFromSet(set: Set<string>, connector: string): void {
  set.delete(connector);
}

export async function freshGrantConfirmed(probe: (() => Promise<boolean>) | undefined): Promise<boolean> {
  if (!probe) return false;
  try {
    return await probe();
  } catch {
    return false;
  }
}

export function connectorAuthRequiredError(connector: string, url?: string): Error {
  return new Error(
    `connection "${connector}": authorization is required and already failed this turn — not ` +
      `retrying (deterministic within a turn). ` +
      (url
        ? `Open your personal authorization link (expires soon): ${url} — complete it, then ask again on a new turn.`
        : `Authorize the connector, then ask again on a new turn.`),
  );
}

const slot = defineState<Set<string> | null>("open-everywhere.connector-auth-required-turn", () => null);
const urlSlot = defineState<Map<string, string> | null>("open-everywhere.connector-auth-url-turn", () => null);

export function markConnectorAuthRequired(connector: string, url?: string): void {
  try {
    const set = slot.get() ?? new Set<string>();
    markInSet(set, connector);
    slot.update(() => set);
    if (url) {
      const map = urlSlot.get() ?? new Map<string, string>();
      map.set(connector, url);
      urlSlot.update(() => map);
    }
  } catch {
  }
}

export function connectorAuthRequiredThisTurn(connector: string): boolean {
  try {
    const set = slot.get();
    return set ? hasInSet(set, connector) : false;
  } catch {
    return false;
  }
}

export function connectorAuthUrlThisTurn(connector: string): string | undefined {
  try {
    return urlSlot.get()?.get(connector);
  } catch {
    return undefined;
  }
}

export function resetConnectorAuthMemo(): void {
  try {
    slot.update(() => new Set<string>());
    urlSlot.update(() => new Map<string, string>());
  } catch {
  }
}

export function clearConnectorAuthRequired(connector: string): void {
  try {
    const set = slot.get();
    if (set) {
      clearFromSet(set, connector);
      slot.update(() => set);
    }
    const map = urlSlot.get();
    if (map) {
      map.delete(connector);
      urlSlot.update(() => map);
    }
  } catch {
  }
}
