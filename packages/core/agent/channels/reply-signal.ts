import { defineState } from "eve/context";

const slot = defineState<boolean>("open-everywhere.replied-this-turn", () => false);

export function markRepliedThisTurn(): void {
  try {
    slot.update(() => true);
  } catch {
  }
}

export function consumeRepliedThisTurn(): boolean {
  try {
    const was = slot.get();
    slot.update(() => false);
    return was;
  } catch {
    return false;
  }
}
