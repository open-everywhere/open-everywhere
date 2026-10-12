import type { CardOptionTone, PendingActionRow } from "@open-everywhere/core/agent/adapter-api.js";
import {
  cardFooter,
  decidedCardLine,
  footerRequester,
  JUDGE_LIFT_BUTTON,
  judgeLiftLines,
  optionsWithoutConfirm,
  pendingCardLayout,
  pendingCardLines,
} from "@open-everywhere/core/agent/adapter-api.js";

export const OE_DISCORD_APPROVAL_PREFIX = "oe-approval:";

export const DISCORD_CUSTOM_ID_MAX = 100;

const COMPONENT_ACTION_ROW = 1;
const COMPONENT_BUTTON = 2;
const BUTTON_STYLE_SECONDARY = 2;
const BUTTON_STYLE_SUCCESS = 3;
const BUTTON_STYLE_DANGER = 4;

export interface DiscordComponent {
  readonly type: number;
  readonly [key: string]: unknown;
}

export interface DiscordCardMessage {
  readonly content: string;
  readonly components: readonly DiscordComponent[];
}

export type DiscordApprovalDecision = "approve" | "reject" | "approve_session" | "contradict";

const DISCORD_APPROVAL_DECISIONS: readonly DiscordApprovalDecision[] = ["approve", "reject", "approve_session", "contradict"];

export function buildDiscordApprovalCustomId(row: PendingActionRow, decision: DiscordApprovalDecision): string {
  const customId = `${OE_DISCORD_APPROVAL_PREFIX}${row.id}:${decision}:${row.org}`;
  if (customId.length > DISCORD_CUSTOM_ID_MAX) {
    throw new Error(
      `approval custom_id would be ${customId.length} chars (Discord caps at ${DISCORD_CUSTOM_ID_MAX}) — org "${row.org}" is too long to ride a Discord button`,
    );
  }
  return customId;
}

export function parseDiscordApprovalCustomId(customId: string): { id: string; decision: DiscordApprovalDecision; org: string } | null {
  if (!customId.startsWith(OE_DISCORD_APPROVAL_PREFIX)) return null;
  const rest = customId.slice(OE_DISCORD_APPROVAL_PREFIX.length);
  const first = rest.indexOf(":");
  if (first <= 0) return null;
  const second = rest.indexOf(":", first + 1);
  if (second < 0) return null;
  const id = rest.slice(0, first);
  const decision = rest.slice(first + 1, second);
  const org = rest.slice(second + 1);
  if (!DISCORD_APPROVAL_DECISIONS.includes(decision as DiscordApprovalDecision) || org.length === 0) return null;
  return { id, decision: decision as DiscordApprovalDecision, org };
}

const OPTION_STYLE: Record<CardOptionTone, number> = { primary: BUTTON_STYLE_SUCCESS, danger: BUTTON_STYLE_DANGER, neutral: BUTTON_STYLE_SECONDARY };

export function pendingDiscordCard(row: PendingActionRow, summaryLines: readonly string[]): DiscordCardMessage {
  const layout = pendingCardLayout(row, summaryLines);
  const [headline, ...rest] = pendingCardLines(layout);
  const content = [`**${headline}**`, ...rest, `-# ${cardFooter(footerRequester(row, "discord"), layout.expiry)}`].join("\n");
  const buttons: DiscordComponent[] = optionsWithoutConfirm(layout.options).map((o) => ({
    type: COMPONENT_BUTTON,
    style: OPTION_STYLE[o.tone],
    label: o.label,
    custom_id: buildDiscordApprovalCustomId(row, o.verb),
  }));
  return { content, components: [{ type: COMPONENT_ACTION_ROW, components: buttons }] };
}

export function judgeLiftNoticeDiscordCard(row: PendingActionRow, _summaryLines: readonly string[], outcomeLine: string): DiscordCardMessage {
  return {
    content: judgeLiftLines(row, outcomeLine)
      .map((line, i, all) => (i === 0 ? `**${line}**` : i === all.length - 1 ? `-# ${line}` : line))
      .join("\n"),
    components: [
      {
        type: COMPONENT_ACTION_ROW,
        components: [
          {
            type: COMPONENT_BUTTON,
            style: BUTTON_STYLE_DANGER,
            label: JUDGE_LIFT_BUTTON,
            custom_id: buildDiscordApprovalCustomId(row, "contradict"),
          },
        ],
      },
    ],
  };
}

export function decidedDiscordCard(row: PendingActionRow, _summaryLines: readonly string[], outcomeLine: string): DiscordCardMessage {
  return { content: decidedCardLine(row, outcomeLine, `<@${row.decidedBy}>`), components: [] };
}

const ADMINISTRATOR_BIT = 1n << 3n;

export function isGuildAdministrator(permissions: unknown): boolean {
  if (typeof permissions !== "string" || !/^\d+$/.test(permissions)) return false;
  try {
    return (BigInt(permissions) & ADMINISTRATOR_BIT) === ADMINISTRATOR_BIT;
  } catch {
    return false;
  }
}

export function scopeWithinGuild(scopeKey: string, guildId: string | undefined): boolean {
  if (!guildId) return false;
  return scopeKey === `discord/${guildId}` || scopeKey.startsWith(`discord/${guildId}/`);
}
