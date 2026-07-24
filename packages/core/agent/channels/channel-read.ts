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

import { ChannelScopeError } from "./read-scope-error.js";
export { ChannelScopeError };

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

const READ_ADAPTER_REGISTRY: Record<string, ReadAdapter> = {};
const SUPPORTED_PLATFORMS_LIVE: string[] = [];

export function registerReadAdapter(adapter: ReadAdapter): void {
  if (!(adapter.platform in READ_ADAPTER_REGISTRY)) SUPPORTED_PLATFORMS_LIVE.push(adapter.platform);
  READ_ADAPTER_REGISTRY[adapter.platform] = adapter;
}

export const READ_ADAPTERS: Readonly<Record<string, ReadAdapter>> = READ_ADAPTER_REGISTRY;

export const SUPPORTED_READ_PLATFORMS: readonly string[] = SUPPORTED_PLATFORMS_LIVE;

export function supportedReadPlatforms(): readonly string[] {
  return Object.keys(READ_ADAPTER_REGISTRY);
}

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
    throw new Error(`read: reading a ${platform} channel is not supported yet (supported: ${supportedReadPlatforms().join(", ")}).`);
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
