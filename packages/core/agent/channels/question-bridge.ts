import { isSessionLimitContinuationRequest } from "./session-park.js";
import { WAKE_TARGET_TTL_MS } from "./unified-window.js";
import type { InteractionOpenedData } from "eve/events";

export const QUESTION_DROPPED_AUDIT_ACTION = "turn.question_dropped";

export const EMPTY_QUESTION_FALLBACK = "I asked a question but supplied no text — reply with anything and I'll carry on.";

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

export function bridgeableQuestionOf(data: InteractionOpenedData): BridgeableQuestion | undefined {
  const request = data.request;
  if (request.kind === "sign-in" || request.kind === "budget") return undefined;
  return detectBridgeableInputRequest([
    {
      requestId: data.interactionId,
      kind: request.kind,
      prompt: request.prompt,
      options: request.options ?? [],
      action: { toolName: data.origin?.call?.name },
    },
  ]);
}

export function renderQuestionForSurface(question: BridgeableQuestion): string {
  const head = question.prompt.trim().length > 0 ? question.prompt.trim() : EMPTY_QUESTION_FALLBACK;
  if (question.options.length === 0) return head;
  const list = question.options.map((o) => `• ${o.label}`).join("\n");
  return `${head}\n\n${list}`;
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
  readonly at: string;
}

export interface BridgedQuestionStore {
  putTaskResult(org: string, key: string, resultJson: string, at: string, ttlMs: number): Promise<void>;
  getTaskResult(org: string, key: string): Promise<string | null>;
  deleteTaskResult(org: string, key: string): Promise<boolean>;
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
  },
): Promise<boolean> {
  try {
    if (bareToken.length === 0 || input.requestId.length === 0) return false;
    const at = input.at ?? new Date().toISOString();
    const row: OutstandingQuestion = {
      requestId: input.requestId,
      ...(input.containerKey !== undefined && input.containerKey.length > 0 ? { containerKey: input.containerKey } : {}),
      ...(input.wakeId !== undefined && input.wakeId.length > 0 ? { wakeId: input.wakeId } : {}),
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
    return {
      requestId,
      ...(typeof parsed?.containerKey === "string" && parsed.containerKey.length > 0 ? { containerKey: parsed.containerKey } : {}),
      ...(typeof parsed?.wakeId === "string" && parsed.wakeId.length > 0 ? { wakeId: parsed.wakeId } : {}),
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
    }
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
  };
}
