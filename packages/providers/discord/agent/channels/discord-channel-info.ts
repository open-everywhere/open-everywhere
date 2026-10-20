import { discordBotToken } from "./discord-credentials.js";

export interface DiscordChannelInfo {
  readonly name?: string;
  readonly parentId?: string;
  readonly isThread: boolean;
  readonly guildId?: string;
  readonly handle?: string;
}

export interface DiscordInfoDeps {
  readonly fetchFn?: typeof fetch;
  readonly token?: string;
}

const infoCache = new Map<string, Promise<DiscordChannelInfo | undefined>>();
const INFO_CACHE_MAX = 2000;

export function clearDiscordInfoCacheForTest(): void {
  infoCache.clear();
}

export function fetchDiscordInfo(
  kind: "channels" | "guilds" | "users",
  id: string,
  deps: DiscordInfoDeps = {},
): Promise<DiscordChannelInfo | undefined> {
  const key = `${kind}:${id}`;
  let p = infoCache.get(key);
  if (!p) {
    let transient = false;
    p = (async () => {
      const token = deps.token ?? (await discordBotToken());
      if (!token) return undefined;
      try {
        const doFetch = deps.fetchFn ?? fetch;
        const res = await doFetch(`https://discord.com/api/v10/${kind}/${id}`, {
          headers: { authorization: `Bot ${token}` },
        });
        if (!res.ok) {
          transient = res.status === 429 || res.status >= 500;
          return undefined;
        }
        const body = (await res.json()) as { name?: unknown; parent_id?: unknown; type?: unknown; guild_id?: unknown; global_name?: unknown; username?: unknown };
        const pick = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
        const name = kind === "users" ? (pick(body.global_name) ?? pick(body.username)) : pick(body.name);
        const isThread = body.type === 10 || body.type === 11 || body.type === 12;
        const parentId = isThread && typeof body.parent_id === "string" && body.parent_id ? body.parent_id : undefined;
        const guildId = kind === "channels" && typeof body.guild_id === "string" && body.guild_id ? body.guild_id : undefined;
        const handle = kind === "users" ? pick(body.username) : undefined;
        return name ? { name, parentId, isThread, ...(guildId ? { guildId } : {}), ...(handle ? { handle } : {}) } : undefined;
      } catch {
        transient = true;
        return undefined;
      }
    })();
    const settled = p;
    void settled.then(() => {
      if (transient && infoCache.get(key) === settled) infoCache.delete(key);
    });
    infoCache.set(key, p);
    while (infoCache.size > INFO_CACHE_MAX) {
      const oldest = infoCache.keys().next().value;
      if (oldest === undefined) break;
      infoCache.delete(oldest);
    }
  }
  return p;
}

export async function threadParentChannelId(channelId: string, deps: DiscordInfoDeps = {}): Promise<string | undefined> {
  const info = await fetchDiscordInfo("channels", channelId, deps);
  return info?.parentId;
}
