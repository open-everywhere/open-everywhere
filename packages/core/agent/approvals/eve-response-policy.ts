import type { ApprovalResponseDecision, ApprovalResponsePolicy } from "eve/tools/approval";

export interface ResponderIdentity {
  readonly authenticator: string;
  readonly issuer?: string;
  readonly principalId: string;
  readonly principalType: string;
}

export const FOREIGN_RESPONDER_REASON =
  "Only the person who asked for this can approve it. Nothing was applied and the request is still pending.";

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
  initiator: ResponderIdentity | null | undefined,
): ApprovalResponseDecision {
  if (initiator === null || initiator === undefined) return { status: "allowed" };
  if (sameResponder(responder, initiator)) return { status: "allowed" };
  return { reason: FOREIGN_RESPONDER_REASON, status: "rejected" };
}

export function initiatorBoundResponsePolicy<TInput = Record<string, unknown>>(): ApprovalResponsePolicy<TInput> {
  return (ctx) => decideResponder(ctx.responder as ResponderIdentity, ctx.session.initiator as ResponderIdentity | null);
}
