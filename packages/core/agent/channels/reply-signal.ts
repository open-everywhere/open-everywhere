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

export const WAKE_DONE_REFUSAL_REASON = "answered-this-turn";

export const WAKE_DONE_FORCED_AUDIT_REASON = "answered-this-turn-forced";

export function isWakeDoneThisTurn(turnId: string | undefined, wake: string): boolean {
  if (turnId === undefined || turnId.length === 0) return false;
  try {
    const cur = doneSlot.get();
    return cur !== null && cur.turnId === turnId && cur.wakes.includes(wake);
  } catch {
    return false;
  }
}

interface DoneRefusedWakes {
  readonly turnId: string;
  readonly wakes: readonly string[];
}

const doneRefusedSlot = defineState<DoneRefusedWakes | null>("open-everywhere.reply-done-refused-wakes", () => null);

export function markDoneRefusedThisTurn(turnId: string | undefined, wake: string | undefined): void {
  if (turnId === undefined || turnId.length === 0) return;
  if (typeof wake !== "string" || wake.length === 0) return;
  try {
    doneRefusedSlot.update((prev) => {
      const wakes = prev !== null && prev.turnId === turnId ? prev.wakes : [];
      if (wakes.includes(wake) || wakes.length >= MAX_DONE_WAKES) return { turnId, wakes };
      return { turnId, wakes: [...wakes, wake] };
    });
  } catch {
  }
}

export function wasDoneRefusedThisTurn(turnId: string | undefined, wake: string): boolean {
  if (turnId === undefined || turnId.length === 0) return false;
  try {
    const cur = doneRefusedSlot.get();
    return cur !== null && cur.turnId === turnId && cur.wakes.includes(wake);
  } catch {
    return false;
  }
}

export function secondMessageValve(canForce: boolean): string {
  return canForce
    ? "A second message is DISCOURAGED, not blocked: pass `force: true` and it posts, or send this same call again — this check will not refuse it twice, though a later one still can. It costs the room a near-duplicate to read, and the override is recorded."
    : "A second message is DISCOURAGED, not blocked: send this same call again and it posts. It costs the room a near-duplicate to read.";
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

interface StoppedAckSpent {
  readonly turnId: string;
  readonly spent: true;
}

const stoppedAckSlot = defineState<StoppedAckSpent | null>("open-everywhere.reply-stopped-ack", () => null);

export const REPLY_STOPPED_REFUSAL_REASON = "stopped";

export function markStoppedAckThisTurn(turnId: string | undefined): void {
  if (turnId === undefined || turnId.length === 0) return;
  try {
    stoppedAckSlot.update(() => ({ turnId, spent: true }));
  } catch {
  }
}

export function wasStoppedAckSpentThisTurn(turnId: string | undefined): boolean {
  if (turnId === undefined || turnId.length === 0) return false;
  try {
    const cur = stoppedAckSlot.get();
    return cur !== null && cur.turnId === turnId;
  } catch {
    return false;
  }
}

export function stoppedRefusalMessage(): string {
  return (
    "You were asked to stand down in this conversation and that stop is recorded, so nothing was posted. " +
    "Your acknowledgement has already gone out; anything further here is exactly what the person asked you to stop doing. " +
    `${END_TURN_WITH_SENTINEL_INSTRUCTION} Someone @mentioning you is what brings you back.`
  );
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

interface RefusedWakes {
  readonly turnId: string;
  readonly entries: readonly { readonly wake: string; readonly reason: string }[];
}

const refusedSlot = defineState<RefusedWakes | null>("open-everywhere.reply-refused-wakes", () => null);

export function markWakeRefusedThisTurn(turnId: string | undefined, wake: string | undefined, reason: string): void {
  if (turnId === undefined || turnId.length === 0) return;
  if (typeof wake !== "string" || wake.length === 0) return;
  if (typeof reason !== "string" || reason.length === 0) return;
  try {
    refusedSlot.update((prev) => {
      const entries = prev !== null && prev.turnId === turnId ? prev.entries : [];
      if (entries.length >= MAX_DONE_WAKES) return { turnId, entries };
      if (entries.some((e) => e.wake === wake && e.reason === reason)) return { turnId, entries };
      return { turnId, entries: [...entries, { wake, reason }] };
    });
  } catch {
  }
}

export function refusalsForWakeThisTurn(turnId: string | undefined, wake: string | undefined): readonly string[] {
  if (turnId === undefined || turnId.length === 0) return [];
  if (typeof wake !== "string" || wake.length === 0) return [];
  try {
    const cur = refusedSlot.get();
    if (cur === null || cur.turnId !== turnId) return [];
    return cur.entries.filter((e) => e.wake === wake).map((e) => e.reason);
  } catch {
    return [];
  }
}
