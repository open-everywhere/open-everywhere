import { appendAudit } from "../audit/audit.js";
import { replySentences } from "./memory-claim-guard.js";
import { peekCardPostedThisTurn } from "../approvals/card-signal.js";
import {
  describeStandingWriteGrant,
  gatedConnectorWritesThisTurn,
  standingWriteGrantsInForce,
  type GatedConnectorWrite,
  type StandingWriteGrant,
} from "./standing-authority.js";
import type { ReplyAudit } from "./reply-post.js";

export const APPROVAL_CLAIM_WITHHELD_ACTION = "approval.claim_withheld";

export type ApprovalClaimCause = "approval-gate-ran" | "gated-connector-write" | "standing-write-grant";

export type ApprovalClaimShape = "none-required" | "none-presented" | "without-approval";

export interface ApprovalClaim {
  readonly shape: ApprovalClaimShape;
  readonly sentence: number;
  readonly start: number;
  readonly end: number;
}

const CLAIM_PATTERNS: readonly { readonly shape: ApprovalClaimShape; readonly re: RegExp }[] = [
  {
    shape: "none-presented",
    re: /\bno\b[^.!?\n]{0,60}\b(?:approval|confirmation|consent|permission|approval\s+card|prompt)\b[^.!?\n]{0,60}\b(?:presented|shown|raised|appeared|requested|asked\s+for|prompted)\b/i,
  },
  {
    shape: "none-required",
    re: /\bno\b[^.!?\n]{0,60}\b(?:approval|confirmation|consent|authoris(?:ation|ed)|authoriz(?:ation|ed)|permission|sign-?off)\b[^.!?\n]{0,60}\b(?:required|requirement|needed|necessary)\b/i,
  },
  {
    shape: "none-required",
    re: /\b(?:approval|confirmation|consent|permission)\b[^.!?\n]{0,40}\b(?:was|were|is|are)\s+(?:not|never)\s+(?:\w+\s+){0,2}(?:required|needed|necessary|requested|presented|shown|raised|prompted|asked\s+for)\b|\b(?:did|does|do)(?:\s+not|n't)\s+(?:need|require|ask\s+for|prompt\s+for|call\s+for)\b[^.!?\n]{0,40}\b(?:approval|confirmation|consent|permission)\b/i,
  },
  {
    shape: "without-approval",
    re: /\bwithout\s+(?:any\s+|further\s+|explicit\s+|prior\s+|additional\s+)*(?:approval|confirmation|consent|permission|an?\s+approval\s+card|a\s+prompt|prompting)\b/i,
  },
];

const MODAL_BEFORE = /\b(?:will|'ll|shall|would|could|can|should|must|going\s+to|about\s+to|let\s+me|if|unless|when|once|whether)\b[^.!?\n]{0,40}$/i;

const MODAL_IN_SPAN = /\b(?:will|'ll|shall|would|could|should|must|going\s+to|about\s+to)\b/i;

const QUESTION = /\?[\s*_>)\]]*$/;

export function detectNoApprovalClaims(text: string): readonly ApprovalClaim[] {
  const claims: ApprovalClaim[] = [];
  const sentences = replySentences(text);
  for (let i = 0; i < sentences.length; i++) {
    const segment = sentences[i]!;
    const s = segment.text;
    if (QUESTION.test(s.trimEnd())) continue;
    for (const p of CLAIM_PATTERNS) {
      const m = p.re.exec(s);
      if (m === null) continue;
      if (MODAL_BEFORE.test(s.slice(0, m.index)) || MODAL_IN_SPAN.test(m[0])) continue;
      claims.push({ shape: p.shape, sentence: i, start: segment.start + m.index, end: segment.start + m.index + m[0].length });
      break;
    }
  }
  return claims;
}

export interface StandingAuthorityView {
  readonly approvalGateRan: boolean;
  readonly gatedWrites: readonly GatedConnectorWrite[];
  readonly grants: readonly StandingWriteGrant[];
}

const MAX_NAMED_GRANTS = 2;

export const NO_CARD_NOTE_OPENING = "(No card was raised on this turn.";

export function standingAuthorityNote(view: StandingAuthorityView): string | undefined {
  if (view.approvalGateRan) return "(An approval gate ran on this turn, so this act was not ungated.)";
  if (view.gatedWrites.length > 0) {
    const connections = [...new Set(view.gatedWrites.map((w) => w.connection))].join(", ");
    return (
      `${NO_CARD_NOTE_OPENING} A gated ${connections} write ran on it, ` +
      `which means an approval already stood for this session — not that the write is ungated.)`
    );
  }
  if (view.grants.length > 0) {
    const named = view.grants.slice(0, MAX_NAMED_GRANTS).map(describeStandingWriteGrant).join("; ");
    const more = view.grants.length - MAX_NAMED_GRANTS;
    return (
      `${NO_CARD_NOTE_OPENING} Writes in this room ride a standing grant: ${named}` +
      `${more > 0 ? `, and ${more} more` : ""}. The host sees the policy, not the request, so it cannot say whether this act used it.)`
    );
  }
  return undefined;
}

export interface ApprovalClaimGuardResult {
  readonly body: string;
  readonly withheld: readonly ApprovalClaim[];
  readonly cause?: ApprovalClaimCause;
}

function causeOf(view: StandingAuthorityView): ApprovalClaimCause | undefined {
  if (view.approvalGateRan) return "approval-gate-ran";
  if (view.gatedWrites.length > 0) return "gated-connector-write";
  if (view.grants.length > 0) return "standing-write-grant";
  return undefined;
}

function joinSeam(left: string, right: string): string {
  const l = left.replace(/[^\S\n]+$/u, "");
  const r = right.replace(/^[^\S\n]+/u, "");
  if (l === "") return r;
  if (r === "") return l;
  return /\n$/u.test(l) ? `${l}${r}` : `${l} ${r}`;
}

function removalEnd(text: string, claim: ApprovalClaim): number {
  for (const segment of replySentences(text)) {
    if (claim.start >= segment.start && claim.start < segment.end) return Math.max(segment.end, claim.end);
  }
  return claim.end;
}

export function applyApprovalClaimGuard(text: string, view: StandingAuthorityView): ApprovalClaimGuardResult {
  const note = standingAuthorityNote(view);
  if (note === undefined) return { body: text, withheld: [] };
  const claims = detectNoApprovalClaims(text);
  if (claims.length === 0) return { body: text, withheld: [] };
  let out = "";
  let cursor = 0;
  for (const [i, claim] of claims.entries()) {
    if (claim.start < cursor) continue;
    out = joinSeam(out, text.slice(cursor, claim.start));
    if (i === 0) out = joinSeam(out, note);
    cursor = removalEnd(text, claim);
  }
  out = joinSeam(out, text.slice(cursor));
  return { body: out.replace(/[^\S\n]+$/u, ""), withheld: claims, cause: causeOf(view)! };
}

export async function auditWithheldApprovalClaim(
  audit: ReplyAudit | undefined,
  platform: string,
  withheld: readonly ApprovalClaim[],
  cause: ApprovalClaimCause | undefined,
): Promise<void> {
  if (!audit || withheld.length === 0 || cause === undefined) return;
  await appendAudit({
    org: audit.org,
    platform,
    workspace: audit.workspace,
    surface: audit.surface,
    principalId: audit.principalId,
    action: APPROVAL_CLAIM_WITHHELD_ACTION,
    detail: {
      claims: withheld.length,
      cause,
      shapes: [...new Set(withheld.map((c) => c.shape))],
      sentences: withheld.map((c) => c.sentence),
      ...(audit.wakeId ? { wakeId: audit.wakeId } : {}),
      ...(audit.sessionId ? { sessionId: audit.sessionId } : {}),
      ...(audit.turnId ? { turnId: audit.turnId } : {}),
    },
  }).catch(() => undefined);
}

export function guardApprovalClaims(text: string, audit: ReplyAudit | undefined): ApprovalClaimGuardResult {
  return applyApprovalClaimGuard(text, {
    approvalGateRan: peekCardPostedThisTurn(),
    gatedWrites: gatedConnectorWritesThisTurn(audit?.turnId),
    grants: standingWriteGrantsInForce(),
  });
}
