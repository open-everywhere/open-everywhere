import { claimWorkCall, releaseWorkCall, retireWorkRequest, workCallClaimed, WORK_REQUEST_UNJOINABLE_MESSAGE } from "./work-request-turn.js";
import { gateWorkCallStamp, liveWorkRequestStamp, workStampVerdict, WORK_CALL_NEEDS_REISSUE_MESSAGE } from "./work-step-stamp.js";
import { asSchema, jsonSchema } from "ai";
import { defineState } from "eve/context";
import { parseWakeAttachments, withDelegatedAttachments, type BriefAttachment } from "../channels/attachments.js";
import { isWakeEnvelopeShaped } from "../channels/wake-envelope.js";
import { auditTaskContinuation, checkTaskContinuation, commitTaskContinuation, TASK_CONTINUATION_REFUSAL_MESSAGE, taskContinuationRefusalMessage, type TaskContinuationVerdict } from "../channels/task-provenance.js";
import { deploymentOrg } from "../identity/binding.js";
import { currentContinuationTurn, type ContinuationTurn } from "./continuation-turn-state.js";
import { settlementDispatchAuthorityThisTurn } from "./settlement-dispatch-signal.js";
import { taskWakeThisTurn, uningressedTurn } from "./task-wake-signal.js";
import { addressedWakeThisTurn, exactDispatchWakeThisTurn } from "./dispatch-origin-signal.js";

const DELEGATION_TOOL_NAME = "agent";

const TASK_ID_FIELD = "taskId";

const STOP_ONLY_TASK_TOOLS: ReadonlySet<string> = new Set(["task_cancel", "cancel_work"]);

const SELF_FENCED_TASK_TOOLS: ReadonlySet<string> = new Set(["work"]);

const CALLER_OUTPUT_SCHEMA_FIELD = "outputSchema";

export { TASK_CONTINUATION_REFUSAL_MESSAGE };

interface MessageLike {
  role?: unknown;
  content?: unknown;
}

const wakeAttachmentSlot = defineState<readonly BriefAttachment[]>("open-everywhere.wake-attachments", () => []);

const DELEGATION_BRIEF_FIELD = "message";

function lastUserText(messages: readonly unknown[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m === null || typeof m !== "object") continue;
    const like = m as MessageLike;
    if (like.role !== "user") continue;
    if (typeof like.content === "string") return like.content;
    if (!Array.isArray(like.content)) return undefined;
    const text = like.content
      .map((part) => (part !== null && typeof part === "object" && typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : ""))
      .join("\n");
    return text.length > 0 ? text : undefined;
  }
  return undefined;
}

export function noteWakeAttachments(messages: unknown): number {
  let found: readonly BriefAttachment[] = [];
  try {
    const text = Array.isArray(messages) ? lastUserText(messages) : undefined;
    if (text !== undefined && isWakeEnvelopeShaped(text)) found = parseWakeAttachments(text);
  } catch {
    found = [];
  }
  try {
    wakeAttachmentSlot.update(() => found);
  } catch {
  }
  return found.length;
}

function currentWakeAttachments(): readonly BriefAttachment[] {
  try {
    return wakeAttachmentSlot.get();
  } catch {
    return [];
  }
}

function carryAttachmentsIntoBrief(candidate: unknown): unknown {
  try {
    const attachments = currentWakeAttachments();
    if (attachments.length === 0) return candidate;
    if (candidate === null || typeof candidate !== "object") return candidate;
    const message = (candidate as Record<string, unknown>)[DELEGATION_BRIEF_FIELD];
    if (typeof message !== "string" || message.length === 0) return candidate;
    return { ...(candidate as Record<string, unknown>), [DELEGATION_BRIEF_FIELD]: withDelegatedAttachments(message, attachments) };
  } catch {
    return candidate;
  }
}

function continuingWakeForTurn(turnId: string): string | undefined {
  const settlement = settlementDispatchAuthorityThisTurn(turnId);
  const settlementTurn = uningressedTurn(turnId) && (settlement.kind !== "none" || taskWakeThisTurn(turnId) !== undefined);
  if (settlementTurn) return settlement.kind === "single" ? settlement.authority.wakeId : undefined;
  return addressedWakeThisTurn(turnId) ?? exactDispatchWakeThisTurn(turnId);
}

export async function decideTaskContinuation(
  turn: ContinuationTurn | null,
  taskId: string,
  toolName: string = DELEGATION_TOOL_NAME,
  org: string = deploymentOrg(),
  validated: () => Promise<boolean> = async () => true,
): Promise<TaskContinuationVerdict | { readonly admit: false; readonly reason: "eve-refused" }> {
  if (turn === null) return { admit: false, reason: "no-turn" };
  if (!turn.unified) return { admit: false, reason: "not-unified" };
  const checked = await checkTaskContinuation({ org, parentSessionId: turn.sessionId, taskId, toolName, continuingWakeId: continuingWakeForTurn(turn.turnId), continuingTurnId: turn.turnId });
  if (!checked.admit) return checked;
  if (!(await validated())) return { admit: false, reason: "eve-refused" };
  return await commitTaskContinuation({ org, parentSessionId: turn.sessionId, taskId, continuingTurnId: turn.turnId, check: checked.check });
}

