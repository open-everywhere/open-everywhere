import { defineState } from "eve/context";
import { TERMINAL_TASK_STATUSES, type TaskSummary } from "./background-tasks.js";

export const MAX_FLUSH_HOLDS = 4;

export const LIVE_DELEGATED_TASKS_STATE_KEY = "open-everywhere.memory.liveTasks";

const liveTasks = defineState<Record<string, number>>(LIVE_DELEGATED_TASKS_STATE_KEY, () => ({}));

function holdsUsed(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
}

export function armLiveTask(taskId: string): void {
  try {
    if (taskId.length === 0) return;
    liveTasks.update((t) => ({ ...t, [taskId]: 0 }));
  } catch {
  }
}

export function noteTaskViews(views: readonly TaskSummary[]): void {
  try {
    if (views.length === 0) return;
    liveTasks.update((t) => {
      const next = { ...t };
      for (const v of views) {
        if (TERMINAL_TASK_STATUSES.includes(v.status)) delete next[v.taskId];
        else next[v.taskId] = 0;
      }
      return next;
    });
  } catch {
  }
}

export function liveTaskIds(): readonly string[] {
  try {
    return Object.keys(liveTasks.get());
  } catch {
    return [];
  }
}

export function liveTaskCount(): number {
  return liveTaskIds().length;
}

export function consumeFlushHold(ids: readonly string[]): readonly string[] {
  if (ids.length === 0) return [];
  let retired: readonly string[] = [];
  try {
    liveTasks.update((t) => {
      const next = { ...t };
      const spent: string[] = [];
      for (const id of ids) {
        const used = holdsUsed(next[id]) + 1;
        if (used >= MAX_FLUSH_HOLDS) {
          delete next[id];
          spent.push(id);
        } else {
          next[id] = used;
        }
      }
      retired = spent;
      return next;
    });
  } catch {
    retired = [];
  }
  return retired;
}
