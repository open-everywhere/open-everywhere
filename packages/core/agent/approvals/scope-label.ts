import { fetchChannelDisplayName } from "../channels/slack-events.js";

function parseScopeKey(scopeKey: string): { platform: string; workspace: string; surface?: string } | null {
  const parts = scopeKey.split("/");
  if (parts.length < 2 || parts.length > 3 || parts.some((p) => p.length === 0)) return null;
  return { platform: parts[0], workspace: parts[1], surface: parts[2] };
}

interface DiscordChannelInfo {
  readonly name?: string;
  readonly parentId?: string;
  readonly isThread: boolean;
}
const discordInfoCache = new Map<string, Promise<DiscordChannelInfo | undefined>>();
function fetchDiscordInfo(kind: "channels" | "guilds", id: string): Promise<DiscordChannelInfo | undefined> {
  const key = `${kind}:${id}`;
  let p = discordInfoCache.get(key);
  if (!p) {
    p = (async () => {
      const token = process.env.DISCORD_BOT_TOKEN;
      if (!token) return undefined;
      try {
        const res = await fetch(`https://discord.com/api/v10/${kind}/${id}`, {
          headers: { authorization: `Bot ${token}` },
        });
        if (!res.ok) return undefined;
        const body = (await res.json()) as { name?: unknown; parent_id?: unknown; type?: unknown };
        const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : undefined;
        const isThread = body.type === 10 || body.type === 11 || body.type === 12;
        const parentId = isThread && typeof body.parent_id === "string" && body.parent_id ? body.parent_id : undefined;
        return name ? { name, parentId, isThread } : undefined;
      } catch {
        return undefined;
      }
    })();
    discordInfoCache.set(key, p);
  }
  return p;
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
