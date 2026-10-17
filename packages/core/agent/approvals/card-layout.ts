import type { PendingActionRow } from "./types.js";
import { actionKind } from "./actions.js";
import { grantButtonLabel, pendingCardExpiryClause, sessionGrantKind } from "./session-grant.js";
import { getSettings } from "../settings/settings.js";
import { consequenceForRow, doneSummaryForRow, plainSummaryForRow } from "./plain-summary.js";
import { taintCardWarning } from "./taint-disclosure.js";
import { finishPlainLine } from "./plain-text.js";
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

export interface CardMeta {
  readonly kind: string;
  readonly id: string;
  readonly detail: readonly string[];
}

export const APPROVAL_CARD_METADATA_TYPE = "oe_approval_card";

export const APPROVAL_CARD_BLOCK_PREFIX = "oe_approval_card:";

export function approvalCardBlockId(row: Pick<PendingActionRow, "kind" | "id">): string {
  return `${APPROVAL_CARD_BLOCK_PREFIX}${row.kind}:${row.id}`;
}

export const CARD_METADATA_DETAIL_MAX = 3000;

export function cappedDetail(detail: readonly string[]): string[] {
  const out: string[] = [];
  let used = 0;
  for (const line of detail) {
    if (used + line.length > CARD_METADATA_DETAIL_MAX) {
      const room = Math.max(0, CARD_METADATA_DETAIL_MAX - used);
      if (room > 0) out.push(line.slice(0, room));
      out.push("(detail cut — the full text is on the pending row)");
      return out;
    }
    out.push(line);
    used += line.length;
  }
  return out;
}

export function approvalCardMetadata(meta: CardMeta, status: string): { readonly event_type: string; readonly event_payload: Record<string, unknown> } {
  return { event_type: APPROVAL_CARD_METADATA_TYPE, event_payload: { kind: meta.kind, id: meta.id, status, detail: cappedDetail(meta.detail) } };
}

export interface PendingCardLayout {
  readonly headline: string;
  readonly consequence?: string;
  readonly warning?: string;
  readonly requestedBy: string;
  readonly expiry: string;
  readonly options: readonly CardOption[];
  readonly meta: CardMeta;
}

const KNOWN_PLATFORMS: ReadonlySet<string> = new Set(["slack", "discord", "teams", "google-chat", "github", "linear", "notion", "email"]);

export function footerRequester(row: Pick<PendingActionRow, "requestedBy" | "scopeKey">, surface: string): string {
  const platform = row.scopeKey.split("/")[0] ?? "";
  if (KNOWN_PLATFORMS.has(platform) && platform !== surface) return "someone";
  return /^[\w-]+$/u.test(row.requestedBy) ? `<@${row.requestedBy}>` : "someone";
}

export function cardFooter(requester: string, expiry: string): string {
  return `Asked by ${requester} · ${expiry}`;
}

export function pendingCardLines(layout: PendingCardLayout): string[] {
  return [layout.headline, ...(layout.consequence !== undefined ? [layout.consequence] : []), ...(layout.warning !== undefined ? [layout.warning] : [])];
}

function bareHeadline(row: Pick<PendingActionRow, "kind" | "argsJson">): string {
  return plainSummaryForRow(row).replace(/[.!?]$/u, "");
}

export const FAILED_OUTCOME_PREFIX = "FAILED:";
const FAILED_PREFIX = FAILED_OUTCOME_PREFIX;

function plainOutcome(outcomeLine: string): string {
  return outcomeLine.startsWith(FAILED_PREFIX) ? "it failed" : finishPlainLine(outcomeLine, DECIDED_OUTCOME_MAX);
}

const DECLINE_NOT_SAVED = "I could not save the decline";

const DECIDED_OUTCOME_MAX = 200;

