import type { MeetingInviteLookup, MeetingInviteResolver } from "@open-everywhere/core/agent/adapter-api.js";

const GUILD_VOICE = 2;
const GUILD_STAGE_VOICE = 13;
const SNOWFLAKE = /^\d{17,20}$/;

export interface DiscordInviteDeps {
  readonly fetchFn?: typeof fetch;
  readonly token?: string;
}

export async function lookUpDiscordInvite(code: string, deps: DiscordInviteDeps = {}): Promise<MeetingInviteLookup> {
  const token = deps.token ?? process.env.DISCORD_BOT_TOKEN;
  if (!token) return { found: false, why: "unreachable" };
  try {
    const doFetch = deps.fetchFn ?? fetch;
    const res = await doFetch(`https://discord.com/api/v10/invites/${encodeURIComponent(code)}`, { headers: { authorization: `Bot ${token}` } });
    if (res.status === 404) return { found: false, why: "unknown" };
    if (!res.ok) return { found: false, why: "unreachable" };
    const body = (await res.json()) as { guild?: { id?: unknown } | null; channel?: { id?: unknown; type?: unknown } | null };
    const guildId = body.guild?.id;
    const channelId = body.channel?.id;
    if (typeof guildId !== "string" || !SNOWFLAKE.test(guildId) || typeof channelId !== "string" || !SNOWFLAKE.test(channelId)) return { found: false, why: "no-channel" };
    const type = body.channel?.type;
    const channelKind = type === GUILD_VOICE ? "voice" : type === GUILD_STAGE_VOICE ? "stage" : "other";
    return { found: true, guildId, channelId, channelKind };
  } catch {
    return { found: false, why: "unreachable" };
  }
}

export const discordInviteResolver: MeetingInviteResolver = (code) => lookUpDiscordInvite(code);
