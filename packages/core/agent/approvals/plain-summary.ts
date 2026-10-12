import type { PendingActionRow } from "./types.js";
import { actionKind } from "./actions.js";
import { CONSEQUENCE_MAX, QUOTE_MAX, finishPlainLine, finishPlainSentence } from "./plain-text.js";

export { CONSEQUENCE_MAX };

const UNDESCRIBED_ACTION_SENTENCE = "The agent asks for an action this card cannot describe — ask it what it will do before you decide.";

export function plainSummaryForRow(row: Pick<PendingActionRow, "kind" | "argsJson">): string {
  const kindDef = actionKind(row.kind);
  if (kindDef) {
    try {
      return finishPlainSentence(kindDef.plainSummary(JSON.parse(row.argsJson)));
    } catch {
    }
  }
  return UNDESCRIBED_ACTION_SENTENCE;
}

export function plainSummaryForArgs(kind: string, args: unknown): string {
  const kindDef = actionKind(kind);
  if (kindDef) {
    try {
      return finishPlainSentence(kindDef.plainSummary(args));
    } catch {
    }
  }
  return UNDESCRIBED_ACTION_SENTENCE;
}

export function doneSummaryForRow(row: Pick<PendingActionRow, "kind" | "argsJson">): string | undefined {
  const kindDef = actionKind(row.kind);
  if (kindDef?.doneSummary === undefined) return undefined;
  try {
    return finishPlainLine(kindDef.doneSummary(JSON.parse(row.argsJson)), CONSEQUENCE_MAX).replace(/[.!?]$/u, "");
  } catch {
    return undefined;
  }
}

export function consequenceForRow(row: Pick<PendingActionRow, "kind" | "argsJson">): string | undefined {
  const kindDef = actionKind(row.kind);
  if (kindDef?.consequence === undefined) return undefined;
  try {
    const line = kindDef.consequence(JSON.parse(row.argsJson));
    if (line === undefined || line.trim().length === 0) return undefined;
    return finishPlainLine(line, kindDef.consequenceQuotes === true ? QUOTE_MAX : CONSEQUENCE_MAX);
  } catch {
    return undefined;
  }
}
