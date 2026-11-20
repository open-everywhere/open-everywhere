import { defineHook, type HookContext } from "eve/hooks";
import { delivery, interaction, type SessionView } from "eve/events";
import { defineState } from "eve/context";
import { appendAudit } from "../audit/audit.js";
import { auditSurfaceModeStamp, bindFrom, deploymentOrg, type BindableContext } from "../identity/binding.js";
import type { SessionMode } from "../access/resolver.js";
import { resolvePartition } from "../memory/partition.js";
import { optional } from "./control-refusal.js";

export const EVE_APPROVAL_SETTLED_ACTION = "approval.eve_settled";
export const EVE_APPROVAL_CANDIDATE_ACTION = "approval.eve_candidate";

const TERMINAL_CANDIDATE_OUTCOMES: ReadonlySet<string> = new Set(["refused", "failed", "expired", "withdrawn", "abandoned"]);

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

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

const RESPONSES_KEPT = 64;

interface SubmittedResponse {
  readonly interactionId: string;
  readonly kind?: string;
  readonly responderPrincipalId?: string;
}

const submittedResponses = defineState<Readonly<Record<string, SubmittedResponse>>>("open-everywhere.approval-settlement.responses", () => ({}));

export function noteSubmittedResponse(responseId: unknown, interactionId: unknown, responderPrincipalId?: unknown, kind?: unknown): void {
  const r = str(responseId);
  const i = str(interactionId);
  if (r === undefined || i === undefined) return;
  const responder = str(responderPrincipalId);
  const k = str(kind);
  submittedResponses.update((all) => {
    const { [r]: _replaced, ...rest } = all;
    const kept = Object.entries(rest).slice(-(RESPONSES_KEPT - 1));
    return { ...Object.fromEntries(kept), [r]: { interactionId: i, ...(k !== undefined ? { kind: k } : {}), ...(responder !== undefined ? { responderPrincipalId: responder } : {}) } };
  });
}

function takeSubmittedResponse(responseId: string): SubmittedResponse | undefined {
  let found: SubmittedResponse | undefined;
  try {
    submittedResponses.update((all) => {
      found = all[responseId];
      if (found === undefined) return all;
      const { [responseId]: _taken, ...rest } = all;
      return rest;
    });
  } catch {
    return undefined;
  }
  return found;
}

function approvalOf(view: SessionView | undefined, interactionId: string): { readonly turnId?: string } | undefined {
  const row = view === undefined ? undefined : interaction(view, interactionId);
  if (row === undefined || row.request.kind !== "approval") return undefined;
  return { turnId: row.turnId };
}

export async function auditApprovalSettled(data: { readonly interactionId?: unknown; readonly outcome?: unknown; readonly cause?: unknown }, ctx: HookContext): Promise<void> {
  const outcome = str(data.outcome);
  const requestId = str(data.interactionId);
  const responseId = str((data.cause as { readonly responseId?: unknown } | undefined)?.responseId);
  const responderPrincipalId = responseId === undefined ? undefined : takeSubmittedResponse(responseId)?.responderPrincipalId;
  if (outcome === undefined || requestId === undefined) return;
  const approval = approvalOf(ctx.view, requestId);
  if (approval === undefined) return;
  await appendAudit({
    ...stamps(ctx),
    action: EVE_APPROVAL_SETTLED_ACTION,
    detail: {
      requestId,
      outcome,
      ...(responseId !== undefined ? { candidateId: responseId } : {}),
      ...(responderPrincipalId !== undefined ? { responderPrincipalId } : {}),
      ...(str(approval.turnId) !== undefined ? { turnId: str(approval.turnId) } : {}),
    },
  });
}

export async function auditApprovalCandidate(data: { readonly responseId?: unknown; readonly outcome?: unknown; readonly reason?: unknown }, ctx: HookContext): Promise<void> {
  const outcome = str(data.outcome);
  const candidateId = str(data.responseId);
  if (outcome === undefined || candidateId === undefined) return;
  if (outcome === "applied") return;
  const submitted = takeSubmittedResponse(candidateId);
  if (!TERMINAL_CANDIDATE_OUTCOMES.has(outcome)) return;
  if (submitted?.kind !== undefined && submitted.kind !== "approval") return;
  const requestId = submitted?.interactionId;
  const approval = requestId === undefined ? undefined : approvalOf(ctx.view, requestId);
  if (requestId !== undefined && approval === undefined) return;
  await appendAudit({
    ...stamps(ctx),
    action: EVE_APPROVAL_CANDIDATE_ACTION,
    detail: {
      ...(requestId !== undefined ? { requestId } : { requestUnread: true, interactionKind: "unknown" }),
      outcome,
      candidateId,
      ...(submitted?.responderPrincipalId !== undefined ? { responderPrincipalId: submitted.responderPrincipalId } : {}),
      ...(str(data.reason) !== undefined ? { reason: str(data.reason) } : {}),
      ...(str(approval?.turnId) !== undefined ? { turnId: str(approval?.turnId) } : {}),
    },
  });
}

export default defineHook({
  events: {
    "response.submitted": optional("approval-settlement", (event, ctx) =>
      noteSubmittedResponse(
        event.data.responseId,
        event.data.interactionId,
        delivery(ctx.view, event.data.deliveryId)?.principal?.id,
        interaction(ctx.view, event.data.interactionId)?.request.kind,
      ),
    ),
    "response.settled": optional("approval-settlement", (event, ctx) => auditApprovalCandidate(event.data, ctx)),
    "interaction.settled": optional("approval-settlement", (event, ctx) => auditApprovalSettled(event.data, ctx)),
  },
});
