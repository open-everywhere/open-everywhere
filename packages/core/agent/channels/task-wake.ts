import { appendAudit } from "../audit/audit.js";
import { getOperationalStore } from "../operational/provider.js";
import { adoptTaskWakeThisTurn, uningressedTurn } from "../access/task-wake-signal.js";
import type { DispatchedTaskWake } from "../access/dispatch-origin-signal.js";
import { mintWakeId, registerUnifiedWakeTarget, resolveUnifiedWakeTarget, sameUnifiedConversation, WAKE_TARGET_TTL_MS } from "./unified-window.js";

export const TASK_WAKE_ACTION = "unified.task_wake";

export const TASK_WAKE_RETARGET_ACTION = "unified.task_wake_retarget";

const TASK_WAKE_PREFIX = "oe-task-wake:";

const TASK_WAKE_TTL_MS = WAKE_TARGET_TTL_MS;

export function taskWakeKey(taskId: string): string {
  return `${TASK_WAKE_PREFIX}${taskId}`;
}

export async function openTaskWake(input: {
  readonly org: string;
  readonly taskId: string;
  readonly parentWakeId: string | undefined;
  readonly windowToken: string | undefined;
}): Promise<string | null> {
  try {
    if (input.taskId.length === 0) return null;
    if (input.parentWakeId === undefined || input.parentWakeId.length === 0) return null;
    const store = getOperationalStore();
    const origin = await resolveUnifiedWakeTarget(store, input.org, input.parentWakeId);
    if (origin === null) return null;
    const wakeId = mintWakeId();
    const at = new Date().toISOString();
    await registerUnifiedWakeTarget(store, input.org, wakeId, origin, at, input.windowToken);
    await store.putTaskResult(input.org, taskWakeKey(input.taskId), JSON.stringify({ wakeId }), at, TASK_WAKE_TTL_MS, undefined);
    return wakeId;
  } catch {
    return null;
  }
}

export async function retargetTaskWakes(input: {
  readonly org: string;
  readonly tasks: readonly DispatchedTaskWake[];
  readonly addressedWakeId: string;
  readonly windowToken: string | undefined;
  readonly turnId: string | undefined;
}): Promise<number> {
  try {
    if (input.tasks.length === 0) return 0;
    if (input.addressedWakeId.length === 0) return 0;
    const store = getOperationalStore();
    const origin = await resolveUnifiedWakeTarget(store, input.org, input.addressedWakeId);
    if (origin === null) return 0;
    let moved = 0;
    for (const task of input.tasks) {
      const current = await resolveUnifiedWakeTarget(store, input.org, task.wakeId);
      if (current !== null && sameUnifiedConversation(current, origin)) continue;
      const at = new Date().toISOString();
      await registerUnifiedWakeTarget(store, input.org, task.wakeId, origin, at, input.windowToken);
      moved++;
      void appendAudit({
        org: input.org,
        platform: "unified",
        workspace: "delegation",
        action: TASK_WAKE_RETARGET_ACTION,
        detail: {
          task: task.taskId,
          wakeId: task.wakeId,
          addressedWakeId: input.addressedWakeId,
          originPlatform: origin.platform,
          ...(input.turnId !== undefined && input.turnId.length > 0 ? { turnId: input.turnId } : {}),
        },
      }).catch(() => undefined);
    }
    return moved;
  } catch {
    return 0;
  }
}

export async function taskWakeId(org: string, taskId: string): Promise<string | undefined> {
  try {
    if (taskId.length === 0) return undefined;
    const raw = await getOperationalStore().getTaskResult(org, taskWakeKey(taskId));
    if (raw === null) return undefined;
    const parsed = JSON.parse(raw) as { wakeId?: unknown } | null;
    const wakeId = parsed?.wakeId;
    return typeof wakeId === "string" && wakeId.length > 0 ? wakeId : undefined;
  } catch {
    return undefined;
  }
}

export type TaskWakeInstall = {
  readonly outcome: "installed" | "already" | "no-row" | "no-turn" | "ingressed";
  readonly wakeId: string | null;
};

export async function installTaskWake(input: {
  readonly org: string;
  readonly taskId: string;
  readonly status: string;
  readonly sessionId: string;
  readonly turnId: string | undefined;
  readonly inheritedWakeId: string | undefined;
  readonly adopt?: (turnId: string | undefined, taskId: string, wakeId: string) => boolean;
  readonly uningressed?: (turnId: string | undefined) => boolean;
}): Promise<TaskWakeInstall> {
  let result: TaskWakeInstall = { outcome: "no-row", wakeId: null };
  try {
    const wakeId = await taskWakeId(input.org, input.taskId);
    if (wakeId === undefined) {
      result = { outcome: "no-row", wakeId: null };
    } else if (input.turnId === undefined || input.turnId.length === 0) {
      result = { outcome: "no-turn", wakeId };
    } else if (!(input.uningressed ?? uningressedTurn)(input.turnId)) {
      result = { outcome: "ingressed", wakeId };
    } else {
      const adopt = input.adopt ?? adoptTaskWakeThisTurn;
      result = { outcome: adopt(input.turnId, input.taskId, wakeId) ? "installed" : "already", wakeId };
    }
  } catch {
    result = { outcome: "no-row", wakeId: null };
  }
  void appendAudit({
    org: input.org,
    platform: "unified",
    workspace: "delegation",
    action: TASK_WAKE_ACTION,
    detail: {
      task: input.taskId,
      status: input.status,
      outcome: result.outcome,
      wakeId: result.wakeId,
      inheritedWakeId: input.inheritedWakeId ?? null,
      ...(input.sessionId.length > 0 ? { sessionId: input.sessionId } : {}),
      ...(input.turnId !== undefined && input.turnId.length > 0 ? { turnId: input.turnId } : {}),
    },
  }).catch(() => undefined);
  return result;
}
