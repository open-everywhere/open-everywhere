import { getOperationalStore } from "../operational/provider.js";
import { deploymentOrg } from "../identity/binding.js";
import { takeWorkCancel, WORK_CANCEL_REDEEM_ACTION } from "../channels/work.js";
import { appendAudit } from "../audit/audit.js";
import { currentWorkSessionToken, currentWorkTier } from "./lean-seat-state.js";
import { currentContinuationTurn } from "./continuation-turn-state.js";
import { noteWorkCancelHandled } from "./work-request-turn.js";
import type { RoutableModel } from "../model/routing.js";

/**
 * The work-session `eve__task_cancel` fence. A work session stops a job only when its seat relayed a
 * cancel for that job with `cancel_work`: the seat writes a cancel ticket, and the work session's call
 * redeems it. Every call writes a `work.cancel_redeemed` row (admitted or refused). The write is best
 * effort: the audit append retries once and then drops the row.
 *
 * eve 1.x gives OE no tool seam for this call. `eve__task_cancel` is a `frameworkAction` tool, so the
 * agent approval policy skips it (`approval/agent.js#withAgentApprovalOnEntries`). eve reserves every
 * `eve__*` name, so OE cannot author, cut or disable the tool (`protocol/runtime-tools.js`). eve holds
 * the tool definition, so no OE input validator runs. The fence therefore sits on the model OE resolves
 * for a work session. It reads each `eve__task_cancel` call in the model's output before eve parses it.
 * An admitted call goes on unchanged. A refused call gets one extra input field whose name states the
 * refusal and whose value holds the refusal text. A result or stream that the fence cannot read fails
 * the model call. eve's own schema for the tool forbids extra fields, so the call is invalid: eve answers it
 * with a tool error that holds the refusal, and the stop never runs (`harness/step/after-model.js`).
 */
const WORK_CANCEL_TOOL_NAME = "eve__task_cancel";

export const WORK_CANCEL_UNAUTHORISED_MESSAGE =
  "eve__task_cancel: this work session stops a job only when its seat relays a cancel for it with `cancel_work`. Nothing was cancelled.";

/**
 * The input field that a refused call carries. eve's `eve__task_cancel` schema has no such field, so
 * eve's tool error names it ("Unrecognized key"). The name itself states the refusal, so the error line
 * reads as a refusal and not as a malformed input.
 */
export const WORK_CANCEL_REFUSED_FIELD = "refused_no_cancel_work_ticket_from_seat";

interface WorkCancelScope {
  readonly workToken: string | undefined;
  readonly turnId: string | undefined;
}

function currentWorkCancelScope(): WorkCancelScope {
  return { workToken: currentWorkSessionToken(), turnId: currentContinuationTurn()?.turnId };
}

/**
 * Redeems the seat's cancel ticket for `taskId` and writes the `work.cancel_redeemed` row. A second
 * redeem in the same turn is admitted again (a re-issued model call), and a later turn finds the
 * ticket spent.
 */
async function redeemWorkSessionCancel(taskId: unknown, scope: WorkCancelScope = currentWorkCancelScope()): Promise<boolean> {
  const { workToken, turnId } = scope;
  const admitted =
    typeof taskId === "string" &&
    taskId.length > 0 &&
    workToken !== undefined &&
    turnId !== undefined &&
    (await takeWorkCancel(getOperationalStore(), deploymentOrg(), workToken, taskId, turnId).catch(() => false));
  if (typeof taskId === "string") noteWorkCancelHandled(turnId, taskId);
  void appendAudit({
    org: deploymentOrg(),
    platform: "unified",
    workspace: "delegation",
    action: WORK_CANCEL_REDEEM_ACTION,
    detail: { taskId: typeof taskId === "string" ? taskId : "", outcome: admitted ? "admitted" : "refused", ...(turnId !== undefined ? { turn: turnId } : {}) },
  }).catch(() => undefined);
  return admitted;
}

function parseInput(raw: unknown): Record<string, unknown> | undefined {
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw !== "string") return undefined;
  try {
    const parsed = JSON.parse(raw === "" ? "{}" : raw) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Fences the input of one `eve__task_cancel` call. It returns `raw` unchanged when the call redeems a
 * ticket, and otherwise the input plus the refusal field, in the same form (a JSON string or an object).
 */
async function fenceWorkCancelInput(raw: unknown, scope: WorkCancelScope): Promise<unknown> {
  const input = parseInput(raw);
  if (await redeemWorkSessionCancel(input?.taskId, scope)) return raw;
  const refused = { ...(input ?? {}), [WORK_CANCEL_REFUSED_FIELD]: WORK_CANCEL_UNAUTHORISED_MESSAGE };
  return typeof raw === "string" ? JSON.stringify(refused) : refused;
}

interface ToolCallPart {
  readonly type: "tool-call";
  readonly toolName: string;
  readonly input?: unknown;
}

function isCancelCall(part: unknown): part is ToolCallPart {
  return part !== null && typeof part === "object" && (part as { type?: unknown }).type === "tool-call" && (part as { toolName?: unknown }).toolName === WORK_CANCEL_TOOL_NAME;
}

async function fencePart<T>(part: T, scope: () => WorkCancelScope): Promise<T> {
  if (!isCancelCall(part)) return part;
  return { ...part, input: await fenceWorkCancelInput(part.input, scope()) };
}

/**
 * Wraps the model of a work-session wake with the cancel fence, and returns any other model unchanged.
 * The fence reads the scope (work-session token and turn) at each call, and falls back to the scope it
 * read when the model resolved.
 */
export function withWorkSessionCancelFence<TModel extends RoutableModel>(model: TModel): TModel {
  if (currentWorkTier() !== "work") return model;
  const resolved = currentWorkCancelScope();
  const scopeNow = (): WorkCancelScope => {
    const now = currentWorkCancelScope();
    return { workToken: now.workToken ?? resolved.workToken, turnId: now.turnId ?? resolved.turnId };
  };
  const shim: RoutableModel = {
    specificationVersion: model.specificationVersion,
    provider: model.provider,
    modelId: model.modelId,
    supportedUrls: model.supportedUrls,
    async doGenerate(options: unknown) {
      const scope = scopeNow();
      const result = (await model.doGenerate(options)) as { content?: unknown };
      if (!Array.isArray(result?.content)) {
        throw new Error("open-everywhere: the work-session cancel fence cannot read this model's result, so the model call is refused (fail closed).");
      }
      return { ...result, content: await Promise.all(result.content.map((part: unknown) => fencePart(part, () => scope))) };
    },
    async doStream(options: unknown) {
      const scope = scopeNow();
      const result = (await model.doStream(options)) as { stream?: unknown };
      const stream = result?.stream as { pipeThrough?: unknown } | undefined;
      if (stream === null || typeof stream !== "object" || typeof stream.pipeThrough !== "function") {
        throw new Error("open-everywhere: the work-session cancel fence cannot read this model's stream, so the model call is refused (fail closed).");
      }
      const fenced = (stream as ReadableStream<unknown>).pipeThrough(
        new TransformStream<unknown, unknown>({
          async transform(part, controller) {
            controller.enqueue(await fencePart(part, () => scope));
          },
        }),
      );
      return { ...result, stream: fenced };
    },
  };
  return shim as TModel;
}
