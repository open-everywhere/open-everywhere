import { appendAudit, type AuditInput } from "../audit/audit.js";
import { isSessionLimitContinuationRequest } from "./session-park.js";
import { WAKE_TARGET_TTL_MS, unifiedThreadRef, type UnifiedWakeOrigin } from "./unified-window.js";

export const QUESTION_BRIDGED_AUDIT_ACTION = "turn.question_bridged";
export const QUESTION_DROPPED_AUDIT_ACTION = "turn.question_dropped";

export const EMPTY_QUESTION_FALLBACK = "I asked a question but supplied no text — reply with anything and I'll carry on.";

const APPROVAL_REQUEST_KIND = "tool-approval";

export interface BridgeOption {
  readonly id: string;
  readonly label: string;
}

export interface BridgeableQuestion {
  readonly requestId: string;
  readonly toolName: string;
  readonly kind: string;
  readonly prompt: string;
  readonly options: readonly BridgeOption[];
}

export function detectBridgeableInputRequest(requests: unknown): BridgeableQuestion | undefined {
  if (!Array.isArray(requests)) return undefined;
  for (const r of requests as readonly unknown[]) {
    if (r === null || typeof r !== "object") continue;
    if (isSessionLimitContinuationRequest(r)) continue;
    const req = r as { requestId?: unknown; kind?: unknown; prompt?: unknown; options?: unknown; action?: { toolName?: unknown } };
    const options: BridgeOption[] = [];
    if (Array.isArray(req.options)) {
      for (const o of req.options as readonly unknown[]) {
        const opt = o as { id?: unknown; label?: unknown } | null;
        const label = opt?.label;
        if (typeof label === "string" && label.length > 0) options.push({ id: typeof opt?.id === "string" ? opt.id : "", label });
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

export function renderQuestionForSurface(question: BridgeableQuestion, opts?: RenderQuestionOptions): string {
  const head = question.prompt.trim().length > 0 ? question.prompt.trim() : EMPTY_QUESTION_FALLBACK;
  if (question.options.length === 0) return head;
  const list = question.options.map((o) => `• ${o.label}`).join("\n");
  const hint = opts?.answerByOption === true && question.kind === APPROVAL_REQUEST_KIND ? `\n\n${APPROVAL_ANSWER_HINT}` : "";
  return `${head}\n\n${list}${hint}`;
}

export interface RenderQuestionOptions {
  readonly answerByOption?: boolean;
}

export const APPROVAL_ANSWER_HINT = "Reply with one of those words to answer — anything else leaves this waiting.";

export function approvalOptionIds(question: BridgeableQuestion): readonly string[] {
  if (question.kind !== APPROVAL_REQUEST_KIND) return [];
  return question.options.map((o) => o.id).filter((id) => id.length > 0);
}

const APPROVE_WORDS: ReadonlySet<string> = new Set(["approve", "approved", "allow", "yes"]);
const DENY_WORDS: ReadonlySet<string> = new Set(["cancel", "deny", "denied", "reject", "rejected", "no", "stop", "decline"]);

export function resolveApprovalOptionId(text: string, optionIds: readonly string[]): string | undefined {
  const word = text.trim().toLowerCase().replace(/^[^\p{L}\p{N}]+/u, "").replace(/[^\p{L}\p{N}]+$/u, "");
  if (word.length === 0) return undefined;
  const offered = optionIds.filter((id) => id.length > 0);
  const exact = offered.find((id) => id.toLowerCase() === word);
  if (exact !== undefined) return exact;
  const family = APPROVE_WORDS.has(word) ? APPROVE_WORDS : DENY_WORDS.has(word) ? DENY_WORDS : undefined;
  if (family === undefined) return undefined;
  return offered.find((id) => family.has(id.toLowerCase()));
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

function containerKeyOf(origin: UnifiedWakeOrigin): string | undefined {
  try {
    const key = unifiedThreadRef(origin).channelKey;
    return key.length > 0 ? key : undefined;
  } catch {
    return undefined;
  }
}

export async function bridgeQuestionToSurface(
  scope: QuestionBridgeScope,
  question: BridgeableQuestion,
  deps: QuestionBridgeDeps,
): Promise<QuestionBridgeOutcome> {
  const audit = deps.audit ?? appendAudit;
  const text = renderQuestionForSurface(question, { answerByOption: true });
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
    const containerKey = containerKeyOf(origin);
    await row(QUESTION_BRIDGED_AUDIT_ACTION, { ...base, platform: origin.platform, id, ...(containerKey ? { containerKey } : {}) });
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

const BRIDGED_QUESTION_TTL_MS = WAKE_TARGET_TTL_MS;

export function bridgedQuestionKey(bareToken: string): string {
  return `${BRIDGED_QUESTION_PREFIX}${bareToken}`;
}

export interface OutstandingQuestion {
  readonly requestId: string;
  readonly containerKey?: string;
  readonly wakeId?: string;
  readonly taskId?: string;
  readonly optionIds?: readonly string[];
  readonly at: string;
}

export interface BridgedQuestionStore {
  putTaskResult(org: string, key: string, resultJson: string, at: string, ttlMs: number): Promise<void>;
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
  input: {
    readonly requestId: string;
    readonly containerKey?: string;
    readonly wakeId?: string;
    readonly at?: string;
    readonly optionIds?: readonly string[];
  },
): Promise<boolean> {
  try {
    if (bareToken.length === 0 || input.requestId.length === 0) return false;
    const at = input.at ?? new Date().toISOString();
    const taskId = taskIdOfBridgedRequestId(input.requestId);
    const optionIds = (input.optionIds ?? []).filter((id) => id.length > 0);
    const row: OutstandingQuestion = {
      requestId: input.requestId,
      ...(input.containerKey !== undefined && input.containerKey.length > 0 ? { containerKey: input.containerKey } : {}),
      ...(input.wakeId !== undefined && input.wakeId.length > 0 ? { wakeId: input.wakeId } : {}),
      ...(taskId !== undefined ? { taskId } : {}),
      ...(optionIds.length > 0 ? { optionIds } : {}),
      at,
    };
    await store.putTaskResult(org, bridgedQuestionKey(bareToken), JSON.stringify(row), at, BRIDGED_QUESTION_TTL_MS);
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
    const optionIds = Array.isArray(parsed?.optionIds)
      ? (parsed.optionIds as readonly unknown[]).filter((id): id is string => typeof id === "string" && id.length > 0)
      : [];
    return {
      requestId,
      ...(typeof parsed?.containerKey === "string" && parsed.containerKey.length > 0 ? { containerKey: parsed.containerKey } : {}),
      ...(typeof parsed?.wakeId === "string" && parsed.wakeId.length > 0 ? { wakeId: parsed.wakeId } : {}),
      ...(typeof parsed?.taskId === "string" && parsed.taskId.length > 0 ? { taskId: parsed.taskId } : {}),
      ...(optionIds.length > 0 ? { optionIds } : {}),
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
  | {
      readonly kind: "answer";
      readonly requestId: string;
      readonly floor: string;
      readonly wakeId?: string;
      readonly taskId?: string;
      readonly optionId?: string;
    }
  | { readonly kind: "wake"; readonly reason: "internal-dispatch" | "no-question" | "foreign-room" | "refused" | "unmatched-option" };

export interface InboundAnswerDeps {
  readonly read: () => Promise<OutstandingQuestion | undefined>;
  readonly admit: () => Promise<{ readonly ok: true; readonly floor: string } | { readonly ok: false }>;
}

export async function resolveInboundAnswerRouting(
  input: {
    readonly internalDispatch: boolean;
    readonly containerKey?: string;
    readonly text?: string;
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
  const optionIds = outstanding.optionIds;
  let optionId: string | undefined;
  if (optionIds !== undefined && optionIds.length > 0) {
    optionId = resolveApprovalOptionId(input.text ?? "", optionIds);
    if (optionId === undefined) return { kind: "wake", reason: "unmatched-option" };
  }
  const verdict = await deps.admit();
  if (!verdict.ok) return { kind: "wake", reason: "refused" };
  return {
    kind: "answer",
    requestId: outstanding.requestId,
    floor: verdict.floor,
    ...(outstanding.wakeId !== undefined ? { wakeId: outstanding.wakeId } : {}),
    ...(outstanding.taskId !== undefined ? { taskId: outstanding.taskId } : {}),
    ...(optionId !== undefined ? { optionId } : {}),
  };
}
