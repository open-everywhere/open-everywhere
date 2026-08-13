import { createHash } from "node:crypto";
import type { Approval, ApprovalContext, ApprovalStatus } from "eve/tools/approval";
import { deploymentOrg } from "../identity/binding.js";
import { getOperationalStore } from "../operational/provider.js";

export const DUPLICATE_APPROVAL_KEY_PREFIX = "approval-pending:";

export const DUPLICATE_APPROVAL_WINDOW_MS = 5 * 60_000;

export type HasEventSeen = (org: string, key: string, atIso: string, ttlMs: number) => Promise<boolean>;

export type MarkEventSeen = (org: string, key: string, atIso: string, ttlMs: number) => Promise<boolean>;

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

export function approvalFingerprintKey(sessionId: string, toolName: string, toolInput: unknown): string {
  const material = `${sessionId}\x00${toolName}\x00${stableStringify(toolInput ?? {})}`;
  const digest = createHash("sha256").update(material).digest("hex");
  return `${DUPLICATE_APPROVAL_KEY_PREFIX}${digest}`;
}

function decisionPrompts(decision: ApprovalStatus): boolean {
  if (decision === true || decision === "user-approval") return true;
  return typeof decision === "object" && decision !== null && decision.type === "user-approval";
}

export interface DuplicateApprovalGuardOptions {
  readonly windowMs?: number;
  readonly now?: () => number;
  readonly hasEventSeen?: HasEventSeen;
}

export function withDuplicateApprovalGuard<TInput = Record<string, unknown>>(
  policy: Approval<TInput>,
  opts: DuplicateApprovalGuardOptions = {},
): Approval<TInput> {
  const windowMs = opts.windowMs ?? DUPLICATE_APPROVAL_WINDOW_MS;
  const nowFn = opts.now ?? Date.now;
  const peek: HasEventSeen =
    opts.hasEventSeen ?? ((org, key, atIso, ttlMs) => getOperationalStore().hasEventSeen(org, key, atIso, ttlMs));

  return async (ctx: ApprovalContext<TInput>): Promise<ApprovalStatus> => {
    const decision = await policy(ctx);
    if (!decisionPrompts(decision)) return decision;

    let alreadyOpen = false;
    try {
      const key = approvalFingerprintKey(ctx.session.id, ctx.toolName, ctx.toolInput);
      alreadyOpen = await peek(deploymentOrg(), key, new Date(nowFn()).toISOString(), windowMs);
    } catch {
      alreadyOpen = false;
    }
    if (!alreadyOpen) return decision;
    return {
      type: "denied",
      reason:
        "An identical action is already awaiting approval on an earlier card. Answer that card " +
        "(or wait a few minutes and ask again) instead of raising a second, separate one.",
    };
  };
}

export interface RecordApprovalRaisedOptions {
  readonly windowMs?: number;
  readonly now?: () => number;
  readonly markEventSeen?: MarkEventSeen;
}

export async function recordApprovalRaised(
  sessionId: string,
  toolName: string,
  toolInput: unknown,
  opts: RecordApprovalRaisedOptions = {},
): Promise<void> {
  const windowMs = opts.windowMs ?? DUPLICATE_APPROVAL_WINDOW_MS;
  const nowFn = opts.now ?? Date.now;
  const mark: MarkEventSeen =
    opts.markEventSeen ?? ((org, key, atIso, ttlMs) => getOperationalStore().markEventSeen(org, key, atIso, ttlMs));
  const key = approvalFingerprintKey(sessionId, toolName, toolInput);
  await mark(deploymentOrg(), key, new Date(nowFn()).toISOString(), windowMs);
}
