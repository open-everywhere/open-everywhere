import type { ConfigPrFeedback } from "../../credentials/config-pr.js";

export interface Correction {
  readonly author: string;
  readonly kind: "review" | "comment";
  readonly text: string;
  readonly state?: string;
}

export type CorrectionRefusal = "empty" | "machine-author" | "no-standing";

const CORRECTION_STANDING = ["OWNER", "MEMBER", "COLLABORATOR"] as const;

const MAX_CORRECTION_CHARS = 600;

export const MAX_CORRECTIONS = 8;

const MAX_CORRECTION_AUTHOR_CHARS = 64;
const MAX_CORRECTION_STATE_CHARS = 32;

export function defangForProposal(body: string, maxChars: number = MAX_CORRECTION_CHARS): string {
  const stripped = body
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u2028\u2029]/g, " ")
    .replace(/^([ \t]*)(```|~~~)/gm, "$1'''")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return stripped.length > maxChars ? `${stripped.slice(0, maxChars)}… [clipped]` : stripped;
}

export function defangProposalField(value: string, maxChars: number): string {
  return defangForProposal(value.replace(/\s+/g, " "), maxChars);
}

export function correctionRefusal(raw: ConfigPrFeedback): CorrectionRefusal | null {
  if (raw.body.trim().length === 0) return "empty";
  if (raw.bot === true || /\[bot\]$/.test(raw.author)) return "machine-author";
  const association = (raw.authorAssociation ?? "").toUpperCase();
  if (!(CORRECTION_STANDING as readonly string[]).includes(association)) return "no-standing";
  return null;
}

export interface CorrectionHarvest {
  readonly corrections: readonly Correction[];
  readonly refused: number;
}

export function newestFirst(feedback: readonly ConfigPrFeedback[]): readonly ConfigPrFeedback[] {
  return feedback
    .map((raw, i) => ({ raw, i }))
    .sort((a, b) => {
      const at = a.raw.at ?? "";
      const bt = b.raw.at ?? "";
      if (at && bt && at !== bt) return at < bt ? 1 : -1;
      return b.i - a.i;
    })
    .map((e) => e.raw);
}

export function harvestCorrections(feedback: readonly ConfigPrFeedback[], max: number = MAX_CORRECTIONS): CorrectionHarvest {
  const corrections: Correction[] = [];
  let refused = 0;
  for (const raw of newestFirst(feedback)) {
    const refusal = correctionRefusal(raw);
    if (refusal === "empty") continue;
    if (refusal !== null) {
      refused += 1;
      continue;
    }
    if (corrections.length >= max) continue;
    corrections.push({
      author: raw.author,
      kind: raw.kind,
      text: defangForProposal(raw.body),
      ...(raw.state !== undefined ? { state: raw.state } : {}),
    });
  }
  return { corrections, refused };
}

export const CORRECTIONS_HEADING = "Corrections carried forward";

export function renderCorrections(corrections: readonly Correction[]): string {
  if (corrections.length === 0) return "";
  const lines = [`## ${CORRECTIONS_HEADING}`, "", "People said this about an earlier proposal of this workflow. Fold it in, and delete this section, before merging:", ""];
  for (const c of corrections) {
    const state = c.state ? defangProposalField(c.state, MAX_CORRECTION_STATE_CHARS) : "";
    const where = c.kind === "review" ? `review${state ? ` (${state})` : ""}` : "comment";
    lines.push(`- **@${defangProposalField(c.author, MAX_CORRECTION_AUTHOR_CHARS)}** (${where}): ${c.text.replace(/\n/g, "\n  ")}`);
  }
  return lines.join("\n");
}
