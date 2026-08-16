import { appendAudit, type AuditInput } from "../audit/audit.js";
import { isSessionLimitContinuationRequest } from "./session-park.js";
import { WAKE_TARGET_TTL_MS, type UnifiedWakeOrigin } from "./unified-window.js";

export const QUESTION_BRIDGED_AUDIT_ACTION = "turn.question_bridged";
export const QUESTION_DROPPED_AUDIT_ACTION = "turn.question_dropped";

export const EMPTY_QUESTION_FALLBACK = "I asked a question but supplied no text — reply with anything and I'll carry on.";

export interface BridgeableQuestion {
  readonly requestId: string;
  readonly toolName: string;
  readonly kind: string;
  readonly prompt: string;
  readonly options: readonly string[];
}

export function detectBridgeableInputRequest(requests: unknown): BridgeableQuestion | undefined {
  if (!Array.isArray(requests)) return undefined;
  for (const r of requests as readonly unknown[]) {
    if (r === null || typeof r !== "object") continue;
    if (isSessionLimitContinuationRequest(r)) continue;
    const req = r as { requestId?: unknown; kind?: unknown; prompt?: unknown; options?: unknown; action?: { toolName?: unknown } };
    const options: string[] = [];
    if (Array.isArray(req.options)) {
      for (const o of req.options as readonly unknown[]) {
        const label = (o as { label?: unknown } | null)?.label;
        if (typeof label === "string" && label.length > 0) options.push(label);
      }
    }
    return {
      requestId: typeof req.requestId === "string" ? req.requestId : "",
      toolName: typeof req.action?.toolName === "string" ? req.action.toolName : "unknown",
      kind: typeof req.kind === "string" ? req.kind : "unknown",
      prompt: typeof req.prompt === "string" ? req.prompt : "",
      options,
    };
  }
  return undefined;
}

export function renderQuestionForSurface(question: BridgeableQuestion): string {
  const head = question.prompt.trim().length > 0 ? question.prompt.trim() : EMPTY_QUESTION_FALLBACK;
  if (question.options.length === 0) return head;
  return `${head}\n\n${question.options.map((o) => `• ${o}`).join("\n")}`;
}

export type QuestionDropReason = "unresolved-origin" | "post-failed";

export type QuestionBridgeOutcome =
  | { readonly status: "bridged"; readonly platform: string; readonly id: string; readonly origin: UnifiedWakeOrigin }
  | { readonly status: "dropped"; readonly reason: QuestionDropReason };

export interface QuestionBridgeScope {
  readonly org: string;
  readonly platform: string;
  readonly workspace: string;
  readonly surface?: string;
  readonly sessionId?: string;
  readonly wakeId?: string;
}

export interface QuestionBridgeDeps {
  readonly resolveOrigin: () => Promise<UnifiedWakeOrigin | null>;
  readonly post: (origin: UnifiedWakeOrigin, text: string) => Promise<string>;
  readonly audit?: (entry: AuditInput) => Promise<void>;
}

const ERROR_MAX = 300;

export async function bridgeQuestionToSurface(
  scope: QuestionBridgeScope,
  question: BridgeableQuestion,
  deps: QuestionBridgeDeps,
): Promise<QuestionBridgeOutcome> {
  const audit = deps.audit ?? appendAudit;
  const text = renderQuestionForSurface(question);
  const base = {
    requestId: question.requestId,
    toolName: question.toolName,
    kind: question.kind,
    chars: text.length,
    options: question.options.length,
    ...(scope.wakeId ? { wakeId: scope.wakeId } : {}),
    ...(scope.sessionId ? { sessionId: scope.sessionId } : {}),
  };
  const row = (action: string, detail: Record<string, unknown>): Promise<void> =>
    audit({ org: scope.org, platform: scope.platform, workspace: scope.workspace, surface: scope.surface, action, detail }).catch(() => undefined);

  let origin: UnifiedWakeOrigin | null = null;
  try {
    origin = await deps.resolveOrigin();
  } catch {
    origin = null;
  }
  if (!origin) {
    await row(QUESTION_DROPPED_AUDIT_ACTION, { ...base, reason: "unresolved-origin" satisfies QuestionDropReason });
    return { status: "dropped", reason: "unresolved-origin" };
  }
  try {
    const id = await deps.post(origin, text);
    await row(QUESTION_BRIDGED_AUDIT_ACTION, { ...base, platform: origin.platform, id });
    return { status: "bridged", platform: origin.platform, id, origin };
  } catch (err) {
    await row(QUESTION_DROPPED_AUDIT_ACTION, {
      ...base,
      reason: "post-failed" satisfies QuestionDropReason,
      platform: origin.platform,
      error: (err instanceof Error ? err.message : String(err)).slice(0, ERROR_MAX),
    });
    return { status: "dropped", reason: "post-failed" };
  }
}

export const QUESTION_ANSWERED_AUDIT_ACTION = "input_response.routed";
export const QUESTION_ANSWER_DROPPED_AUDIT_ACTION = "input_response.dropped";

const BRIDGED_QUESTION_PREFIX = "oe-question-bridge:";

