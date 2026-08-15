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

interface DoneWakes {
  readonly turnId: string;
  readonly wakes: readonly string[];
}

const doneSlot = defineState<DoneWakes | null>("open-everywhere.reply-done-wakes", () => null);

const MAX_DONE_WAKES = 32;

export function markWakeDoneThisTurn(turnId: string | undefined, wake: string): void {
  if (turnId === undefined || turnId.length === 0) return;
  if (typeof wake !== "string" || wake.length === 0) return;
  try {
    doneSlot.update((prev) => {
      const wakes = prev !== null && prev.turnId === turnId ? prev.wakes : [];
      if (wakes.includes(wake) || wakes.length >= MAX_DONE_WAKES) return { turnId, wakes };
      return { turnId, wakes: [...wakes, wake] };
    });
  } catch {
  }
}

export function isWakeDoneThisTurn(turnId: string | undefined, wake: string): boolean {
  if (turnId === undefined || turnId.length === 0) return false;
  try {
    const cur = doneSlot.get();
    return cur !== null && cur.turnId === turnId && cur.wakes.includes(wake);
  } catch {
    return false;
  }
}
