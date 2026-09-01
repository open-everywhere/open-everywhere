import type { PendingActionRow } from "@open-everywhere/core/agent/adapter-api.js";
import { grantButtonLabel, sessionGrantKind } from "@open-everywhere/core/agent/adapter-api.js";

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

function cardBody(row: PendingActionRow, summaryLines: readonly string[], footer: string): string {
  return [`**Approval requested: ${row.kind}**`, ...summaryLines, footer].join("\n");
}

export function pendingDiscordCard(row: PendingActionRow, summaryLines: readonly string[]): DiscordCardMessage {
  const content = cardBody(row, summaryLines, `-# Requested by <@${row.requestedBy}> · expires ${row.expiresAt}`);
  const buttons: DiscordComponent[] = [
    {
      type: COMPONENT_BUTTON,
      style: BUTTON_STYLE_SUCCESS,
      label: "Approve",
      custom_id: buildDiscordApprovalCustomId(row, "approve"),
    },
  ];
  if (sessionGrantKind(row) !== null) {
    buttons.push({
      type: COMPONENT_BUTTON,
      style: BUTTON_STYLE_SECONDARY,
      label: grantButtonLabel(row),
      custom_id: buildDiscordApprovalCustomId(row, "approve_session"),
    });
  }
  buttons.push({
    type: COMPONENT_BUTTON,
    style: BUTTON_STYLE_DANGER,
    label: "Reject",
    custom_id: buildDiscordApprovalCustomId(row, "reject"),
  });
  return { content, components: [{ type: COMPONENT_ACTION_ROW, components: buttons }] };
}

export function judgeLiftNoticeDiscordCard(row: PendingActionRow, summaryLines: readonly string[], outcomeLine: string): DiscordCardMessage {
  const context = `-# ⚡ Auto-approved by the approval judge — no card was posted and this has already run · ${outcomeLine}`;
  return {
    content: [`**Ran without asking: ${row.kind}**`, ...summaryLines, context].join("\n"),
    components: [
      {
        type: COMPONENT_ACTION_ROW,
        components: [
          {
            type: COMPONENT_BUTTON,
            style: BUTTON_STYLE_DANGER,
            label: "This should not have run",
            custom_id: buildDiscordApprovalCustomId(row, "contradict"),
          },
        ],
      },
    ],
  };
}

export function decidedDiscordCard(row: PendingActionRow, summaryLines: readonly string[], outcomeLine: string): DiscordCardMessage {
  const decidedContext =
    row.status === "approved"
      ? `✅ Approved by <@${row.decidedBy}> · ${outcomeLine}`
      : row.status === "rejected"
        ?
          `❌ Rejected by <@${row.decidedBy}>${outcomeLine === "rejected" ? "" : ` · ${outcomeLine}`}`
        : "⏰ Expired";
  return { content: cardBody(row, summaryLines, decidedContext), components: [] };
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
