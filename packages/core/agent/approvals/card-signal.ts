import { defineState } from "eve/context";

const slot = defineState<boolean>("open-everywhere.approval-card-posted", () => false);

export function markCardPostedThisTurn(): void {
  try {
    slot.update(() => true);
  } catch {
  }
}

export function consumeCardPostedThisTurn(): boolean {
  try {
    const was = slot.get();
    slot.update(() => false);
    return was;
  } catch {
    return false;
  }
}
