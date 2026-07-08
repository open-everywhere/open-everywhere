import { defineState } from "eve/context";

const slot = defineState<boolean>("open-everywhere.reacted-this-turn", () => false);

export function markReactedThisTurn(): void {
  try {
    slot.update(() => true);
  } catch {
  }
}

export function consumeReactedThisTurn(): boolean {
  try {
    const was = slot.get();
    slot.update(() => false);
    return was;
  } catch {
    return false;
  }
}
