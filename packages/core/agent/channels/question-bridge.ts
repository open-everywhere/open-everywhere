import { appendAudit, type AuditInput } from "../audit/audit.js";
import { isSessionLimitContinuationRequest } from "./session-park.js";
import type { UnifiedWakeOrigin } from "./unified-window.js";

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
  | { readonly status: "bridged"; readonly platform: string; readonly id: string }
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
    return { status: "bridged", platform: origin.platform, id };
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
