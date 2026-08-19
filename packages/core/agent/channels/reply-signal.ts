import { defineState } from "eve/context";
import { END_TURN_WITH_SENTINEL_INSTRUCTION } from "./normalized-wake.js";

interface RepliedThisTurn {
  readonly turnId: string;
  readonly replied: true;
}

const slot = defineState<RepliedThisTurn | null>("open-everywhere.replied-this-turn", () => null);

export function markRepliedThisTurn(turnId: string | undefined): void {
  if (turnId === undefined || turnId.length === 0) return;
  try {
    slot.update(() => ({ turnId, replied: true }));
  } catch {
  }
}

export function consumeRepliedThisTurn(turnId: string | undefined): boolean {
  try {
    const cur = slot.get();
    const was = turnId !== undefined && turnId.length > 0 && cur !== null && cur.turnId === turnId;
    slot.update(() => null);
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

export function declinedWakesThisTurn(turnId: string | undefined): readonly string[] {
  if (turnId === undefined || turnId.length === 0) return [];
  try {
    const cur = declinedSlot.get();
    return cur !== null && cur.turnId === turnId ? cur.wakes : [];
  } catch {
    return [];
  }
}

interface RepliedWakes {
  readonly turnId: string;
  readonly wakes: readonly string[];
}

const repliedSlot = defineState<RepliedWakes | null>("open-everywhere.reply-replied-wakes", () => null);

export function markWakeRepliedThisTurn(turnId: string | undefined, wake: string | undefined): void {
  if (turnId === undefined || turnId.length === 0) return;
  if (typeof wake !== "string" || wake.length === 0) return;
  try {
    repliedSlot.update((prev) => {
      const wakes = prev !== null && prev.turnId === turnId ? prev.wakes : [];
      if (wakes.includes(wake) || wakes.length >= MAX_DONE_WAKES) return { turnId, wakes };
      return { turnId, wakes: [...wakes, wake] };
    });
  } catch {
  }
}

export function repliedWakesThisTurn(turnId: string | undefined): readonly string[] {
  if (turnId === undefined || turnId.length === 0) return [];
  try {
    const cur = repliedSlot.get();
    return cur !== null && cur.turnId === turnId ? cur.wakes : [];
  } catch {
    return [];
  }
}
