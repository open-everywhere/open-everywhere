import type { CardOptionTone, PendingActionRow } from "@open-everywhere/core/agent/adapter-api.js";
import {
  decidedCardLine,
  JUDGE_LIFT_BUTTON,
  judgeLiftLines,
  optionsWithoutConfirm,
  pendingCardLayout,
  pendingCardLines,
} from "@open-everywhere/core/agent/adapter-api.js";

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

function cardBody(lines: readonly string[], footer: string | undefined): AdaptiveElement[] {
  const [headline, ...rest] = lines;
  return [
    textBlock(headline ?? "", { weight: "Bolder", size: "Medium" }),
    ...rest.map((line) => textBlock(line, { spacing: "Small" })),
    ...(footer !== undefined ? [textBlock(footer, { isSubtle: true, size: "Small" })] : []),
  ];
}

function capitalise(text: string): string {
  return text.length > 0 ? `${text[0]!.toUpperCase()}${text.slice(1)}` : text;
}

const OPTION_STYLE: Record<CardOptionTone, "positive" | "destructive" | undefined> = { primary: "positive", danger: "destructive", neutral: undefined };

export function pendingTeamsCard(row: PendingActionRow, summaryLines: readonly string[]): TeamsAdaptiveCard {
  const layout = pendingCardLayout(row, summaryLines);
  const actions = optionsWithoutConfirm(layout.options).map((o) => execute(row, o.label, o.verb, OPTION_STYLE[o.tone]));
  return card(cardBody(pendingCardLines(layout), capitalise(layout.expiry)), actions);
}

export function decidedTeamsCard(row: PendingActionRow, _summaryLines: readonly string[], outcomeLine: string, deciderLabel?: string): TeamsAdaptiveCard {
  const who = deciderLabel !== undefined && deciderLabel.trim().length > 0 ? deciderLabel : "someone";
  return card([textBlock(decidedCardLine(row, outcomeLine, who))]);
}

export function judgeLiftNoticeTeamsCard(row: PendingActionRow, _summaryLines: readonly string[], outcomeLine: string): TeamsAdaptiveCard {
  return card(cardBody(judgeLiftLines(row, outcomeLine), undefined), [execute(row, JUDGE_LIFT_BUTTON, "contradict", "destructive")]);
}

export function teamsCardAttachment(c: TeamsAdaptiveCard): { readonly contentType: string; readonly content: TeamsAdaptiveCard } {
  return { contentType: TEAMS_ADAPTIVE_CARD_CONTENT_TYPE, content: c };
}
