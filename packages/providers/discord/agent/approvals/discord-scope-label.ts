import type { ScopeLabelResolver } from "@open-everywhere/core/agent/adapter-api.js";
import { fetchDiscordInfo } from "../channels/discord-channel-info.js";

export const discordScopeLabelResolver: ScopeLabelResolver = async ({ workspace, surface }) => {
  if (surface) {
    const info = await fetchDiscordInfo("channels", surface);
    if (!info) return undefined;
    if (info.parentId) {
      const parent = await fetchDiscordInfo("channels", info.parentId);
      if (parent?.name) return `#${parent.name} · thread "${info.name}"`;
    }
    return info.isThread ? `thread "${info.name}"` : `#${info.name}`;
  }
  const info = await fetchDiscordInfo("guilds", workspace);
  return info?.name ? `the ${info.name} server` : undefined;
};
