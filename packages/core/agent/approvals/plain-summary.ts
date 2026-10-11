import type { PendingActionRow } from "./types.js";
import { actionKind } from "./actions.js";
import { finishPlainSentence, plainValue } from "./plain-text.js";

export function plainSummaryForRow(row: Pick<PendingActionRow, "kind" | "argsJson">): string {
  const kindDef = actionKind(row.kind);
  if (kindDef) {
    try {
      return finishPlainSentence(kindDef.plainSummary(JSON.parse(row.argsJson)));
    } catch {
    }
  }
  return finishPlainSentence(`The agent asks to run ${plainValue(row.kind)} — read the detail below before you decide`);
}

export function plainSummaryForArgs(kind: string, args: unknown): string {
  const kindDef = actionKind(kind);
  if (kindDef) {
    try {
      return finishPlainSentence(kindDef.plainSummary(args));
    } catch {
    }
  }
  return finishPlainSentence(`The agent asks to run ${plainValue(kind)} — read the detail below before you decide`);
}
