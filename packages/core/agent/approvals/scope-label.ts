import { fetchChannelDisplayName } from "../channels/slack-events.js";
import { fetchDiscordInfo } from "../channels/discord-channel-info.js";

function parseScopeKey(scopeKey: string): { platform: string; workspace: string; surface?: string } | null {
  const parts = scopeKey.split("/");
  if (parts.length < 2 || parts.length > 3 || parts.some((p) => p.length === 0)) return null;
  return { platform: parts[0], workspace: parts[1], surface: parts[2] };
}

export async function friendlyScopeLabel(scopeKey: string): Promise<string | undefined> {
  try {
    const parsed = parseScopeKey(scopeKey);
    if (!parsed) return undefined;
    if (parsed.platform === "discord") {
      if (parsed.surface) {
        const info = await fetchDiscordInfo("channels", parsed.surface);
        if (!info) return undefined;
        if (info.parentId) {
          const parent = await fetchDiscordInfo("channels", info.parentId);
          if (parent?.name) return `#${parent.name} · thread "${info.name}"`;
        }
        return info.isThread ? `thread "${info.name}"` : `#${info.name}`;
      }
      const info = await fetchDiscordInfo("guilds", parsed.workspace);
      return info?.name ? `the ${info.name} server` : undefined;
    }
    if (parsed.platform === "slack" && parsed.surface) {
      const name = await fetchChannelDisplayName(parsed.surface);
      return name ? `#${name}` : undefined;
    }
    return undefined;
  } catch {
    return undefined;
  }
}
