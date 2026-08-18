import { defineState } from "eve/context";
import { END_TURN_WITH_SENTINEL_INSTRUCTION } from "./normalized-wake.js";

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

interface DeclinedWakes {
  readonly turnId: string;
  readonly wakes: readonly string[];
}

const declinedSlot = defineState<DeclinedWakes | null>("open-everywhere.reply-declined-wakes", () => null);

export function markWakeDeclinedThisTurn(turnId: string | undefined, wake: string | undefined): void {
  if (turnId === undefined || turnId.length === 0) return;
  if (typeof wake !== "string" || wake.length === 0) return;
  try {
    declinedSlot.update((prev) => {
      const wakes = prev !== null && prev.turnId === turnId ? prev.wakes : [];
      if (wakes.includes(wake) || wakes.length >= MAX_DONE_WAKES) return { turnId, wakes };
      return { turnId, wakes: [...wakes, wake] };
    });
  } catch {
  }
}

export const WAKE_DECLINED_REFUSAL_REASON = "declined-this-turn";

export function wakeDeclinedRefusalMessage(): string {
  return (
    "You already called `no_reply` for this wake in this turn, so it is closed and nothing was posted. " +
    `${END_TURN_WITH_SENTINEL_INSTRUCTION} ` +
    "Disregard any notice saying an empty reply was not delivered — silence is this turn's answer."
  );
}

export function isWakeDeclinedThisTurn(turnId: string | undefined, wake: string): boolean {
  if (turnId === undefined || turnId.length === 0) return false;
  try {
    const cur = declinedSlot.get();
    return cur !== null && cur.turnId === turnId && cur.wakes.includes(wake);
  } catch {
    return false;
  }
}
