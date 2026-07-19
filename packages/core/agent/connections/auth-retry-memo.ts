import { defineState } from "eve/context";

export function markInSet(set: Set<string>, connector: string): void {
  set.add(connector);
}

export function hasInSet(set: Set<string>, connector: string): boolean {
  return set.has(connector);
}

export function connectorAuthRequiredError(connector: string): Error {
  return new Error(
    `connection "${connector}": authorization is required and already failed this turn — not ` +
      `retrying (deterministic within a turn). Authorize the connector, then ask again on a new turn.`,
  );
}

const slot = defineState<Set<string> | null>("open-everywhere.connector-auth-required-turn", () => null);

export function markConnectorAuthRequired(connector: string): void {
  try {
    const set = slot.get() ?? new Set<string>();
    markInSet(set, connector);
    slot.update(() => set);
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

export function resetConnectorAuthMemo(): void {
  try {
    slot.update(() => new Set<string>());
  } catch {
  }
}
