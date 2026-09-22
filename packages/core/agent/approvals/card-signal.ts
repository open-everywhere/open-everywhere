import { defineState } from "eve/context";
import { readTurnClock } from "../observability/turn-clock.js";

const slot = defineState<boolean>("open-everywhere.approval-card-posted", () => false);

export function markCardPostedThisTurn(): void {
  try {
    slot.update(() => true);
  } catch {
  }
}

export function peekCardPostedThisTurn(): boolean {
  try {
    return slot.get();
  } catch {
    return false;
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

export interface RoutineRunPermissionRefusal {
  readonly permission: string;
  readonly card: string | null;
  readonly cardPosted: boolean;
  readonly cardCapped: boolean;
  readonly cardKnown: boolean;
}

interface RunRefusalLedger {
  readonly carriedForWakeId?: string;
  readonly turnId: string;
  readonly entries: readonly RoutineRunPermissionRefusal[];
}

const refusals = defineState<RunRefusalLedger | null>("open-everywhere.routine-run-permission-refusals", () => null);

export const MAX_RUN_REFUSALS = 16;

const CARRIED_TURN_KEY = "carried:redrive";

function currentTurnKey(): string {
  return readTurnClock()?.turnId ?? "";
}

export function noteRoutineRunPermissionRefusal(entry: RoutineRunPermissionRefusal): void {
  try {
    const turnId = currentTurnKey();
    refusals.update((prev) => {
      const entries = prev !== null && prev.turnId === turnId ? prev.entries : [];
      if (entries.some((e) => e.permission === entry.permission) || entries.length >= MAX_RUN_REFUSALS) return { turnId, entries };
      return { turnId, entries: [...entries, entry] };
    });
  } catch {
  }
}

export function consumeRoutineRunPermissionRefusals(wakeId?: string): readonly RoutineRunPermissionRefusal[] {
  try {
    const held = refusals.get();
    if (held === null) return [];
    const carried = held.carriedForWakeId !== undefined && wakeId !== undefined && held.carriedForWakeId === wakeId;
    const mine = held.turnId === currentTurnKey() || carried ? held.entries : [];
    if (mine.length > 0 || held.carriedForWakeId === undefined) refusals.update(() => null);
    return mine;
  } catch {
    return [];
  }
}

export function carryRunRefusalsToRedrive(wakeId: string): void {
  try {
    const turnId = currentTurnKey();
    refusals.update((prev) => (prev === null || prev.entries.length === 0 || prev.turnId !== turnId ? prev : { carriedForWakeId: wakeId, turnId: CARRIED_TURN_KEY, entries: prev.entries }));
  } catch {
  }
}

export function dropCarriedRunRefusals(wakeId: string): void {
  try {
    refusals.update((prev) => (prev !== null && prev.carriedForWakeId === wakeId ? null : prev));
  } catch {
  }
}
