import { defineHook, type HookContext } from "eve/hooks";
import { appendAudit } from "../audit/audit.js";
import { auditSurfaceModeStamp, bindFrom, deploymentOrg, type BindableContext } from "../identity/binding.js";
import type { SessionMode } from "../access/resolver.js";
import { resolvePartition } from "../memory/partition.js";

export const EVE_APPROVAL_SETTLED_ACTION = "approval.eve_settled";
export const EVE_APPROVAL_CANDIDATE_ACTION = "approval.eve_candidate";

const TERMINAL_CANDIDATE_OUTCOMES: ReadonlySet<string> = new Set(["rejected", "failed", "timed-out", "stale"]);

function stamps(ctx: HookContext): {
  org: string;
  platform: string;
  workspace: string;
  surface?: string;
  surfaceMode?: SessionMode;
  principalId?: string;
} {
  try {
    const p = resolvePartition(ctx as unknown as BindableContext);
    const binding = bindFrom(ctx as unknown as BindableContext);
    return {
      org: p.org,
      platform: p.platform,
      workspace: p.workspace,
      surface: p.surface,
      ...auditSurfaceModeStamp(binding),
      principalId: binding.principalId,
    };
  } catch {
    return { org: deploymentOrg(), platform: "unknown", workspace: "unknown" };
  }
}

interface ApprovalEventData {
  readonly candidateId?: unknown;
  readonly outcome?: unknown;
  readonly reason?: unknown;
  readonly requestId?: unknown;
  readonly responderPrincipalId?: unknown;
  readonly turnId?: unknown;
}

function dataOf(event: unknown): ApprovalEventData | undefined {
  return (event as { data?: ApprovalEventData } | undefined)?.data;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

async function auditApprovalSettled(event: unknown, ctx: HookContext): Promise<void> {
  try {
    const data = dataOf(event);
    const outcome = str(data?.outcome);
    const requestId = str(data?.requestId);
    if (outcome === undefined || requestId === undefined) return;
    await appendAudit({
      ...stamps(ctx),
      action: EVE_APPROVAL_SETTLED_ACTION,
      detail: {
        requestId,
        outcome,
        ...(str(data?.responderPrincipalId) !== undefined ? { responderPrincipalId: str(data?.responderPrincipalId) } : {}),
        ...(str(data?.turnId) !== undefined ? { turnId: str(data?.turnId) } : {}),
      },
    });
  } catch {
  }
}

async function auditApprovalCandidate(event: unknown, ctx: HookContext): Promise<void> {
  try {
    const data = dataOf(event);
    const outcome = str(data?.outcome);
    const requestId = str(data?.requestId);
    if (outcome === undefined || requestId === undefined) return;
    if (!TERMINAL_CANDIDATE_OUTCOMES.has(outcome)) return;
    await appendAudit({
      ...stamps(ctx),
      action: EVE_APPROVAL_CANDIDATE_ACTION,
      detail: {
        requestId,
        outcome,
        ...(str(data?.candidateId) !== undefined ? { candidateId: str(data?.candidateId) } : {}),
        ...(str(data?.responderPrincipalId) !== undefined ? { responderPrincipalId: str(data?.responderPrincipalId) } : {}),
        ...(str(data?.reason) !== undefined ? { reason: str(data?.reason) } : {}),
        ...(str(data?.turnId) !== undefined ? { turnId: str(data?.turnId) } : {}),
      },
    });
  } catch {
  }
}

export default defineHook({
  events: {
    "approval.candidate": (event, ctx) => auditApprovalCandidate(event, ctx),
    "approval.settled": (event, ctx) => auditApprovalSettled(event, ctx),
  },
});
