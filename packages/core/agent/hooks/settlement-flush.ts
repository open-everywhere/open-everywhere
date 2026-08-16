import { defineState } from "eve/context";
import { persistMemoryNow, type MemoryFlushSummary, type MemoryPersistContext } from "./memory.js";
import { appendAudit } from "../audit/audit.js";
import { deploymentOrg } from "../identity/binding.js";
import { TERMINAL_TASK_STATUSES, type TaskSummary } from "../access/background-tasks.js";

export const SETTLEMENT_FLUSH_ACTION = "memory.settlement_flush";

export type SettlementEdge = "task-settled" | "delegation-returned" | "turn-backstop";

const liveTasks = defineState<Record<string, true>>("open-everywhere.memory.liveTasks", () => ({}));

const treeDirty = defineState<{ dirty: boolean }>("open-everywhere.memory.treeDirty", () => ({ dirty: false }));

function log(msg: string): void {
  console.log(`[open-everywhere:settlement-flush] ${msg}`);
}

export function noteTaskDispatched(taskId: string): void {
  try {
    if (taskId.length === 0) return;
    liveTasks.update((t) => ({ ...t, [taskId]: true }));
  } catch {
  }
  markTreeDirty();
}

function markTreeDirty(): void {
  try {
    treeDirty.update(() => ({ dirty: true }));
  } catch {
  }
}

export function treeIsDirty(): boolean {
  try {
    return treeDirty.get().dirty;
  } catch {
    return false;
  }
}

export function noteTaskViews(views: readonly TaskSummary[]): void {
  try {
    if (views.length === 0) return;
    liveTasks.update((t) => {
      const next = { ...t };
      for (const v of views) {
        if (TERMINAL_TASK_STATUSES.includes(v.status)) delete next[v.taskId];
        else next[v.taskId] = true;
      }
      return next;
    });
  } catch {
  }
}

export function liveTaskCount(): number {
  try {
    return Object.keys(liveTasks.get()).length;
  } catch {
    return 0;
  }
}

export interface SettlementFlushResult {
  readonly outcome: "flushed" | "skipped";
  readonly live: number;
  readonly flush: MemoryFlushSummary | null;
}

export async function flushSettledMemory(ctx: MemoryPersistContext, edge: SettlementEdge): Promise<SettlementFlushResult> {
  let result: SettlementFlushResult = { outcome: "skipped", live: 0, flush: null };
  try {
    const live = liveTaskCount();
    if (live > 0) {
      log(`${edge}: SKIPPED — ${live} delegated task(s) still hold this session's memory tree`);
      result = { outcome: "skipped", live, flush: null };
    } else {
      const flush = await persistMemoryNow(ctx, "settled");
      try {
        treeDirty.update(() => ({ dirty: false }));
      } catch {
      }
      result = { outcome: "flushed", live: 0, flush };
    }
  } catch (err) {
    log(`${edge}: flush failed (the next settlement or return flush still persists this tree): ${String(err)}`);
    result = { outcome: "skipped", live: -1, flush: null };
  }
  void appendAudit({
    org: deploymentOrg(),
    platform: "ingest",
    workspace: "delegation",
    action: SETTLEMENT_FLUSH_ACTION,
    detail: {
      edge,
      outcome: result.outcome,
      liveTasks: result.live,
      ...(result.flush === null ? {} : { flush: result.flush }),
    },
  }).catch(() => undefined);
  return result;
}

export async function flushDirtyTreeAtTurnEnd(ctx: MemoryPersistContext): Promise<SettlementFlushResult | null> {
  if (!treeIsDirty()) return null;
  return flushSettledMemory(ctx, "turn-backstop");
}
