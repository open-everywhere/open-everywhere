import { defineState } from "eve/context";

export interface PendingDelegation {
  readonly taskId: string;
  readonly parentWakeId?: string;
}

interface PendingDelegationState {
  readonly turn?: string;
  readonly pending?: readonly PendingDelegation[];
}

const slot = defineState<PendingDelegationState>("open-everywhere.pending-delegation", () => ({}));

const MAX_PENDING = 16;

export const DELEGATION_PENDING_REFUSAL_REASON = "delegation-pending";

export const BRIDGE_WAKE_HELD_AUDIT_ACTION = "turn.direct_mention_bridge_wake_held";

export function delegationPendingRefusalMessage(): string {
  return (
    "reply: NOTHING was posted. You started a background worker for this conversation in this turn, " +
    "and its report has not arrived. You therefore do not hold the answer it was asked for. " +
    "Do not write that answer from what you believe you know — that is a fabrication, even when it " +
    "looks right. Post a short hand-off note with `done:false` instead. That keeps this wake " +
    "answerable, so you can give the real answer the moment the worker's own report reaches you."
  );
}

function readState(v: unknown): PendingDelegationState {
  if (v === null || typeof v !== "object") return {};
  const s = v as { turn?: unknown; pending?: unknown };
  if (typeof s.turn !== "string" || s.turn.length === 0) return {};
  const pending = Array.isArray(s.pending)
    ? s.pending.flatMap((t): PendingDelegation[] => {
        if (typeof t !== "object" || t === null) return [];
        const raw = t as { taskId?: unknown; parentWakeId?: unknown };
        if (typeof raw.taskId !== "string" || raw.taskId.length === 0) return [];
        return [
          {
            taskId: raw.taskId,
            ...(typeof raw.parentWakeId === "string" && raw.parentWakeId.length > 0 ? { parentWakeId: raw.parentWakeId } : {}),
          },
        ];
      })
    : [];
  return { turn: s.turn, pending };
}

export function notePendingDelegation(turnId: string | undefined, taskId: string, parentWakeId: string | undefined): void {
  if (turnId === undefined || turnId.length === 0) return;
  if (taskId.length === 0) return;
  const entry: PendingDelegation = { taskId, ...(parentWakeId !== undefined && parentWakeId.length > 0 ? { parentWakeId } : {}) };
  try {
    slot.update((cur) => {
      const state = readState(cur);
      if (state.turn !== turnId) return { turn: turnId, pending: [entry] };
      const pending = state.pending ?? [];
      if (pending.length >= MAX_PENDING || pending.some((t) => t.taskId === taskId)) return state;
      return { turn: turnId, pending: [...pending, entry] };
    });
  } catch {
  }
}

export function noteDelegationSettled(turnId: string | undefined, taskId: string): void {
  if (turnId === undefined || turnId.length === 0) return;
  if (taskId.length === 0) return;
  try {
    slot.update((cur) => {
      const state = readState(cur);
      if (state.turn !== turnId) return state;
      const pending = state.pending ?? [];
      if (!pending.some((t) => t.taskId === taskId)) return state;
      return { turn: turnId, pending: pending.filter((t) => t.taskId !== taskId) };
    });
  } catch {
  }
}

export function pendingDelegationOwing(turnId: string | undefined, wakeId: string, addressedWake: string | undefined): string | undefined {
  if (turnId === undefined || turnId.length === 0) return undefined;
  if (wakeId.length === 0) return undefined;
  let state: PendingDelegationState;
  try {
    state = readState(slot.get());
  } catch {
    return undefined;
  }
  if (state.turn !== turnId) return undefined;
  const pending = state.pending ?? [];
  if (pending.length === 0) return undefined;
  const named = pending.find((t) => t.parentWakeId === wakeId);
  if (named !== undefined) return named.taskId;
  if (addressedWake === undefined) return pending[0]!.taskId;
  if (addressedWake === wakeId) return pending[0]!.taskId;
  return undefined;
}
