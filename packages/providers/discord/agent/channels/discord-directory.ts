import { admittedTenantsFromConfig, type DirectoryCandidate } from "@open-everywhere/core/agent/adapter-api.js";

const API = "https://discord.com/api/v10";

const DISCORD_MEMBER_SEARCH_LIMIT = 25;

const DISCORD_DIRECTORY_MAX_GUILDS = 8;

const SNOWFLAKE = /^\d{17,20}$/u;

function log(msg: string): void {
  console.log(`[open-everywhere:discord-directory] ${msg}`);
}

interface DiscordGuildMember {
  nick?: unknown;
  user?: { id?: unknown; username?: unknown; global_name?: unknown; bot?: unknown };
}

export async function fetchGuildDirectory(query: string): Promise<readonly DirectoryCandidate[]> {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) return [];
  const q = query.trim().replace(/^@/u, "");
  if (q.length === 0) return [];

  const guilds = [...admittedTenantsFromConfig("discord")];
  if (guilds.length === 0) return [];
  if (guilds.length > DISCORD_DIRECTORY_MAX_GUILDS) {
    log(`this deployment declares ${guilds.length} guilds — searching the first ${DISCORD_DIRECTORY_MAX_GUILDS}; a wider search may not see every member.`);
  }

  const perGuild = await Promise.all(guilds.slice(0, DISCORD_DIRECTORY_MAX_GUILDS).map((guild) => guildMembersMatching(token, guild, q)));

  const byId = new Map<string, DirectoryCandidate>();
  for (const members of perGuild) {
    for (const member of members) {
      const candidate = candidateFromMember(member);
      if (candidate && !byId.has(candidate.nativeId)) byId.set(candidate.nativeId, candidate);
    }
  }
  return [...byId.values()];
}

async function guildMembersMatching(token: string, guildId: string, q: string): Promise<readonly DiscordGuildMember[]> {
  const out: DiscordGuildMember[] = [];
  const search = await guildRequest(token, `${API}/guilds/${encodeURIComponent(guildId)}/members/search?query=${encodeURIComponent(q)}&limit=${DISCORD_MEMBER_SEARCH_LIMIT}`, guildId, "member search");
  if (Array.isArray(search)) out.push(...(search as DiscordGuildMember[]));
  if (SNOWFLAKE.test(q)) {
    const one = await guildRequest(token, `${API}/guilds/${encodeURIComponent(guildId)}/members/${encodeURIComponent(q)}`, guildId, "member read");
    if (one && typeof one === "object" && !Array.isArray(one)) out.push(one as DiscordGuildMember);
  }
  return out;
}

async function guildRequest(token: string, url: string, guildId: string, what: string): Promise<unknown> {
  try {
    const res = await fetch(url, { headers: { authorization: `Bot ${token}` } });
    if (!res.ok) {
      if (res.status !== 404) {
        log(`${what} did not answer (${res.status}) for guild ${guildId} — the account directory is unavailable there; linking falls back to the code flow. A 403 usually means the SERVER MEMBERS INTENT is off for this app.`);
      }
      return undefined;
    }
    return (await res.json()) as unknown;
  } catch (err) {
    log(`${what} failed for guild ${guildId}: ${(err as Error)?.message ?? String(err)}`);
    return undefined;
  }
}

function candidateFromMember(member: DiscordGuildMember): DirectoryCandidate | undefined {
  const user = member?.user;
  if (!user || typeof user !== "object") return undefined;
  if (user.bot === true) return undefined;
  const nativeId = typeof user.id === "string" ? user.id.trim() : "";
  if (nativeId.length === 0) return undefined;
  const username = typeof user.username === "string" ? user.username.trim() : "";
  const globalName = typeof user.global_name === "string" ? user.global_name.trim() : "";
  const nick = typeof member.nick === "string" ? member.nick.trim() : "";
  const name = nick || globalName || username;
  return { nativeId, ...(name ? { name } : {}), ...(username ? { handle: username } : {}) };
}
