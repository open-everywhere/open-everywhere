import type { ApprovalResponseDecision, ApprovalResponsePolicy } from "eve/tools/approval";

export interface ResponderIdentity {
  readonly authenticator: string;
  readonly issuer?: string;
  readonly principalId: string;
  readonly principalType: string;
}

export type ResponseDecision = "approve" | "cancel";

export const FOREIGN_RESPONDER_REASON =
  "Only the person who asked for this can approve it. Nothing was applied and the request is still pending.";

export const FOREIGN_CANCEL_REASON =
  "Only the person who asked for this can cancel it. Nothing was cancelled and the request is still pending.";

export function sameResponder(a: ResponderIdentity | null | undefined, b: ResponderIdentity | null | undefined): boolean {
  if (a === null || a === undefined || b === null || b === undefined) return false;
  return (
    a.authenticator === b.authenticator &&
    (a.issuer ?? "") === (b.issuer ?? "") &&
    a.principalType === b.principalType &&
    a.principalId === b.principalId
  );
}

export function decideResponder(
  responder: ResponderIdentity | null | undefined,
  bound: ResponderIdentity | null | undefined,
  decision: ResponseDecision = "approve",
): ApprovalResponseDecision {
  if (bound === null || bound === undefined) return { status: "allowed" };
  if (sameResponder(responder, bound)) return { status: "allowed" };
  return { reason: decision === "cancel" ? FOREIGN_CANCEL_REASON : FOREIGN_RESPONDER_REASON, status: "rejected" };
}

export function requesterBoundResponsePolicy<TInput = Record<string, unknown>>(): ApprovalResponsePolicy<TInput> {
  return (ctx) =>
    decideResponder(
      ctx.response.principal as ResponderIdentity,
      (ctx.request.principal ?? ctx.session.initiator) as ResponderIdentity | null,
      ctx.response.decision,
    );
}
