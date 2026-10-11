import type { CardOptionTone, PendingActionRow } from "@open-everywhere/core/agent/adapter-api.js";
import { approvalLabel, optionsWithoutConfirm, pendingCardLayout, plainSummaryForRow } from "@open-everywhere/core/agent/adapter-api.js";

export const TEAMS_ADAPTIVE_CARD_ACTION_INVOKE = "adaptiveCard/action";

export const OE_TEAMS_APPROVAL_VERB = "oe-approval";

export const OE_TEAMS_APPROVAL_DATA_KEY = "oe_teams_approval";

export const TEAMS_ADAPTIVE_CARD_CONTENT_TYPE = "application/vnd.microsoft.card.adaptive";

const ADAPTIVE_CARD_VERSION = "1.4";

export type TeamsApprovalDecision = "approve" | "reject" | "approve_session" | "contradict";

const TEAMS_APPROVAL_DECISIONS: readonly TeamsApprovalDecision[] = ["approve", "reject", "approve_session", "contradict"];

export interface TeamsApprovalAction {
  readonly id: string;
  readonly decision: TeamsApprovalDecision;
  readonly org: string;
}

export interface AdaptiveElement {
  readonly type: string;
  readonly [key: string]: unknown;
}

export interface TeamsAdaptiveCard {
  readonly type: "AdaptiveCard";
  readonly $schema: string;
  readonly version: string;
  readonly body: readonly AdaptiveElement[];
  readonly actions?: readonly AdaptiveElement[];
}

export function buildTeamsApprovalData(row: Pick<PendingActionRow, "id" | "org">, decision: TeamsApprovalDecision): Record<string, unknown> {
  return { [OE_TEAMS_APPROVAL_DATA_KEY]: { id: row.id, decision, org: row.org } };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function nonEmpty(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

export function parseTeamsApprovalData(data: unknown): TeamsApprovalAction | null {
  if (!isObject(data)) return null;
  const payload = data[OE_TEAMS_APPROVAL_DATA_KEY];
  if (!isObject(payload)) return null;
  const id = nonEmpty(payload["id"]);
  const org = nonEmpty(payload["org"]);
  const decision = payload["decision"];
  if (!id || !org || typeof decision !== "string") return null;
  if (!TEAMS_APPROVAL_DECISIONS.includes(decision as TeamsApprovalDecision)) return null;
  return { id, decision: decision as TeamsApprovalDecision, org };
}

function textBlock(text: string, extra: Record<string, unknown> = {}): AdaptiveElement {
  return { type: "TextBlock", text, wrap: true, ...extra };
}

function card(body: readonly AdaptiveElement[], actions?: readonly AdaptiveElement[]): TeamsAdaptiveCard {
  return {
    type: "AdaptiveCard",
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    version: ADAPTIVE_CARD_VERSION,
    body,
    ...(actions && actions.length > 0 ? { actions } : {}),
  };
}

function execute(row: Pick<PendingActionRow, "id" | "org">, title: string, decision: TeamsApprovalDecision, style?: "positive" | "destructive"): AdaptiveElement {
  return {
    type: "Action.Execute",
    title,
    verb: OE_TEAMS_APPROVAL_VERB,
    data: buildTeamsApprovalData(row, decision),
    ...(style ? { style } : {}),
  };
}

function cardBody(header: string, summaryLines: readonly string[], footer: string): AdaptiveElement[] {
  return [
    textBlock(header, { weight: "Bolder", size: "Medium" }),
    ...summaryLines.map((line) => textBlock(line)),
    textBlock(footer, { isSubtle: true, size: "Small" }),
  ];
}

function approvalCardBody(row: PendingActionRow, summaryLines: readonly string[], footer: string): AdaptiveElement[] {
  return [
    textBlock(plainSummaryForRow(row), { weight: "Bolder", size: "Medium" }),
    textBlock(approvalLabel(row.kind), { isSubtle: true, size: "Small", spacing: "None" }),
    ...summaryLines.map((line) => textBlock(line)),
    textBlock(footer, { isSubtle: true, size: "Small" }),
  ];
}

const OPTION_STYLE: Record<CardOptionTone, "positive" | "destructive" | undefined> = { primary: "positive", danger: "destructive", neutral: undefined };

export function pendingTeamsCard(row: PendingActionRow, summaryLines: readonly string[]): TeamsAdaptiveCard {
  const layout = pendingCardLayout(row, summaryLines);
  const actions = optionsWithoutConfirm(layout.options).map((o) => execute(row, o.label, o.verb, OPTION_STYLE[o.tone]));
  return card(approvalCardBody(row, summaryLines, `Requested by ${layout.requestedBy} · ${layout.expiry}`), actions);
}

export function decidedTeamsCard(row: PendingActionRow, summaryLines: readonly string[], outcomeLine: string, deciderLabel?: string): TeamsAdaptiveCard {
  const who = deciderLabel ?? row.decidedBy ?? "unknown";
  const decided =
    row.status === "approved"
      ? `✅ Approved by ${who} · ${outcomeLine}`
      : row.status === "rejected"
        ? `❌ Rejected by ${who}${outcomeLine === "rejected" ? "" : ` · ${outcomeLine}`}`
        : "⏰ Expired";
  return card(approvalCardBody(row, summaryLines, decided));
}

export function judgeLiftNoticeTeamsCard(row: PendingActionRow, summaryLines: readonly string[], outcomeLine: string): TeamsAdaptiveCard {
  return card(
    cardBody(
      `Ran without asking: ${row.kind}`,
      summaryLines,
      `⚡ Auto-approved by the approval judge — no card was posted and this has already run · ${outcomeLine}`,
    ),
    [execute(row, "This should not have run", "contradict", "destructive")],
  );
}

export function teamsCardAttachment(c: TeamsAdaptiveCard): { readonly contentType: string; readonly content: TeamsAdaptiveCard } {
  return { contentType: TEAMS_ADAPTIVE_CARD_CONTENT_TYPE, content: c };
}
