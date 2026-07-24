import {
  channelPlatform,
  assertTurnSurface,
  resolveWindowSources,
  type BindableContext,
} from "../identity/binding.js";
import type { Domain } from "../memory/domain.js";
import { domainForChannel } from "../memory/domain.js";
import { resolvePartition } from "../memory/partition.js";
import { getConfig } from "../access/config.js";
import {
  assertChannelAllowed,
  callSlackRead,
  renderMessages,
  ChannelScopeError,
  type RenderedMessage,
} from "./slack-read.js";
import { linesFromDiscordMessages } from "./discord-backscroll.js";
import { teamsReadAdapter } from "./teams-read.js";

export { teamsReadAdapter } from "./teams-read.js";

export interface RenderedLine {
  readonly author: string;
  readonly ts: string;
  readonly text: string;
}

export interface ChannelReadResult {
  readonly platform: string;
  readonly channel: string;
  readonly count: number;
  readonly messages: readonly RenderedLine[];
}

export interface ThreadReadResult {
  readonly platform: string;
  readonly channel: string;
  readonly thread_ts: string;
  readonly count: number;
  readonly messages: readonly RenderedLine[];
}

export interface ReadAdapter {
  readonly platform: string;
  readChannel(ctx: BindableContext, channel: string, limit?: number): Promise<readonly RenderedLine[]>;
  readThread(ctx: BindableContext, channel: string, threadTs: string, limit?: number): Promise<readonly RenderedLine[]>;
}

const SLACK_CHANNEL_DEFAULT_LIMIT = 50;
const SLACK_THREAD_DEFAULT_LIMIT = 100;

export type SlackReadCall = typeof callSlackRead;

export const slackReadAdapter = {
  platform: "slack" as const,
  async readChannel(ctx: BindableContext, channel: string, limit?: number, call: SlackReadCall = callSlackRead): Promise<readonly RenderedLine[]> {
    assertChannelAllowed(ctx, channel);
    const res = await call("conversations.history", { channel, limit: limit ?? SLACK_CHANNEL_DEFAULT_LIMIT, inclusive: true });
    return renderMessages(res.messages, { oldestFirst: false }) as RenderedMessage[];
  },
  async readThread(ctx: BindableContext, channel: string, threadTs: string, limit?: number, call: SlackReadCall = callSlackRead): Promise<readonly RenderedLine[]> {
    assertChannelAllowed(ctx, channel);
    const res = await call("conversations.replies", { channel, ts: threadTs, limit: limit ?? SLACK_THREAD_DEFAULT_LIMIT });
    return renderMessages(res.messages, { oldestFirst: true }) as RenderedMessage[];
  },
};

function surfaceIdFromKey(key: string, platform: string): string | null {
  const parts = key.split("/");
  if (parts.length !== 3 || parts[0] !== platform) return null;
  return parts[2] || null;
}

export function allowedSurfaceIdsFrom(
  surfaceKey: string,
  platform: string,
  domains: readonly Domain[],
): { ids: Set<string>; domain?: string } {
  const ids = new Set<string>();
  const own = surfaceIdFromKey(surfaceKey, platform);
  if (own) ids.add(own);
  const domain = domainForChannel(surfaceKey, domains);
  if (domain) {
    for (const key of domain.channels ?? []) {
      const id = surfaceIdFromKey(key, platform);
      if (id) ids.add(id);
    }
  }
  return { ids, domain: domain?.name };
}

export function assertSurfaceAllowed(ctx: BindableContext, platform: string, surfaceId: string): void {
  const p = resolvePartition(ctx);
  const { ids, domain } = allowedSurfaceIdsFrom(p.surfaceKey, platform, getConfig().loadDomains());
  if (ids.has(surfaceId)) return;
  const scope = domain ? `domain "${domain}"` : "this channel's (no multi-channel domain)";
  throw new ChannelScopeError(
    `channel "${surfaceId}" is not in ${scope} ${platform} read scope. The agent may only read channels in its ` +
      `memory domain (memory/domains.ts). Add the channel to the domain's \`channels\` to grant it.`,
  );
}

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
  return linesFromDiscordMessages(ordered).map((l) => ({ author: l.senderId ?? "(unknown)", ts: l.ts, text: l.text }));
}

export const discordReadAdapter = {
  platform: "discord" as const,
  async readChannel(ctx: BindableContext, channel: string, limit?: number, req: DiscordReadRequester = liveDiscordRead): Promise<readonly RenderedLine[]> {
    assertSurfaceAllowed(ctx, "discord", channel);
    return discordLinesFromRaw(await req(channel, limit ?? DISCORD_CHANNEL_DEFAULT_LIMIT));
  },
  async readThread(ctx: BindableContext, channel: string, threadTs: string, limit?: number, req: DiscordReadRequester = liveDiscordRead): Promise<readonly RenderedLine[]> {
    assertSurfaceAllowed(ctx, "discord", threadTs);
    return discordLinesFromRaw(await req(threadTs, limit ?? DISCORD_THREAD_DEFAULT_LIMIT));
  },
};

const READ_ADAPTER_REGISTRY: Record<string, ReadAdapter> = {};

export function registerReadAdapter(adapter: ReadAdapter): void {
  READ_ADAPTER_REGISTRY[adapter.platform] = adapter;
}

registerReadAdapter(slackReadAdapter);
registerReadAdapter(discordReadAdapter);
registerReadAdapter(teamsReadAdapter);

export const READ_ADAPTERS: Readonly<Record<string, ReadAdapter>> = READ_ADAPTER_REGISTRY;

export const SUPPORTED_READ_PLATFORMS: readonly string[] = Object.keys(READ_ADAPTER_REGISTRY);

export function resolveReadAdapter(
  ctx: BindableContext,
  targetPlatform: string | undefined,
  domains: readonly Domain[],
): { platform: string; adapter: ReadAdapter } {
  const platform = targetPlatform ?? channelPlatform(ctx);
  if (!platform) {
    throw new Error("read: couldn't resolve which surface to read — pass `target.platform` (e.g. \"slack\").");
  }
  const sources = resolveWindowSources(ctx, domains);
  if (!sources.includes(platform)) {
    throw new Error(
      `read: "${platform}" is not one of this window's sources (${sources.join(", ") || "none"}) — ` +
        "you can only read a surface whose messages fan into this window.",
    );
  }
  assertTurnSurface(ctx, platform);
  const adapter = READ_ADAPTERS[platform];
  if (!adapter) {
    throw new Error(`read: reading a ${platform} channel is not supported yet (supported: ${SUPPORTED_READ_PLATFORMS.join(", ")}).`);
  }
  return { platform, adapter };
}

export function renderChannelBody(out: ChannelReadResult): string {
  return out.count === 0
    ? `No readable messages in ${out.channel}.`
    : `Recent messages in ${out.channel} (oldest first):\n` + out.messages.map((m) => `[${m.author}] ${m.text}`).join("\n");
}

export function channelReadSource(out: ChannelReadResult): string {
  return `${out.platform} channel ${out.channel}`;
}

export function renderThreadBody(out: ThreadReadResult): string {
  return out.count === 0
    ? `No readable replies in thread ${out.thread_ts}.`
    : `Thread ${out.thread_ts} in ${out.channel} (oldest first):\n` + out.messages.map((m) => `[${m.author}] ${m.text}`).join("\n");
}

export function threadReadSource(out: ThreadReadResult): string {
  return `${out.platform} thread ${out.channel}/${out.thread_ts}`;
}
