import { fetchChannelDisplayName } from "../channels/slack-events.js";

function parseScopeKey(scopeKey: string): { platform: string; workspace: string; surface?: string } | null {
  const parts = scopeKey.split("/");
  if (parts.length < 2 || parts.length > 3 || parts.some((p) => p.length === 0)) return null;
  return { platform: parts[0], workspace: parts[1], surface: parts[2] };
}

const discordNameCache = new Map<string, Promise<string | undefined>>();
function fetchDiscordName(kind: "channels" | "guilds", id: string): Promise<string | undefined> {
  const key = `${kind}:${id}`;
  let p = discordNameCache.get(key);
  if (!p) {
    p = (async () => {
      const token = process.env.DISCORD_BOT_TOKEN;
      if (!token) return undefined;
      try {
        const res = await fetch(`https://discord.com/api/v10/${kind}/${id}`, {
          headers: { authorization: `Bot ${token}` },
        });
        if (!res.ok) return undefined;
        const body = (await res.json()) as { name?: unknown };
        return typeof body.name === "string" && body.name.trim() ? body.name.trim() : undefined;
      } catch {
        return undefined;
      }
    })();
    discordNameCache.set(key, p);
  }
  return p;
}

export async function friendlyScopeLabel(scopeKey: string): Promise<string | undefined> {
  try {
    const parsed = parseScopeKey(scopeKey);
    if (!parsed) return undefined;
    if (parsed.platform === "discord") {
      if (parsed.surface) {
        const name = await fetchDiscordName("channels", parsed.surface);
        return name ? `#${name}` : undefined;
      }
      const name = await fetchDiscordName("guilds", parsed.workspace);
      return name ? `the ${name} server` : undefined;
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
