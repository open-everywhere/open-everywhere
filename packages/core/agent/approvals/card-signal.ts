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
  readonly cardKnown: boolean;
}

interface RunRefusalLedger {
  readonly turnId: string;
  readonly entries: readonly RoutineRunPermissionRefusal[];
}

const refusals = defineState<RunRefusalLedger | null>("open-everywhere.routine-run-permission-refusals", () => null);

const MAX_RUN_REFUSALS = 16;

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

export function consumeRoutineRunPermissionRefusals(): readonly RoutineRunPermissionRefusal[] {
  try {
    const held = refusals.get();
    if (held === null) return [];
    const mine = held.turnId === currentTurnKey() ? held.entries : [];
    refusals.update(() => null);
    return mine;
  } catch {
    return [];
  }
}
