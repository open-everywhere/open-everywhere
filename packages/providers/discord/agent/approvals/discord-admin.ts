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

const roleEvidenceCache = new Map<string, { roles: readonly string[]; at: number }>();

export async function discordAuthorRoles(guildId: string, userId: string, deps: DiscordAdminDeps = {}): Promise<readonly string[] | undefined> {
  const token = deps.token ?? process.env.DISCORD_BOT_TOKEN;
  if (!token || !guildId || !userId) return undefined;
  const cacheKey = `${guildId}:${userId}`;
  const now = deps.nowMs ?? Date.now();
  const hit = roleEvidenceCache.get(cacheKey);
  if (hit && now - hit.at < VERDICT_TTL_MS) return hit.roles;

  const doFetch = deps.fetchFn ?? fetch;
  try {
    const res = await doFetch(`https://discord.com/api/v10/guilds/${guildId}/members/${userId}`, { headers: { authorization: `Bot ${token}` } });
    if (res.status === 404) {
      roleEvidenceCache.set(cacheKey, { roles: [], at: now });
      return [];
    }
    if (!res.ok) {
      log(`role lookup failed (${res.status}) for guild ${guildId} — skipping the register query (cannot check is not checked-and-empty)`);
      return undefined;
    }
    const member = (await res.json()) as unknown;
    const rolesField = isObject(member) ? member["roles"] : undefined;
    if (!Array.isArray(rolesField)) return undefined;
    const roles = rolesField.filter((r): r is string => typeof r === "string" && r.length > 0);
    roleEvidenceCache.set(cacheKey, { roles, at: now });
    return roles;
  } catch (err) {
    log(`role lookup error for guild ${guildId}: ${(err as Error)?.message ?? String(err)}`);
    return undefined;
  }
}

export function _resetDiscordAuthorRolesCache(): void {
  roleEvidenceCache.clear();
}

const VIEW_CHANNEL = 1n << 10n;
const ADMINISTRATOR = 1n << 3n;
const PUBLIC_THREAD_TYPES: ReadonlySet<number> = new Set([10, 11]);
const PRIVATE_THREAD_TYPE = 12;

export interface DiscordOverwrite {
  readonly id: string;
  readonly type: number;
  readonly allow: string;
  readonly deny: string;
}

export interface DiscordViewFacts {
  readonly guildId: string;
  readonly ownerId?: string;
  readonly rolePermissions: ReadonlyMap<string, string>;
  readonly userId: string;
  readonly memberRoleIds: readonly string[];
  readonly overwrites: readonly DiscordOverwrite[];
}

function permissionBits(v: string | undefined): bigint {
  return v !== undefined && /^\d+$/.test(v) ? BigInt(v) : 0n;
}

export function discordCanView(f: DiscordViewFacts): boolean {
  if (f.ownerId !== undefined && f.ownerId === f.userId) return true;
  let base = permissionBits(f.rolePermissions.get(f.guildId));
  for (const r of f.memberRoleIds) base |= permissionBits(f.rolePermissions.get(r));
  if ((base & ADMINISTRATOR) !== 0n) return true;
  const everyone = f.overwrites.find((o) => o.type === 0 && o.id === f.guildId);
  if (everyone) base = (base & ~permissionBits(everyone.deny)) | permissionBits(everyone.allow);
  let allow = 0n;
  let deny = 0n;
  for (const o of f.overwrites) {
    if (o.type === 0 && o.id !== f.guildId && f.memberRoleIds.includes(o.id)) {
      allow |= permissionBits(o.allow);
      deny |= permissionBits(o.deny);
    }
  }
  base = (base & ~deny) | allow;
  const own = f.overwrites.find((o) => o.type === 1 && o.id === f.userId);
  if (own) base = (base & ~permissionBits(own.deny)) | permissionBits(own.allow);
  return (base & VIEW_CHANNEL) !== 0n;
}

function overwritesOf(channel: Record<string, unknown>): DiscordOverwrite[] {
  const raw = Array.isArray(channel["permission_overwrites"]) ? (channel["permission_overwrites"] as unknown[]) : [];
  return raw.flatMap((o) =>
    isObject(o) && typeof o["id"] === "string" && typeof o["type"] === "number"
      ? [{ id: o["id"], type: o["type"], allow: String(o["allow"] ?? "0"), deny: String(o["deny"] ?? "0") }]
      : [],
  );
}

export async function discordMemberCanViewChannel(guildId: string, channelId: string, userId: string, deps: DiscordAdminDeps = {}): Promise<boolean> {
  const token = deps.token ?? process.env.DISCORD_BOT_TOKEN;
  if (!token || !guildId || !channelId || !userId) return false;
  const doFetch = deps.fetchFn ?? fetch;
  const headers = { authorization: `Bot ${token}` };
  const read = async (path: string): Promise<Record<string, unknown> | undefined> => {
    const res = await doFetch(`https://discord.com/api/v10/${path}`, { headers });
    if (!res.ok) return undefined;
    const body = (await res.json()) as unknown;
    return isObject(body) ? body : undefined;
  };
  try {
    let channel = await read(`channels/${encodeURIComponent(channelId)}`);
    if (!channel || channel["guild_id"] !== guildId || channel["type"] === PRIVATE_THREAD_TYPE) return false;
    if (typeof channel["type"] === "number" && PUBLIC_THREAD_TYPES.has(channel["type"])) {
      const parentId = channel["parent_id"];
      channel = typeof parentId === "string" ? await read(`channels/${encodeURIComponent(parentId)}`) : undefined;
      if (!channel || channel["guild_id"] !== guildId) return false;
    }
    const guild = await read(`guilds/${encodeURIComponent(guildId)}`);
    if (!guild) return false;
    const member = await read(`guilds/${encodeURIComponent(guildId)}/members/${encodeURIComponent(userId)}`);
    const user = member?.["user"];
    if (!member || !isObject(user) || user["id"] !== userId || user["bot"] === true) return false;
    const rolePermissions = new Map<string, string>();
    for (const r of Array.isArray(guild["roles"]) ? (guild["roles"] as unknown[]) : []) {
      if (isObject(r) && typeof r["id"] === "string") rolePermissions.set(r["id"], String(r["permissions"] ?? "0"));
    }
    return discordCanView({
      guildId,
      ...(typeof guild["owner_id"] === "string" ? { ownerId: guild["owner_id"] } : {}),
      rolePermissions,
      userId,
      memberRoleIds: Array.isArray(member["roles"]) ? (member["roles"] as unknown[]).filter((r): r is string => typeof r === "string") : [],
      overwrites: overwritesOf(channel),
    });
  } catch (err) {
    log(`view check error for guild ${guildId}: ${(err as Error)?.message ?? String(err)}`);
    return false;
  }
}
