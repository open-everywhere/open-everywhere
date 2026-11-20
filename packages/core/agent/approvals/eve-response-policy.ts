import type { ApprovalResponse, ApprovalResponseDecision, ApprovalResponsePolicy } from "eve/tools/approval";

export interface ResponderIdentity {
  readonly authenticator: string;
  readonly issuer?: string;
  readonly principalId: string;
  readonly principalType: string;
}

export type ResponseDecision = ApprovalResponse["decision"];

export const FOREIGN_RESPONDER_REASON =
  "Only the person who asked for this can approve it. Nothing was applied and the request is still pending.";

export const FOREIGN_DENY_REASON =
  "Only the person who asked for this can deny it. Nothing was denied and the request is still pending.";

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
  return { reason: decision === "deny" ? FOREIGN_DENY_REASON : FOREIGN_RESPONDER_REASON, status: "rejected" };
}

export function requesterBoundResponsePolicy<TInput = Record<string, unknown>>(): ApprovalResponsePolicy<TInput> {
  return (ctx) =>
    decideResponder(
      ctx.response.principal as ResponderIdentity,
      (ctx.request.principal ?? ctx.session.initiator) as ResponderIdentity | null,
      ctx.response.decision,
    );
}
