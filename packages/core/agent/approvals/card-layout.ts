import type { PendingActionRow } from "./types.js";
import { grantButtonLabel, pendingCardExpiryClause, sessionGrantKind } from "./session-grant.js";
import { getSettings } from "../settings/settings.js";
import { plainSummaryForRow } from "./plain-summary.js";
import { ALLOW_RULE_LABEL, ALLOW_RULE_VERB, allowRuleConfirmText, allowRuleProposalForRow } from "./allow-rule.js";

export type CardOptionVerb = "approve" | "approve_session" | "approve_rule" | "reject";

export type CardOptionTone = "primary" | "danger" | "neutral";

export interface CardOption {
  readonly verb: CardOptionVerb;
  readonly label: string;
  readonly tone: CardOptionTone;
  readonly confirm?: { readonly title: string; readonly text: string; readonly yes: string; readonly no: string };
}

export type UnconfirmedCardOption = CardOption & { readonly verb: Exclude<CardOptionVerb, "approve_rule">; readonly confirm?: undefined };

export function optionsWithoutConfirm(options: readonly CardOption[]): readonly UnconfirmedCardOption[] {
  return options.filter((o): o is UnconfirmedCardOption => o.confirm === undefined && o.verb !== "approve_rule");
}

export interface PendingCardLayout {
  readonly headline: string;
  readonly label: string;
  readonly detail: readonly string[];
  readonly requestedBy: string;
  readonly expiry: string;
  readonly options: readonly CardOption[];
}

export function approvalLabel(kind: string): string {
  return `Approval requested: ${kind}`;
}

export function pendingCardOptions(row: PendingActionRow): readonly CardOption[] {
  const options: CardOption[] = [{ verb: "approve", label: "Approve", tone: "primary" }];
  const grantLabel = sessionGrantKind(row) !== null ? grantButtonLabel(row, getSettings().approvals.routineGrantTtlHours) : undefined;
  if (grantLabel !== undefined) options.push({ verb: "approve_session", label: grantLabel, tone: "neutral" });
  const proposal = allowRuleProposalForRow(row);
  if (proposal !== undefined) {
    options.push({
      verb: ALLOW_RULE_VERB,
      label: ALLOW_RULE_LABEL,
      tone: "neutral",
      confirm: { title: "Allow things like this?", text: allowRuleConfirmText(proposal), yes: "Approve and allow", no: "Cancel" },
    });
  }
  options.push({ verb: "reject", label: "Reject", tone: "danger" });
  return options;
}

export function pendingCardLayout(row: PendingActionRow, summaryLines: readonly string[]): PendingCardLayout {
  return {
    headline: plainSummaryForRow(row),
    label: approvalLabel(row.kind),
    detail: summaryLines,
    requestedBy: row.requestedBy,
    expiry: pendingCardExpiryClause(row.expiresAt),
    options: pendingCardOptions(row),
  };
}
