import { asSchema, jsonSchema } from "ai";
import { getOperationalStore } from "../operational/provider.js";
import { deploymentOrg } from "../identity/binding.js";
import { takeWorkCancel, WORK_CANCEL_REDEEM_ACTION } from "../channels/work.js";
import { appendAudit } from "../audit/audit.js";
import { currentWorkSessionToken } from "./lean-seat-state.js";
import { currentContinuationTurn } from "./continuation-turn-state.js";

export const WORK_CANCEL_UNAUTHORISED_MESSAGE =
  "task_cancel: this work session stops a job only when its seat relays a cancel for it with `cancel_work`. Nothing was cancelled.";

const fenced = new WeakMap<object, unknown>();

export function fenceWorkSessionCancel(toolset: Record<string, unknown>): boolean {
  const tool = toolset.task_cancel as { inputSchema?: unknown } | undefined;
  const current = tool?.inputSchema;
  if (tool === undefined || current === null || typeof current !== "object") return false;
  const cached = fenced.get(current);
  if (cached !== undefined) {
    tool.inputSchema = cached;
    return true;
  }
  const original = asSchema(current as never);
  const replacement = jsonSchema(original.jsonSchema as never, {
    validate: async (value: unknown) => {
      const taskId = value !== null && typeof value === "object" ? (value as { taskId?: unknown }).taskId : undefined;
      const workToken = currentWorkSessionToken();
      const turnId = currentContinuationTurn()?.turnId;
      const admitted =
        typeof taskId === "string" &&
        taskId.length > 0 &&
        workToken !== undefined &&
        turnId !== undefined &&
        (await takeWorkCancel(getOperationalStore(), deploymentOrg(), workToken, taskId, turnId).catch(() => false));
      void appendAudit({
        org: deploymentOrg(),
        platform: "unified",
        workspace: "delegation",
        action: WORK_CANCEL_REDEEM_ACTION,
        detail: { taskId: typeof taskId === "string" ? taskId : "", outcome: admitted ? "admitted" : "refused", ...(turnId !== undefined ? { turn: turnId } : {}) },
      }).catch(() => undefined);
      if (!admitted) return { success: false as const, error: new Error(WORK_CANCEL_UNAUTHORISED_MESSAGE) };
      return typeof original.validate !== "function" ? { success: true as const, value } : await original.validate(value);
    },
  });
  fenced.set(current, replacement);
  fenced.set(replacement as object, replacement);
  tool.inputSchema = replacement;
  return true;
}
