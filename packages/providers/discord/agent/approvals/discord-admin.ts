import { isGuildAdministrator } from "./discord-card.js";

function log(msg: string): void {
  console.log(`[open-everywhere:discord-admin] ${msg}`);
}

export function guildIdFromScopeKey(scopeKey: string): string | undefined {
  const parts = scopeKey.split("/");
  return parts[0] === "discord" && parts[1] ? parts[1] : undefined;
}

export interface DiscordAdminDeps {
  readonly fetchFn?: typeof fetch;
  readonly token?: string;
  readonly nowMs?: number;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

const verdictCache = new Map<string, { verdict: boolean; at: number }>();
const VERDICT_TTL_MS = 60_000;
const memberVerdictCache = new Map<string, { verdict: boolean; at: number }>();

export async function isGuildAdminViaRest(guildId: string, userId: string, deps: DiscordAdminDeps = {}): Promise<boolean> {
  const token = deps.token ?? process.env.DISCORD_BOT_TOKEN;
  if (!token || !guildId || !userId) return false;
  const cacheKey = `${guildId}:${userId}`;
  const now = deps.nowMs ?? Date.now();
  const hit = verdictCache.get(cacheKey);
  if (hit && now - hit.at < VERDICT_TTL_MS) return hit.verdict;

  const doFetch = deps.fetchFn ?? fetch;
  const headers = { authorization: `Bot ${token}` };
  const verdict = await (async () => {
    try {
      const guildRes = await doFetch(`https://discord.com/api/v10/guilds/${guildId}`, { headers });
      if (!guildRes.ok) {
        log(`guild lookup failed (${guildRes.status}) for guild ${guildId} — treating as not-admin`);
        return false;
      }
      const guild = (await guildRes.json()) as unknown;
      if (!isObject(guild)) return false;
      if (typeof guild["owner_id"] === "string" && guild["owner_id"] === userId) return true;
      const roleTable = Array.isArray(guild["roles"]) ? (guild["roles"] as unknown[]) : [];

      const memberRes = await doFetch(`https://discord.com/api/v10/guilds/${guildId}/members/${userId}`, { headers });
      if (!memberRes.ok) {
        if (memberRes.status !== 404) log(`member lookup failed (${memberRes.status}) for guild ${guildId} — treating as not-admin`);
        return false;
      }
      const member = (await memberRes.json()) as unknown;
      const memberRoleIds = new Set(
        isObject(member) && Array.isArray(member["roles"]) ? (member["roles"] as unknown[]).filter((r): r is string => typeof r === "string") : [],
      );
      return roleTable.some(
        (r) => isObject(r) && typeof r["id"] === "string" && memberRoleIds.has(r["id"]) && isGuildAdministrator(r["permissions"]),
      );
    } catch (err) {
      log(`admin check error for guild ${guildId}: ${(err as Error)?.message ?? String(err)}`);
      return false;
    }
  })();
  verdictCache.set(cacheKey, { verdict, at: now });
  return verdict;
}

export async function isGuildMemberViaRest(guildId: string, userId: string, deps: DiscordAdminDeps = {}): Promise<boolean> {
  const token = deps.token ?? process.env.DISCORD_BOT_TOKEN;
  if (!token || !guildId || !userId) return false;
  const cacheKey = `${guildId}:${userId}`;
  const now = deps.nowMs ?? Date.now();
  const hit = memberVerdictCache.get(cacheKey);
  if (hit && now - hit.at < VERDICT_TTL_MS) return hit.verdict;

  const doFetch = deps.fetchFn ?? fetch;
  const verdict = await (async () => {
    try {
      const res = await doFetch(`https://discord.com/api/v10/guilds/${guildId}/members/${userId}`, { headers: { authorization: `Bot ${token}` } });
      if (!res.ok) {
        if (res.status !== 404) log(`member lookup failed (${res.status}) for guild ${guildId} — treating as not-a-member`);
        return false;
      }
      const member = (await res.json()) as unknown;
      if (!isObject(member)) return false;
      const user = member["user"];
      if (isObject(user) && user["bot"] === true) return false;
      return isObject(user) && typeof user["id"] === "string" ? user["id"] === userId : false;
    } catch (err) {
      log(`member check error for guild ${guildId}: ${(err as Error)?.message ?? String(err)}`);
      return false;
    }
  })();
  memberVerdictCache.set(cacheKey, { verdict, at: now });
  return verdict;
}
