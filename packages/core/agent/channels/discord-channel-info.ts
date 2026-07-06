export interface DiscordChannelInfo {
  readonly name?: string;
  readonly parentId?: string;
  readonly isThread: boolean;
}

export interface DiscordInfoDeps {
  readonly fetchFn?: typeof fetch;
  readonly token?: string;
}

const infoCache = new Map<string, Promise<DiscordChannelInfo | undefined>>();

export function clearDiscordInfoCacheForTest(): void {
  infoCache.clear();
}

export function fetchDiscordInfo(
  kind: "channels" | "guilds",
  id: string,
  deps: DiscordInfoDeps = {},
): Promise<DiscordChannelInfo | undefined> {
  const key = `${kind}:${id}`;
  let p = infoCache.get(key);
  if (!p) {
    p = (async () => {
      const token = deps.token ?? process.env.DISCORD_BOT_TOKEN;
      if (!token) return undefined;
      try {
        const doFetch = deps.fetchFn ?? fetch;
        const res = await doFetch(`https://discord.com/api/v10/${kind}/${id}`, {
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
    infoCache.set(key, p);
  }
  return p;
}

export async function threadParentChannelId(channelId: string, deps: DiscordInfoDeps = {}): Promise<string | undefined> {
  const info = await fetchDiscordInfo("channels", channelId, deps);
  return info?.parentId;
}
