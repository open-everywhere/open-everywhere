import { defineState } from "eve/context";

interface TaskWakeState {
  readonly turn?: string;
  readonly wakeId?: string;
  readonly taskId?: string;
  readonly seenTurn?: string;
  readonly seenDelivery?: string;
  readonly lastDelivery?: string;
  readonly uningressed?: boolean;
}

const slot = defineState<TaskWakeState>("open-everywhere.task-wake", () => ({}));

function readState(v: unknown): TaskWakeState {
  if (v === null || typeof v !== "object") return {};
  const s = v as { turn?: unknown; wakeId?: unknown; taskId?: unknown; seenTurn?: unknown; seenDelivery?: unknown; lastDelivery?: unknown; uningressed?: unknown };
  const identity =
    typeof s.turn === "string" && s.turn.length > 0 && typeof s.wakeId === "string" && s.wakeId.length > 0
      ? { turn: s.turn, wakeId: s.wakeId, ...(typeof s.taskId === "string" && s.taskId.length > 0 ? { taskId: s.taskId } : {}) }
      : {};
  const boundary =
    typeof s.seenTurn === "string" && s.seenTurn.length > 0
      ? {
          seenTurn: s.seenTurn,
          ...(typeof s.seenDelivery === "string" && s.seenDelivery.length > 0 ? { seenDelivery: s.seenDelivery } : {}),
          ...(typeof s.lastDelivery === "string" && s.lastDelivery.length > 0 ? { lastDelivery: s.lastDelivery } : {}),
          uningressed: s.uningressed === true,
        }
      : {};
  return { ...identity, ...boundary };
}

export function noteTurnBoundary(turnId: string | undefined, deliveryStamp: string | undefined): void {
  if (turnId === undefined || turnId.length === 0) return;
  try {
    slot.update((cur) => {
      const state = readState(cur);
      if (state.seenTurn === turnId) return state;
      const previous = state.lastDelivery ?? state.seenDelivery;
      const uningressed = state.seenTurn !== undefined && deliveryStamp !== undefined && deliveryStamp.length > 0 && previous === deliveryStamp;
      return { seenTurn: turnId, ...(deliveryStamp !== undefined && deliveryStamp.length > 0 ? { seenDelivery: deliveryStamp } : {}), uningressed };
    });
  } catch {
  }
}

export function noteStepDelivery(turnId: string | undefined, deliveryStamp: string | undefined): void {
  if (turnId === undefined || turnId.length === 0) return;
  if (deliveryStamp === undefined || deliveryStamp.length === 0) return;
  try {
    const state = readState(slot.get());
    if (state.seenTurn !== turnId) return;
    if ((state.lastDelivery ?? state.seenDelivery) === deliveryStamp) return;
    slot.update((cur) => {
      const now = readState(cur);
      return now.seenTurn === turnId ? { ...now, lastDelivery: deliveryStamp } : now;
    });
  } catch {
  }
}

export function deliveryChangedThisTurn(turnId: string | undefined): boolean {
  if (turnId === undefined || turnId.length === 0) return false;
  try {
    const state = readState(slot.get());
    return state.seenTurn === turnId && state.lastDelivery !== undefined && state.lastDelivery !== state.seenDelivery;
  } catch {
    return false;
  }
}

export function uningressedTurn(turnId: string | undefined): boolean {
  if (turnId === undefined || turnId.length === 0) return false;
  try {
    const state = readState(slot.get());
    return state.seenTurn === turnId && state.uningressed === true;
  } catch {
    return false;
  }
}

export function adoptTaskWakeThisTurn(turnId: string | undefined, taskId: string, wakeId: string): boolean {
  if (turnId === undefined || turnId.length === 0) return false;
  if (taskId.length === 0 || wakeId.length === 0) return false;
  let installed = false;
  try {
    slot.update((cur) => {
      const state = readState(cur);
      if (state.turn === turnId) return state;
      installed = true;
      return { ...state, turn: turnId, wakeId, taskId };
    });
  } catch {
    return false;
  }
  return installed;
}

export function taskWakeThisTurn(turnId: string | undefined): string | undefined {
  if (turnId === undefined || turnId.length === 0) return undefined;
  try {
    const state = readState(slot.get());
    return state.turn === turnId ? state.wakeId : undefined;
  } catch {
    return undefined;
  }
}
