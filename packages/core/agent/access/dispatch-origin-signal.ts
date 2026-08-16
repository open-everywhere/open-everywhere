import { defineState } from "eve/context";

export interface DispatchedTaskWake {
  readonly taskId: string;
  readonly wakeId: string;
}

interface DispatchOriginState {
  readonly turn?: string;
  readonly addressed?: string;
  readonly tasks?: readonly DispatchedTaskWake[];
}

const slot = defineState<DispatchOriginState>("open-everywhere.dispatch-origin", () => ({}));

const MAX_TASKS = 16;

function readState(v: unknown): DispatchOriginState {
  if (v === null || typeof v !== "object") return {};
  const s = v as { turn?: unknown; addressed?: unknown; tasks?: unknown };
  if (typeof s.turn !== "string" || s.turn.length === 0) return {};
  const tasks = Array.isArray(s.tasks)
    ? s.tasks.filter(
        (t): t is DispatchedTaskWake =>
          typeof t === "object" &&
          t !== null &&
          typeof (t as DispatchedTaskWake).taskId === "string" &&
          (t as DispatchedTaskWake).taskId.length > 0 &&
          typeof (t as DispatchedTaskWake).wakeId === "string" &&
          (t as DispatchedTaskWake).wakeId.length > 0,
      )
    : [];
  return {
    turn: s.turn,
    ...(typeof s.addressed === "string" && s.addressed.length > 0 ? { addressed: s.addressed } : {}),
    tasks,
  };
}

export function addressedWakeThisTurn(turnId: string | undefined): string | undefined {
  if (turnId === undefined || turnId.length === 0) return undefined;
  try {
    const state = readState(slot.get());
    return state.turn === turnId ? state.addressed : undefined;
  } catch {
    return undefined;
  }
}

export function noteTaskDispatchedThisTurn(turnId: string | undefined, taskId: string, wakeId: string): void {
  if (turnId === undefined || turnId.length === 0) return;
  if (taskId.length === 0 || wakeId.length === 0) return;
  try {
    slot.update((cur) => {
      const state = readState(cur);
      if (state.turn !== turnId) return { turn: turnId, tasks: [{ taskId, wakeId }] };
      if (state.addressed !== undefined) return state;
      const tasks = state.tasks ?? [];
      if (tasks.length >= MAX_TASKS || tasks.some((t) => t.taskId === taskId)) return state;
      return { ...state, tasks: [...tasks, { taskId, wakeId }] };
    });
  } catch {
  }
}

export function claimTasksForAddressedWake(turnId: string | undefined, wakeId: string): readonly DispatchedTaskWake[] {
  if (turnId === undefined || turnId.length === 0) return [];
  if (wakeId.length === 0) return [];
  let claimed: readonly DispatchedTaskWake[] = [];
  try {
    slot.update((cur) => {
      const state = readState(cur);
      if (state.turn !== turnId) return { turn: turnId, addressed: wakeId, tasks: [] };
      if (state.addressed !== undefined) return state;
      claimed = state.tasks ?? [];
      return { turn: turnId, addressed: wakeId, tasks: [] };
    });
  } catch {
    return [];
  }
  return claimed;
}