export const BRIDGED_QUESTION_TTL_MS = WAKE_TARGET_TTL_MS;

export function bridgedQuestionKey(bareToken: string): string {
  return `${BRIDGED_QUESTION_PREFIX}${bareToken}`;
}

export interface OutstandingQuestion {
  readonly requestId: string;
  readonly containerKey?: string;
  readonly wakeId?: string;
  readonly taskId?: string;
  readonly at: string;
}

export interface BridgedQuestionStore {
  putTaskResult(org: string, key: string, resultJson: string, at: string, ttlMs: number, callerToken?: string): Promise<void>;
  getTaskResult(org: string, key: string): Promise<string | null>;
  deleteTaskResult(org: string, key: string): Promise<boolean>;
}

export function taskIdOfBridgedRequestId(requestId: string): string | undefined {
  const cut = requestId.indexOf(":");
  if (cut <= 0) return undefined;
  const head = requestId.slice(0, cut);
  return head.startsWith("task_") ? head : undefined;
}

export async function rememberBridgedQuestion(
  store: BridgedQuestionStore,
  org: string,
  bareToken: string,
  input: { readonly requestId: string; readonly containerKey?: string; readonly wakeId?: string; readonly at?: string },
): Promise<boolean> {
  try {
    if (bareToken.length === 0 || input.requestId.length === 0) return false;
    const at = input.at ?? new Date().toISOString();
    const taskId = taskIdOfBridgedRequestId(input.requestId);
    const row: OutstandingQuestion = {
      requestId: input.requestId,
      ...(input.containerKey !== undefined && input.containerKey.length > 0 ? { containerKey: input.containerKey } : {}),
      ...(input.wakeId !== undefined && input.wakeId.length > 0 ? { wakeId: input.wakeId } : {}),
      ...(taskId !== undefined ? { taskId } : {}),
      at,
    };
    await store.putTaskResult(org, bridgedQuestionKey(bareToken), JSON.stringify(row), at, BRIDGED_QUESTION_TTL_MS, undefined);
    return true;
  } catch {
    return false;
  }
}

export async function readBridgedQuestion(store: BridgedQuestionStore, org: string, bareToken: string): Promise<OutstandingQuestion | undefined> {
  try {
    if (bareToken.length === 0) return undefined;
    const raw = await store.getTaskResult(org, bridgedQuestionKey(bareToken));
    if (raw === null) return undefined;
    const parsed = JSON.parse(raw) as Partial<OutstandingQuestion> | null;
    const requestId = parsed?.requestId;
    if (typeof requestId !== "string" || requestId.length === 0) return undefined;
    return {
      requestId,
      ...(typeof parsed?.containerKey === "string" && parsed.containerKey.length > 0 ? { containerKey: parsed.containerKey } : {}),
      ...(typeof parsed?.wakeId === "string" && parsed.wakeId.length > 0 ? { wakeId: parsed.wakeId } : {}),
      ...(typeof parsed?.taskId === "string" && parsed.taskId.length > 0 ? { taskId: parsed.taskId } : {}),
      at: typeof parsed?.at === "string" ? parsed.at : "",
    };
  } catch {
    return undefined;
  }
}

export async function forgetBridgedQuestion(store: BridgedQuestionStore, org: string, bareToken: string): Promise<boolean> {
  try {
    if (bareToken.length === 0) return false;
    return await store.deleteTaskResult(org, bridgedQuestionKey(bareToken));
  } catch {
    return false;
  }
}

export type InboundAnswerRouting =
  | { readonly kind: "answer"; readonly requestId: string; readonly floor: string; readonly wakeId?: string; readonly taskId?: string }
  | { readonly kind: "wake"; readonly reason: "internal-dispatch" | "no-question" | "foreign-room" | "refused" };

export interface InboundAnswerDeps {
  readonly read: () => Promise<OutstandingQuestion | undefined>;
  readonly admit: () => Promise<{ readonly ok: true; readonly floor: string } | { readonly ok: false }>;
}

export async function resolveInboundAnswerRouting(
  input: {
    readonly internalDispatch: boolean;
    readonly containerKey?: string;
  },
  deps: InboundAnswerDeps,
): Promise<InboundAnswerRouting> {
  if (input.internalDispatch) return { kind: "wake", reason: "internal-dispatch" };
  const outstanding = await deps.read();
  if (outstanding === undefined) return { kind: "wake", reason: "no-question" };
  const asked = outstanding.containerKey;
  const here = input.containerKey;
  if (asked === undefined || asked.length === 0 || here === undefined || here.length === 0 || asked !== here) {
    return { kind: "wake", reason: "foreign-room" };
  }
  const verdict = await deps.admit();
  if (!verdict.ok) return { kind: "wake", reason: "refused" };
  return {
    kind: "answer",
    requestId: outstanding.requestId,
    floor: verdict.floor,
    ...(outstanding.wakeId !== undefined ? { wakeId: outstanding.wakeId } : {}),
    ...(outstanding.taskId !== undefined ? { taskId: outstanding.taskId } : {}),
  };
}
