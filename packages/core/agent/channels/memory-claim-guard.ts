import { appendAudit } from "../audit/audit.js";
import { factStoredThisTurn } from "../memory/write-evidence.js";
import type { ReplyAudit } from "./reply-post.js";

export const MEMORY_CLAIM_WITHHELD_ACTION = "memory.claim_withheld";

export const WITHHELD_CLAIM_NOTE =
  "(I can't confirm that's saved yet.)";

export type MemoryClaimShape = "stored" | "remembered" | "index-updated";

export interface MemoryClaim {
  readonly shape: MemoryClaimShape;
  readonly sentence: number;
}

const CLAIM_PATTERNS: readonly { readonly shape: MemoryClaimShape; readonly re: RegExp }[] = [
  {
    shape: "stored",
    re: /\b(?:saved|stored|written|recorded|persisted|committed)\b[^.!?\n]*\b(?:memory|silo|durable|notes?\s+file|memory\s+file)\b/i,
  },
  {
    shape: "stored",
    re: /\b(?:memory|silo|durable\s+notes?|memory\s+file|notes?\s+file)\b[^.!?\n]*\b(?:was|were|is|are|has been|have been|now)\b[^.!?\n]*\b(?:saved|stored|written|recorded|persisted|updated|committed)\b/i,
  },
  { shape: "remembered", re: /\b(?:have|has|i've|we've)\s+(?:now\s+)?remembered\b|\bis\s+now\s+remembered\b/i },
  { shape: "index-updated", re: /\b(?:curated\s+)?memory\s+index\b[^.!?\n]*\b(?:updated|refreshed|rebuilt|written)\b/i },
  {
    shape: "stored",
    re: /\b(?:is|are|it's|that's|they're|we're)\s+now\s+(?:in|inside|within|part\s+of)\s+(?:the\s+|your\s+|our\s+|my\s+|team\s+)*[^.!?\n,]{0,12}?\b(?:durable\s+notes?|memory\s+index|memory\s+file|notes?\s+file|memory|silo)\b/i,
  },
  { shape: "stored", re: /^[\s*_>\-#]*(?:recorded|saved|stored|persisted)\b/i },
];

const BARE_ACK_PATTERN = CLAIM_PATTERNS[CLAIM_PATTERNS.length - 1]!;

const PRESENT_LOCATION_PATTERN = CLAIM_PATTERNS[CLAIM_PATTERNS.length - 2]!;

const TRAILING_CLAUSE = /[,;]/;

const VERB_FIRST_PATTERN = CLAIM_PATTERNS[0]!;

const EXTERNAL_DESTINATION =
  /\b(?:github|linear|notion|jira|slack|discord|teams|pull\s+request|issue|ticket|release\s+notes?|changelog|repo(?:sitory)?|branch|commit|channel|thread|document)\b/i;

const CITATION_IN_SENTENCE = /[^\s]+\/[^\s]+|\.(?:md|txt)\b/i;

const MODAL_BEFORE = /\b(?:will|'ll|shall|would|could|can|should|must|going\s+to|about\s+to|let\s+me|once|after|when|if|before)\b[^.!?\n]{0,40}$/i;

const MODAL_IN_SPAN = /\b(?:will|'ll|shall|would|could|should|must|going\s+to|about\s+to)\b/i;

const NEGATION_BEFORE = /\b(?:not|never|nothing|none|no|cannot|unable)\b[^.!?\n]{0,40}$|n't\s[^.!?\n]{0,40}$/i;

const NEGATION_IN_SPAN = /\b(?:not|never|nothing|none|cannot|unable)\b|n't\b/i;

const ACK_BEFORE = /(?:^[\s*_>\-#]*|\b(?:i|we|it|that|this|which|they|has|have|had|is|are|was|were|been|now|already|just|i've|we've)\s+(?:\w+\s+){0,1})$/i;

export function replySentences(text: string): readonly { readonly text: string; readonly start: number; readonly end: number }[] {
  const out: { text: string; start: number; end: number }[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === "." || ch === "!" || ch === "?" || ch === "\n") {
      let end = i + 1;
      while (end < text.length && (text[end] === "." || text[end] === "!" || text[end] === "?")) end++;
      out.push({ text: text.slice(start, end), start, end });
      start = end;
      i = end - 1;
    }
  }
  if (start < text.length) out.push({ text: text.slice(start), start, end: text.length });
  return out;
}

export function detectDurabilityClaims(text: string): readonly MemoryClaim[] {
  const claims: MemoryClaim[] = [];
  const sentences = replySentences(text);
  for (let i = 0; i < sentences.length; i++) {
    const s = sentences[i]!.text;
    for (const p of CLAIM_PATTERNS) {
      const m = p.re.exec(s);
      if (m === null) continue;
      const before = s.slice(0, m.index);
      if (MODAL_BEFORE.test(before) || MODAL_IN_SPAN.test(m[0])) continue;
      if (NEGATION_BEFORE.test(before) || NEGATION_IN_SPAN.test(m[0])) continue;
      if (p === BARE_ACK_PATTERN && (EXTERNAL_DESTINATION.test(s) || CITATION_IN_SENTENCE.test(s))) continue;
      if (p === PRESENT_LOCATION_PATTERN && (TRAILING_CLAUSE.test(before) || CITATION_IN_SENTENCE.test(s))) continue;
      if (p === VERB_FIRST_PATTERN && !ACK_BEFORE.test(before)) continue;
      claims.push({ shape: p.shape, sentence: i });
      break;
    }
  }
  return claims;
}

export interface MemoryClaimGuardResult {
  readonly body: string;
  readonly withheld: readonly MemoryClaim[];
}

export function applyMemoryClaimGuard(text: string, stored: boolean): MemoryClaimGuardResult {
  const hadNote = text.includes(WITHHELD_CLAIM_NOTE);
  const bare = hadNote ? text.split(WITHHELD_CLAIM_NOTE).join("").trimEnd() : text;
  if (stored) return { body: bare, withheld: [] };
  const claims = detectDurabilityClaims(bare);
  if (claims.length === 0) return { body: hadNote ? `${bare}\n\n${WITHHELD_CLAIM_NOTE}` : bare, withheld: [] };
  const struck = new Set(claims.map((c) => c.sentence));
  const sentences = replySentences(bare);
  const kept = sentences.filter((_, i) => !struck.has(i)).map((s) => s.text);
  const body = `${kept.join("").trimEnd()}\n\n${WITHHELD_CLAIM_NOTE}`.trimStart();
  return { body, withheld: claims };
}

export async function auditWithheldMemoryClaim(
  audit: ReplyAudit | undefined,
  platform: string,
  withheld: readonly MemoryClaim[],
): Promise<void> {
  if (!audit || withheld.length === 0) return;
  await appendAudit({
    org: audit.org,
    platform,
    workspace: audit.workspace,
    surface: audit.surface,
    ...(audit.surfaceMode === undefined ? {} : { surfaceMode: audit.surfaceMode }),
    principalId: audit.principalId,
    action: MEMORY_CLAIM_WITHHELD_ACTION,
    detail: {
      claims: withheld.length,
      shapes: [...new Set(withheld.map((c) => c.shape))],
      sentences: withheld.map((c) => c.sentence),
      ...(audit.wakeId ? { wakeId: audit.wakeId } : {}),
      ...(audit.sessionId ? { sessionId: audit.sessionId } : {}),
      ...(audit.turnId ? { turnId: audit.turnId } : {}),
    },
  }).catch(() => undefined);
}

export function guardMemoryClaims(text: string, audit: ReplyAudit | undefined): MemoryClaimGuardResult {
  return applyMemoryClaimGuard(text, factStoredThisTurn(audit?.turnId));
}
