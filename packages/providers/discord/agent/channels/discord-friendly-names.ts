import type { FriendlyNameResolver } from "@open-everywhere/core/agent/adapter-api.js";
import { fetchDiscordInfo, type DiscordChannelInfo } from "./discord-channel-info.js";

export type DiscordInfoLookup = (kind: "channels" | "guilds" | "users", id: string) => Promise<DiscordChannelInfo | undefined>;

export function discordFriendlyNameResolver(lookup: DiscordInfoLookup = (kind, id) => fetchDiscordInfo(kind, id)): FriendlyNameResolver {
  return async (id) => {
    if (!/^\d{17,20}$/.test(id)) return undefined;
    const channel = await lookup("channels", id);
    if (channel?.name) return { label: `#${channel.name}`, kind: "channel" };
    const guild = await lookup("guilds", id);
    if (guild?.name) return { label: guild.name, kind: "server" };
    const user = await lookup("users", id);
    if (user?.name) return { label: user.name, kind: "person" };
    return undefined;
  };
}
