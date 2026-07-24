import type { SessionMode } from "../access/resolver.js";
import type { Visibility, Trust } from "../identity/binding.js";
import { rootDmGrainAttrs } from "./unified-window.js";

export interface OpenEverywhereDiscordAuth {
  readonly authenticator: string;
  readonly principalId: string;
  readonly principalType: string;
  readonly attributes: Record<string, string>;
}

export const DISCORD_CHANNEL_DM = "1";
export const DISCORD_CHANNEL_GROUP_DM = "3";

export interface DiscordIdentityInput {
  readonly userId: string;
  readonly guildId?: string;
  readonly channelId: string;
  readonly channelType?: string;
  readonly everyoneCanView?: boolean;
  readonly parentChannelId?: string;
  readonly memberPending?: boolean;
}

export function buildDiscordAuth(input: DiscordIdentityInput): OpenEverywhereDiscordAuth {
  const attributes: Record<string, string> = {
    channel_id: input.channelId,
    user_id: input.userId,
  };
  if (input.guildId) attributes.guild_id = input.guildId;
  if (input.channelType) attributes.channel_type = input.channelType;
  if (typeof input.everyoneCanView === "boolean") attributes.everyone_can_view = String(input.everyoneCanView);
  if (input.parentChannelId) attributes.parent_channel_id = input.parentChannelId;
  if (typeof input.memberPending === "boolean") attributes.member_pending = String(input.memberPending);
  const dmMode = discordMode(input.channelType, input.guildId);
  Object.assign(attributes, rootDmGrainAttrs(dmMode === "dm" || dmMode === "mpim"));
  return { authenticator: "discord", principalId: input.userId, principalType: "discord-user", attributes };
}

export function threadParentFromRawChannel(raw: Record<string, unknown>): string | undefined {
  const ch = raw["channel"];
  if (ch && typeof ch === "object") {
    const c = ch as Record<string, unknown>;
    const isThread = c["type"] === 10 || c["type"] === 11 || c["type"] === 12;
    const parent = c["parent_id"];
    if (isThread && typeof parent === "string" && parent.length > 0) return parent;
  }
  return undefined;
}

export function discordMode(channelType: string | undefined, guildId: string | undefined): SessionMode {
  if (channelType === DISCORD_CHANNEL_DM) return "dm";
  if (channelType === DISCORD_CHANNEL_GROUP_DM) return "mpim";
  if (guildId && guildId.length > 0) return "channel";
  return "dm";
}

export function discordVisibility(everyoneCanView: string | undefined, mode: SessionMode): Visibility {
  if (mode === "dm" || mode === "mpim") return "private";
  if (everyoneCanView === "true") return "public";
  return "private";
}

export function discordMemberPendingFromRaw(raw: Record<string, unknown>): boolean | undefined {
  const m = raw["member"];
  if (m && typeof m === "object") {
    const p = (m as Record<string, unknown>)["pending"];
    if (typeof p === "boolean") return p;
  }
  return undefined;
}

export function discordTrust(memberPending: string | undefined): Trust | undefined {
  if (memberPending === "true") return "external";
  return undefined;
}
