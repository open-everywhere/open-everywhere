import { appendAudit } from "../audit/audit.js";
import { peekCardPostedThisTurn } from "../approvals/card-signal.js";
import { accessRequestsProposedThisTurn } from "./access-request-ledger.js";
import { replySentences } from "./memory-claim-guard.js";
import type { ReplyAudit } from "./reply-post.js";

export const REQUEST_CLAIM_WITHHELD_ACTION = "access_request.claim_withheld";

export const WITHHELD_REQUEST_CLAIM_NOTE =
  "(I can't confirm a request has gone in yet.)";

export type RequestClaimShape = "submitted" | "raised" | "pending-approval";

export type RequestClaimSubject = "access" | "other-approval" | "generic";

export interface RequestClaim {
  readonly shape: RequestClaimShape;
  readonly subject: RequestClaimSubject;
  readonly sentence: number;
  readonly namesCard: boolean;
}

const CLAIM_PATTERNS: readonly { readonly shape: RequestClaimShape; readonly re: RegExp }[] = [
  {
    shape: "submitted",
    re: /\b(?:submitted|sent|filed|lodged|raised|opened|posted|created|put\s+in)\b[^.!?\n]{0,60}\b(?:access\s+request|request|proposal|approval\s+card|card)\b/i,
  },
  {
    shape: "raised",
    re: /\b(?:access\s+request|request|proposal|approval\s+card|card)\b[^.!?\n]{0,40}\b(?:was|were|has\s+been|have\s+been|had\s+been)\s+(?:\w+\s+){0,2}(?:submitted|sent|filed|lodged|raised|opened|posted|created)\b/i,
  },
  {
    shape: "pending-approval",
    re: /\b(?:is|are|it's|that's|they're)\s+(?:now\s+|currently\s+)?(?:pending|awaiting|waiting\s+(?:on|for))\b[^.!?\n]{0,40}\b(?:approval|approver|approvers|sign-?off)\b/i,
  },
];

const VERB_FIRST_PATTERN = CLAIM_PATTERNS[0]!;

const PENDING_PATTERN = CLAIM_PATTERNS[2]!;

const ACCESS_SUBJECT =
  /\b(?:access|scope|scoped|widen(?:ing|ed)?|permission|permissions|connector|connection|grant)\b/i;

const APPROVAL_KINDS =
  "routine|purge|spend(?:[-\\s]limits?)?|ticket|skill|webhook|pull[-\\s]request|" +
  "connector[-\\s](?:write|op|operation|revocation)|agent[-\\s]creation";

const OTHER_APPROVAL_KIND = new RegExp(
  `\\b(?:${APPROVAL_KINDS})(?:'s)?[-\\s]+(?:approval[-\\s]+)?(?:approval|card|request|proposal)\\b`,
  "i",
);

const KIND_QUALIFIER_BEFORE = new RegExp(`\\b(?:${APPROVAL_KINDS})(?:'s)?[-\\s]+(?:approval[-\\s]+)?$`, "i");

const CARD_NOUN = /\bcard\b/i;

const MODAL_BEFORE =
  /\b(?:will|'ll|shall|would|could|can|should|must|going\s+to|about\s+to|let\s+me|once|after|when|if|unless|whether|before|has\s+to|have\s+to|had\s+to|needs?\s+to|need\s+to|ought\s+to)\b[^.!?\n]{0,40}$/i;

const MODAL_IN_SPAN = /\b(?:will|'ll|shall|would|could|should|must|going\s+to|about\s+to|has\s+to|have\s+to|needs?\s+to|ought\s+to)\b/i;

const NEGATION_BEFORE = /\b(?:not|never|nothing|none|no|cannot|unable)\b[^.!?\n]{0,40}$|n't\s[^.!?\n]{0,40}$/i;

const NEGATION_IN_SPAN = /\b(?:not|never|nothing|none|cannot|unable)\b|n't\b/i;

const QUESTION = /\?[\s*_>)\]]*$/;

const PRIOR_ROW_REFERENCE =
  /\b(?:still|already|earlier|yesterday|previously|previous|existing|outstanding|since|last\s+(?:week|month|night)|from\s+(?:yesterday|last|earlier))\b/i;

const ACK_BEFORE = /(?:^[\s*_>\-#]*|\b(?:i|we|it|that|this|which|they|has|have|had|is|are|was|were|been|now|already|just|i've|we've)\s+(?:\w+\s+){0,1})$/i;

export function detectRequestClaims(text: string): readonly RequestClaim[] {
  const claims: RequestClaim[] = [];
  const sentences = replySentences(text);
  for (let i = 0; i < sentences.length; i++) {
    const s = sentences[i]!.text;
    if (QUESTION.test(s.trimEnd())) continue;
    for (const p of CLAIM_PATTERNS) {
      const m = p.re.exec(s);
      if (m === null) continue;
      const before = s.slice(0, m.index);
      if (MODAL_BEFORE.test(before) || MODAL_IN_SPAN.test(m[0])) continue;
      if (NEGATION_BEFORE.test(before) || NEGATION_IN_SPAN.test(m[0])) continue;
      if (p === PENDING_PATTERN && PRIOR_ROW_REFERENCE.test(s)) continue;
      if (p === VERB_FIRST_PATTERN && !ACK_BEFORE.test(before)) continue;
      claims.push({
        shape: p.shape,
        subject: claimSubject(s, before, m[0], p !== PENDING_PATTERN),
        sentence: i,
        namesCard: CARD_NOUN.test(m[0]),
      });
      break;
    }
  }
  if (!claims.some((c) => c.subject === "access")) return claims;
  return claims.map((c) => (c.subject === "generic" ? { ...c, subject: "access" as const } : c));
}

function claimSubject(sentence: string, before: string, span: string, kindMayQualify: boolean): RequestClaimSubject {
  if (ACCESS_SUBJECT.test(span)) return "access";
  if (kindMayQualify && (OTHER_APPROVAL_KIND.test(span) || KIND_QUALIFIER_BEFORE.test(before))) return "other-approval";
  return ACCESS_SUBJECT.test(sentence) ? "access" : "generic";
}

export interface RequestClaimGuardResult {
  readonly body: string;
  readonly withheld: readonly RequestClaim[];
}

export interface RequestClaimEvidence {
  readonly proposed: boolean;
  readonly cardMinted: boolean;
}

function strikesClaim(claim: RequestClaim, evidence: RequestClaimEvidence): boolean {
  if (claim.subject === "other-approval") return false;
  if (claim.subject === "access") return !evidence.proposed;
  return !evidence.proposed && !(evidence.cardMinted && claim.namesCard);
}

export function applyRequestClaimGuard(text: string, evidence: RequestClaimEvidence): RequestClaimGuardResult {
  const hadNote = text.includes(WITHHELD_REQUEST_CLAIM_NOTE);
  const bare = hadNote ? text.split(WITHHELD_REQUEST_CLAIM_NOTE).join("").trimEnd() : text;
  const claims = detectRequestClaims(bare);
  const withheld = claims.filter((c) => strikesClaim(c, evidence));
  if (withheld.length === 0) {
    const backed = evidence.proposed || claims.some((c) => c.subject === "generic");
    return { body: hadNote && !backed ? `${bare}\n\n${WITHHELD_REQUEST_CLAIM_NOTE}` : bare, withheld: [] };
  }
  const struck = new Set(withheld.map((c) => c.sentence));
  const sentences = replySentences(bare);
  const kept = sentences.filter((_, i) => !struck.has(i)).map((s) => s.text);
  const body = `${kept.join("").trimEnd()}\n\n${WITHHELD_REQUEST_CLAIM_NOTE}`.trimStart();
  return { body, withheld };
}

export async function auditWithheldRequestClaim(
  audit: ReplyAudit | undefined,
  platform: string,
  withheld: readonly RequestClaim[],
): Promise<void> {
  if (!audit || withheld.length === 0) return;
  await appendAudit({
    org: audit.org,
    platform,
    workspace: audit.workspace,
    surface: audit.surface,
    ...(audit.surfaceMode === undefined ? {} : { surfaceMode: audit.surfaceMode }),
    principalId: audit.principalId,
    action: REQUEST_CLAIM_WITHHELD_ACTION,
    detail: {
      claims: withheld.length,
      shapes: [...new Set(withheld.map((c) => c.shape))],
      subjects: [...new Set(withheld.map((c) => c.subject))],
      sentences: withheld.map((c) => c.sentence),
      ...(audit.wakeId ? { wakeId: audit.wakeId } : {}),
      ...(audit.sessionId ? { sessionId: audit.sessionId } : {}),
      ...(audit.turnId ? { turnId: audit.turnId } : {}),
    },
  }).catch(() => undefined);
}

export function guardRequestClaims(text: string, audit: ReplyAudit | undefined): RequestClaimGuardResult {
  return applyRequestClaimGuard(text, {
    proposed: accessRequestsProposedThisTurn(audit?.turnId).length > 0,
    cardMinted: peekCardPostedThisTurn(),
  });
}
