import type { SessionMode } from "../access/resolver.js";
import type { Visibility } from "../identity/binding.js";

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
}

export function buildDiscordAuth(input: DiscordIdentityInput): OpenEverywhereDiscordAuth {
  const attributes: Record<string, string> = {
    channel_id: input.channelId,
    user_id: input.userId,
  };
  if (input.guildId) attributes.guild_id = input.guildId;
  if (input.channelType) attributes.channel_type = input.channelType;
  if (typeof input.everyoneCanView === "boolean") attributes.everyone_can_view = String(input.everyoneCanView);
  return { authenticator: "discord", principalId: input.userId, principalType: "discord-user", attributes };
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