export function decidedCardLine(row: Pick<PendingActionRow, "kind" | "argsJson" | "status">, outcomeLine: string | undefined, who: string): string {
  if (row.status === "approved") {
    if (outcomeLine?.startsWith(FAILED_PREFIX) === true) return `⚠️ Approved by ${who}, but it failed: ${bareHeadline(row)}`;
    return `✅ Approved by ${who}: ${outcomeLine === undefined ? bareHeadline(row) : plainOutcome(outcomeLine)}`;
  }
  if (row.status === "rejected") {
    if (outcomeLine?.startsWith(FAILED_PREFIX) === true) return `❌ Rejected by ${who}: ${bareHeadline(row)} · ${DECLINE_NOT_SAVED}`;
    const declined = outcomeLine === undefined || outcomeLine === "rejected" ? "" : ` · ${plainOutcome(outcomeLine)}`;
    return `❌ Rejected by ${who}: ${bareHeadline(row)}${declined}`;
  }
  return `⏰ Expired: ${bareHeadline(row)}`;
}

export const CLICK_NOTICE = {
  unknown: "I can't find this request any more. It may already be decided.",
  unknownItem: "I can't find that item any more. The other items on this card are unchanged.",
  notPending: "Nothing changed: this request was already decided.",
  unregistered: "Nothing changed: I can't run this kind of request any more.",
  denied: "Only an admin can decide this request. It is still open.",
  deniedDiscord: "Only an admin, or a server administrator for this server's own requests, can decide this. It is still open.",
  noClicker: "Nothing changed: I couldn't tell who clicked.",
  noPlace: "Nothing changed: I couldn't tell where this was clicked.",
  failed: "Nothing changed: something went wrong. Try again in a moment.",
} as const;

export function judgeLiftHeadline(row: Pick<PendingActionRow, "kind" | "argsJson">): string {
  return `Ran without asking: ${doneSummaryForRow(row) ?? bareHeadline(row)}`;
}

export function judgeLiftLines(row: Pick<PendingActionRow, "kind" | "argsJson">, outcomeLine: string): string[] {
  const consequence = consequenceForRow(row);
  return [judgeLiftHeadline(row), ...(consequence !== undefined ? [finishPlainLine(consequence, JUDGE_LIFT_CONSEQUENCE_MAX)] : []), judgeLiftOutcome(outcomeLine)];
}

const JUDGE_LIFT_CONSEQUENCE_MAX = 120;

export function judgeLiftOutcome(outcomeLine: string): string {
  return `⚡ Auto-approved and already run · ${outcomeLine.startsWith(FAILED_PREFIX) ? "it failed" : finishPlainLine(outcomeLine, JUDGE_LIFT_OUTCOME_MAX)}`;
}

const JUDGE_LIFT_OUTCOME_MAX = 200;

export const JUDGE_LIFT_BUTTON = "This should not have run";

export function pendingCardOptions(row: PendingActionRow): readonly CardOption[] {
  const labels = optionLabelsForRow(row);
  const options: CardOption[] = [{ verb: "approve", label: labels.approve, tone: "primary" }];
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
  options.push({ verb: "reject", label: labels.reject, tone: "danger" });
  return options;
}

function optionLabelsForRow(row: Pick<PendingActionRow, "kind" | "argsJson">): { readonly approve: string; readonly reject: string } {
  const fallback = { approve: "Approve", reject: "Reject" };
  const kindDef = actionKind(row.kind);
  if (kindDef?.optionLabels === undefined) return fallback;
  try {
    const labels = kindDef.optionLabels(JSON.parse(row.argsJson));
    return {
      approve: labels.approve.trim().length > 0 ? labels.approve : fallback.approve,
      reject: labels.reject.trim().length > 0 ? labels.reject : fallback.reject,
    };
  } catch {
    return fallback;
  }
}

function parseArgs(argsJson: string): unknown {
  try {
    return JSON.parse(argsJson);
  } catch {
    return undefined;
  }
}

export function pendingCardLayout(row: PendingActionRow, summaryLines: readonly string[]): PendingCardLayout {
  const consequence = consequenceForRow(row);
  const warning = taintCardWarning(summaryLines, parseArgs(row.argsJson));
  return {
    headline: plainSummaryForRow(row),
    ...(consequence !== undefined ? { consequence } : {}),
    ...(warning !== undefined ? { warning } : {}),
    requestedBy: row.requestedBy,
    expiry: pendingCardExpiryClause(row.expiresAt),
    options: pendingCardOptions(row),
    meta: { kind: row.kind, id: row.id, detail: [...summaryLines] },
  };
}
