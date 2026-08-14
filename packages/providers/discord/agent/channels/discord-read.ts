import {
  assertSurfaceAllowed,
  resolvePartition,
  readIngestsNonMember,
  type BindableContext,
  type RenderedLine,
} from "@open-everywhere/core/agent/adapter-api.js";
import { linesFromDiscordMessages, type DiscordRoleProbe } from "./discord-backscroll.js";
import { discordAuthorRoles } from "../approvals/discord-admin.js";

const DISCORD_CHANNEL_DEFAULT_LIMIT = 50;
const DISCORD_THREAD_DEFAULT_LIMIT = 100;
const DISCORD_MAX_PAGE = 100;

export type DiscordReadRequester = (channelId: string, limit: number) => Promise<unknown>;

const liveDiscordRead: DiscordReadRequester = async (channelId, limit) => {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) throw new Error("read: DISCORD_BOT_TOKEN is not set — the Discord read tools need the bot token.");
  const qs = new URLSearchParams({ limit: String(Math.min(limit, DISCORD_MAX_PAGE)) }).toString();
  const res = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages?${qs}`, {
    headers: { authorization: `Bot ${token}` },
  });
  if (!res.ok) throw new Error(`read: Discord GET messages failed (HTTP ${res.status}) for channel ${channelId}.`);
  return res.json();
};

export function discordLinesFromRaw(raw: unknown): RenderedLine[] {
  if (!Array.isArray(raw)) return [];
  const ordered = [...(raw as Array<Record<string, unknown>>)].reverse();
  return linesFromDiscordMessages(ordered).map((l) => ({
    author: l.senderId ?? "(unknown)",
    ts: l.ts,
    text: l.text,
    ...(l.senderType === "bot" || l.senderType === "agent"
      ? { bot: true }
      : l.senderType === "user" && l.senderId !== undefined
        ? { authorId: l.senderId }
        : {}),
  }));
}

export const discordReadAdapter = {
  platform: "discord" as const,
  async readChannel(ctx: BindableContext, channel: string, limit?: number, req: DiscordReadRequester = liveDiscordRead): Promise<readonly RenderedLine[]> {
    await assertSurfaceAllowed(ctx, "discord", channel);
    return discordLinesFromRaw(await req(channel, limit ?? DISCORD_CHANNEL_DEFAULT_LIMIT));
  },
  async readThread(ctx: BindableContext, channel: string, threadTs: string, limit?: number, req: DiscordReadRequester = liveDiscordRead): Promise<readonly RenderedLine[]> {
    await assertSurfaceAllowed(ctx, "discord", threadTs);
    return discordLinesFromRaw(await req(threadTs, limit ?? DISCORD_THREAD_DEFAULT_LIMIT));
  },
  async authoredByNonMember(ctx: BindableContext, lines: readonly RenderedLine[], roleProbe: DiscordRoleProbe = discordAuthorRoles): Promise<boolean> {
    const p = resolvePartition(ctx);
    const tenantKey = p.workspaceKey;
    const guildId = p.workspace;
    return await readIngestsNonMember(lines, tenantKey, {
      memberships: async (authorId) => {
        const roles = await roleProbe(guildId, authorId);
        return roles === undefined ? undefined : roles.map((r) => `${tenantKey}/role:${r}`);
      },
    });
  },
};
