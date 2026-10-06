import type { HookContext } from "eve/hooks";
import { flushSettledMemory, liveTaskIds, type SettlementFlushResult } from "./settlement-flush.js";
import type { MemoryPersistContext } from "./memory.js";
import { isWorkSessionContext } from "../access/work-session.js";
import type { BindableContext } from "../identity/binding.js";

function log(msg: string): void {
  console.log(`[open-everywhere:work-flush] ${msg}`);
}

export async function flushWorkSettlement(ctx: HookContext, taskId: string): Promise<SettlementFlushResult | null> {
  try {
    if (!isWorkSessionContext(ctx as unknown as BindableContext)) return null;
    const siblings = liveTaskIds();
    if (siblings.length > 0) {
      log(`task ${taskId}: skipped — ${siblings.length} sibling task(s) still live; W's turn-end backstop persists the tree`);
      return null;
    }
    const result = await flushSettledMemory(ctx as unknown as MemoryPersistContext, "task-settled");
    log(`task ${taskId}: ${result.outcome}${result.live > 0 ? ` (${result.live} sibling task(s) still live — the turn-end backstop persists the tree)` : ""}`);
    return result;
  } catch (err) {
    log(`task ${taskId}: flush skipped: ${String(err)}`);
    return null;
  }
}
