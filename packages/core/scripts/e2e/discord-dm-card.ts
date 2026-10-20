import type { AuditWireEntry } from "./audit-read.js";
import { completedConnectorWrites, CONNECTOR_CARD_KIND } from "./connector-card.js";

export const DISCORD_DM_CARD_ACTIONS = [
  "approval.requested",
  "approval.approved",
  "approval.rejected",
  "connector.op_approved",
  "approval.decision_wake",
  "connector.op",
] as const;

export const DISCORD_DM_CARD_LOOKBACK_MS = 24 * 60 * 60 * 1000;

export const DISCORD_DM_DOMAIN_PREFIX = "oe-dm/discord/";

function s(row: AuditWireEntry, key: string): string | undefined {
  const value = row.detail?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function ms(iso: string): number {
  const value = Date.parse(iso);
  return Number.isFinite(value) ? value : Number.NaN;
}

function bareId(principal: string | undefined): string | undefined {
  if (!principal) return undefined;
  return principal.includes("/") ? principal.slice(principal.lastIndexOf("/") + 1) : principal;
}

export function isDiscordDmCard(row: AuditWireEntry): boolean {
  if (row.action !== "approval.requested" || s(row, "kind") !== CONNECTOR_CARD_KIND) return false;
  const parts = (s(row, "scopeKey") ?? "").split("/");
  if (parts.length !== 3 || parts[0] !== "discord" || !parts[1] || !parts[2]) return false;
  return parts[1] === bareId(row.principalId);
}

export interface DiscordDmCard {
  readonly pendingId: string;
  readonly scopeKey: string;
  readonly channelId: string;
  readonly requester: string;
  readonly requestedAt: string;
}

export type DiscordDmCardVerdict =
  | { readonly kind: "no-card" }
  | { readonly kind: "undecided"; readonly card: DiscordDmCard }
  | { readonly kind: "rejected"; readonly card: DiscordDmCard }
  | {
      readonly kind: "approved";
      readonly card: DiscordDmCard;
      readonly approved: AuditWireEntry;
      readonly opApproved: AuditWireEntry | undefined;
      readonly decisionWakes: readonly AuditWireEntry[];
      readonly writesBeforeApproval: readonly AuditWireEntry[];
      readonly writeAfter: AuditWireEntry | undefined;
    };

export function discordDmCardVerdict(rows: readonly AuditWireEntry[]): DiscordDmCardVerdict {
  const cardRow = rows.filter(isDiscordDmCard).sort((a, b) => ms(b.ts) - ms(a.ts))[0];
  if (!cardRow) return { kind: "no-card" };
  const scopeKey = s(cardRow, "scopeKey")!;
  const card: DiscordDmCard = {
    pendingId: s(cardRow, "id") ?? "",
    scopeKey,
    channelId: scopeKey.split("/")[2]!,
    requester: cardRow.principalId ?? "",
    requestedAt: cardRow.ts,
  };
  const byId = (action: string) => rows.filter((row) => row.action === action && s(row, "id") === card.pendingId);
  if (byId("approval.rejected").length > 0) return { kind: "rejected", card };
  const approved = byId("approval.approved").sort((a, b) => ms(a.ts) - ms(b.ts))[0];
  if (!approved) return { kind: "undecided", card };
  const opApproved = rows.find(
    (row) =>
      row.action === "connector.op_approved" &&
      bareId(row.principalId) === bareId(approved.principalId) &&
      bareId(s(row, "requestedBy")) === bareId(card.requester) &&
      Math.abs(ms(row.ts) - ms(approved.ts)) <= 60_000,
  );
  const writes = completedConnectorWrites(rows, card.channelId);
  return {
    kind: "approved",
    card,
    approved,
    opApproved,
    decisionWakes: byId("approval.decision_wake"),
    writesBeforeApproval: writes.filter((row) => ms(row.ts) >= ms(card.requestedAt) && ms(row.ts) < ms(approved.ts)),
    writeAfter: writes.filter((row) => ms(row.ts) > ms(approved.ts)).sort((a, b) => ms(a.ts) - ms(b.ts))[0],
  };
}

export function dmSeatDecisionWake(row: AuditWireEntry, card: DiscordDmCard): boolean {
  const domain = s(row, "domain") ?? "";
  return (
    s(row, "outcome") === "approved" &&
    row.detail?.delivered === true &&
    s(row, "wakeId") !== undefined &&
    domain.startsWith(DISCORD_DM_DOMAIN_PREFIX) &&
    domain.endsWith(`/${card.channelId}`)
  );
}

export function discordDmCardSteps(token: string): string {
  return (
    `In your own Discord DM with the OE bot, send: create a new Notion page titled "OE discord-card ${token}" with a one-line body. ` +
    `When the OE approval card appears, tap Approve. Then rerun this leg within ${DISCORD_DM_CARD_LOOKBACK_MS / 3_600_000} hours. ` +
    `Your Discord account needs a consented personal Notion grant, or the write never reaches a card.`
  );
}
