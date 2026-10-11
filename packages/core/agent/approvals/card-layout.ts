import type { PendingActionRow } from "./types.js";
import { grantButtonLabel, pendingCardExpiryClause, sessionGrantKind } from "./session-grant.js";
import { getSettings } from "../settings/settings.js";
import { plainSummaryForRow } from "./plain-summary.js";

export type CardOptionVerb = "approve" | "approve_session" | "reject";

export type CardOptionTone = "primary" | "danger" | "neutral";

export interface CardOption {
  readonly verb: CardOptionVerb;
  readonly label: string;
  readonly tone: CardOptionTone;
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