function continuationTaskId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : value;
}

interface ToolWithInputSchema {
  inputSchema?: unknown;
}

type JsonSchemaObject = {
  properties?: Record<string, unknown>;
  required?: readonly string[];
  [k: string]: unknown;
};

const replacements = new WeakMap<object, unknown>();

const unguardable = new WeakSet<object>();

function guardTool(tool: ToolWithInputSchema, name: string, delegation: boolean): boolean {
  const current = tool.inputSchema;
  if (current === null || typeof current !== "object") return false;

  const cached = replacements.get(current as object);
  if (cached !== undefined) {
    tool.inputSchema = cached;
    return true;
  }
  if (unguardable.has(current as object)) return false;

  const original = asSchema(current as never);
  const source = original.jsonSchema as JsonSchemaObject | undefined;
  const properties = source?.properties;
  if (source === undefined || properties === undefined || !(TASK_ID_FIELD in properties)) {
    unguardable.add(current as object);
    return false;
  }

  const replacement = jsonSchema(source as never, {
    validate: async (value: unknown) => {
      const turnId = currentContinuationTurn()?.turnId;
      const message = value !== null && typeof value === "object" ? (value as Record<string, unknown>)["message"] : undefined;
      const heldBefore = delegation && workCallClaimed(turnId, message);
      const outcome = await validateGuarded(value);
      if (delegation && !heldBefore && outcome.success === false) releaseWorkCall(turnId, message);
      return outcome;
    },
  });

  async function validateGuarded(value: unknown) {
      let candidate = value;
      if (delegation && candidate !== null && typeof candidate === "object" && CALLER_OUTPUT_SCHEMA_FIELD in candidate) {
        const { [CALLER_OUTPUT_SCHEMA_FIELD]: _shape, ...rest } = candidate as Record<string, unknown>;
        candidate = rest;
      }
      const taskId = candidate !== null && typeof candidate === "object" ? continuationTaskId((candidate as Record<string, unknown>)[TASK_ID_FIELD]) : undefined;
      if (delegation) {
        const turnNow = currentContinuationTurn();
        const callMessage = candidate !== null && typeof candidate === "object" ? (candidate as Record<string, unknown>)["message"] : undefined;
        const stamp = liveWorkRequestStamp();
        const repeat = workCallClaimed(turnNow?.turnId, callMessage);
        const join = claimWorkCall(turnNow?.turnId, callMessage, stamp);
        if (join.kind === "refused") return { success: false as const, error: new Error(WORK_REQUEST_UNJOINABLE_MESSAGE) };
        if (join.kind === "joined") {
          if (repeat && workStampVerdict(join.requestId, stamp).kind === "needs-reissue") {
            return { success: false as const, error: new Error(WORK_REQUEST_UNJOINABLE_MESSAGE) };
          }
          const verdict = await gateWorkCallStamp(join.requestId, stamp);
          if (verdict.kind === "needs-reissue") {
            retireWorkRequest(turnNow?.turnId, join.requestId);
            return { success: false as const, error: new Error(WORK_CALL_NEEDS_REISSUE_MESSAGE) };
          }
        }
      }
      if (delegation) candidate = carryAttachmentsIntoBrief(candidate);
      const evesOwn = async (input: unknown) =>
        typeof original.validate !== "function" ? { success: true as const, value: input } : await original.validate(input);
      if (taskId === undefined) return await evesOwn(candidate);
      const turn = currentContinuationTurn();
      let eveResult: Awaited<ReturnType<typeof evesOwn>> | undefined;
      const verdict = await decideTaskContinuation(turn, taskId, name, deploymentOrg(), async () => {
        eveResult = await evesOwn(candidate);
        return eveResult.success === true;
      });
      if (!verdict.admit && verdict.reason === "eve-refused" && eveResult !== undefined) return eveResult;
      auditTaskContinuation({ org: deploymentOrg(), parentSessionId: turn?.sessionId ?? "", turnId: turn?.turnId, taskId, verdict: verdict as TaskContinuationVerdict });
      if (!verdict.admit) return { success: false as const, error: new Error(taskContinuationRefusalMessage(verdict.reason as Exclude<typeof verdict.reason, "eve-refused">)) };
      return eveResult ?? (await evesOwn(candidate));
  }

  replacements.set(current as object, replacement);
  tool.inputSchema = replacement;
  return true;
}

export function guardTaskContinuations(toolset: Record<string, unknown>): string[] {
  const guarded: string[] = [];
  for (const [name, raw] of Object.entries(toolset)) {
    if (raw === null || typeof raw !== "object") continue;
    if (STOP_ONLY_TASK_TOOLS.has(name) || SELF_FENCED_TASK_TOOLS.has(name)) continue;
    if (guardTool(raw as ToolWithInputSchema, name, name === DELEGATION_TOOL_NAME)) guarded.push(name);
  }
  return guarded.sort();
}
