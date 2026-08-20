import { defineState } from "eve/context";
import { persistMemoryNow, type MemoryFlushSummary, type MemoryPersistContext } from "./memory.js";
import { appendAudit } from "../audit/audit.js";
import { deploymentOrg } from "../identity/binding.js";
import { armLiveTask, consumeFlushHold, liveTaskIds, MAX_FLUSH_HOLDS } from "../access/live-delegated-tasks.js";
export { liveTaskCount, liveTaskIds, noteTaskViews, MAX_FLUSH_HOLDS } from "../access/live-delegated-tasks.js";

export const SETTLEMENT_FLUSH_ACTION = "memory.settlement_flush";

export type SettlementEdge = "task-settled" | "delegation-returned" | "turn-backstop";

const treeDirty = defineState<{ dirty: boolean }>("open-everywhere.memory.treeDirty", () => ({ dirty: false }));

function log(msg: string): void {
  console.log(`[open-everywhere:settlement-flush] ${msg}`);
}

export function noteTaskDispatched(taskId: string): void {
  armLiveTask(taskId);
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

export interface SettlementFlushResult {
  readonly outcome: "flushed" | "skipped";
  readonly live: number;
  readonly liveIds: readonly string[];
  readonly retiredIds: readonly string[];
  readonly flush: MemoryFlushSummary | null;
}

export async function flushSettledMemory(ctx: MemoryPersistContext, edge: SettlementEdge): Promise<SettlementFlushResult> {
  let result: SettlementFlushResult = { outcome: "skipped", live: 0, liveIds: [], retiredIds: [], flush: null };
  try {
    const liveIds = liveTaskIds();
    const live = liveIds.length;
    if (live > 0) {
      const retiredIds = consumeFlushHold(liveIds);
      log(`${edge}: SKIPPED — ${live} delegated task(s) still hold this session's memory tree [${liveIds.join(", ")}]`);
      if (retiredIds.length > 0) {
        log(
          `${edge}: RETIRED ${retiredIds.length} task id(s) after ${MAX_FLUSH_HOLDS} held flush attempt(s) — they no longer hold this tree [${retiredIds.join(", ")}]`,
        );
      }
      result = { outcome: "skipped", live, liveIds, retiredIds, flush: null };
    } else {
      const flush = await persistMemoryNow(ctx, "settled");
      try {
        treeDirty.update(() => ({ dirty: false }));
      } catch {
      }
      result = { outcome: "flushed", live: 0, liveIds: [], retiredIds: [], flush };
    }
  } catch (err) {
    log(`${edge}: flush failed (the next settlement or return flush still persists this tree): ${String(err)}`);
    result = { outcome: "skipped", live: -1, liveIds: [], retiredIds: [], flush: null };
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
      ...(result.liveIds.length === 0 ? {} : { liveTaskIds: result.liveIds }),
      ...(result.retiredIds.length === 0 ? {} : { retiredTaskIds: result.retiredIds }),
      ...(result.flush === null ? {} : { flush: result.flush }),
    },
  }).catch(() => undefined);
  return result;
}

export async function flushDirtyTreeAtTurnEnd(ctx: MemoryPersistContext): Promise<SettlementFlushResult | null> {
  if (!treeIsDirty()) return null;
  return flushSettledMemory(ctx, "turn-backstop");
}
