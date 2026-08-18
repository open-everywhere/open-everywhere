import {
  turnOriginPlatform,
  assertTurnSurface,
  resolveWindowSources,
  type BindableContext,
} from "../identity/binding.js";
import type { Domain } from "../memory/domain.js";
import { domainForChannel, externalPolicyOverrideFor } from "../memory/domain.js";
import { resolvePartition } from "../memory/partition.js";
import { getConfig } from "../access/config.js";
import type { IngestionSource } from "../access/taint-tiers.js";
import { resolveExternalPolicy, shippedExternalPolicy, WITHHELD_BODY_MARKER, type ExternalPolicy } from "../access/external-policy.js";

import { ChannelScopeError } from "./read-scope-error.js";
import { auditChannelReadRefusal, type ReadScopeAuditDeps } from "./read-scope-audit.js";
import { admitProviderRegistration } from "../access/provider-selection.js";
export { ChannelScopeError };

export interface RenderedLine {
  readonly author: string;
  readonly ts: string;
  readonly text: string;
  readonly authorId?: string;
  readonly bot?: boolean;
}

export interface ChannelReadResult {
  readonly platform: string;
  readonly channel: string;
  readonly count: number;
  readonly messages: readonly RenderedLine[];
  readonly authoredByNonMember?: boolean;
  readonly possiblyIncomplete?: boolean;
}

export interface ThreadReadResult {
  readonly platform: string;
  readonly channel: string;
  readonly thread_ts: string;
  readonly count: number;
  readonly messages: readonly RenderedLine[];
  readonly authoredByNonMember?: boolean;
  readonly possiblyIncomplete?: boolean;
}

export interface ReadAdapter {
  readonly platform: string;
  readChannel(ctx: BindableContext, channel: string, limit?: number): Promise<readonly RenderedLine[]>;
  readThread(ctx: BindableContext, channel: string, threadTs: string, limit?: number): Promise<readonly RenderedLine[]>;
  refutedAuthorIds?(ctx: BindableContext, lines: readonly RenderedLine[]): Promise<readonly string[]>;
}

const EMPTY_REFUTED: ReadonlySet<string> = new Set<string>();

async function adapterRefutedAuthorIds(adapter: ReadAdapter, ctx: BindableContext, lines: readonly RenderedLine[]): Promise<ReadonlySet<string>> {
  if (adapter.refutedAuthorIds === undefined) return EMPTY_REFUTED;
  try {
    return new Set(await adapter.refutedAuthorIds(ctx, lines));
  } catch {
    return EMPTY_REFUTED;
  }
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

export async function assertSurfaceAllowed(ctx: BindableContext, platform: string, surfaceId: string, deps?: ReadScopeAuditDeps): Promise<void> {
  const p = resolvePartition(ctx);
  const domains = getConfig().loadDomains();
  const { ids, domain } = allowedSurfaceIdsFrom(p.surfaceKey, platform, domains);
  if (ids.has(surfaceId)) return;
  await auditChannelReadRefusal(ctx, { platform, surfaceId, callerKey: p.surfaceKey, callerDomain: domain, domains }, deps);
  const scope = domain ? `domain "${domain}"` : "this channel's (no multi-channel domain)";
  throw new ChannelScopeError(
    `channel "${surfaceId}" is not in ${scope} ${platform} read scope. The agent may only read channels in its ` +
      `memory domain (memory/domains.ts). Add the channel to the domain's \`channels\` to grant it.`,
  );
}

const READ_ADAPTER_REGISTRY: Record<string, ReadAdapter> = {};
const SUPPORTED_PLATFORMS_LIVE: string[] = [];

export function registerReadAdapter(adapter: ReadAdapter): void {
  if (!admitProviderRegistration(adapter.platform, "read-adapter")) return;
  if (!(adapter.platform in READ_ADAPTER_REGISTRY)) SUPPORTED_PLATFORMS_LIVE.push(adapter.platform);
  READ_ADAPTER_REGISTRY[adapter.platform] = adapter;
}

export const READ_ADAPTERS: Readonly<Record<string, ReadAdapter>> = READ_ADAPTER_REGISTRY;

export const SUPPORTED_READ_PLATFORMS: readonly string[] = SUPPORTED_PLATFORMS_LIVE;

export function supportedReadPlatforms(): readonly string[] {
  return Object.keys(READ_ADAPTER_REGISTRY);
}

export class WindowSourcesRefusalError extends Error {
  constructor(message: string, readonly platform: string) {
    super(message);
  }
}

export function resolveReadAdapter(
  ctx: BindableContext,
  targetPlatform: string | undefined,
  domains: readonly Domain[],
): { platform: string; adapter: ReadAdapter } {
  const platform = targetPlatform ?? turnOriginPlatform(ctx);
  if (!platform) {
    throw new Error("read: couldn't resolve which surface to read — pass `target.platform` (e.g. \"slack\").");
  }
  const sources = resolveWindowSources(ctx, domains);
  if (!sources.includes(platform)) {
    throw new WindowSourcesRefusalError(
      `read: "${platform}" is not one of this window's sources (${sources.join(", ") || "none"}) — ` +
        "you can only read a surface whose messages fan into this window.",
      platform,
    );
  }
  assertTurnSurface(ctx, platform);
  const adapter = READ_ADAPTERS[platform];
  if (!adapter) {
    throw new Error(`read: reading a ${platform} channel is not supported yet (supported: ${supportedReadPlatforms().join(", ")}).`);
  }
  return { platform, adapter };
}

export interface ReadOutputLine {
  author: string;
  ts: string;
  text: string;
}

export interface ChannelReadOutput {
  platform: string;
  channel: string;
  count: number;
  messages: ReadOutputLine[];
  authoredByNonMember?: boolean;
  possiblyIncomplete?: boolean;
}

export interface ThreadReadOutput extends ChannelReadOutput {
  thread_ts: string;
}

function readAuthorPolicy(ctx: BindableContext): ExternalPolicy {
  try {
    return resolveExternalPolicy(externalPolicyOverrideFor(resolvePartition(ctx).surfaceKey, getConfig().loadDomains()));
  } catch {
    return shippedExternalPolicy();
  }
}

async function gradeAndProject(
  ctx: BindableContext,
  adapter: ReadAdapter,
  lines: readonly RenderedLine[],
  effectiveLimit: number,
): Promise<{ count: number; messages: ReadOutputLine[]; authoredByNonMember?: boolean; possiblyIncomplete?: boolean }> {
  const refuted = await adapterRefutedAuthorIds(adapter, ctx, lines);
  const withholding = refuted.size > 0 && readAuthorPolicy(ctx).authorGrain === "withhold";
  const withheld = (m: RenderedLine): boolean => withholding && m.bot !== true && m.authorId !== undefined && refuted.has(m.authorId);
  return {
    count: lines.length,
    messages: lines.map((m) => ({ author: m.author, ts: m.ts, text: withheld(m) ? WITHHELD_BODY_MARKER : m.text })),
    ...(refuted.size > 0 && !withholding ? { authoredByNonMember: true } : {}),
    ...(lines.length >= effectiveLimit ? { possiblyIncomplete: true } : {}),
  };
}

const DEFAULT_CHANNEL_LIMIT_ESTIMATE = 50;
const DEFAULT_THREAD_LIMIT_ESTIMATE = 100;

export async function readChannelResult(
  ctx: BindableContext,
  platform: string,
  adapter: ReadAdapter,
  channel: string,
  limit?: number,
): Promise<ChannelReadOutput> {
  const lines = await adapter.readChannel(ctx, channel, limit);
  return { platform, channel, ...(await gradeAndProject(ctx, adapter, lines, limit ?? DEFAULT_CHANNEL_LIMIT_ESTIMATE)) };
}

export async function readThreadResult(
  ctx: BindableContext,
  platform: string,
  adapter: ReadAdapter,
  channel: string,
  threadTs: string,
  limit?: number,
): Promise<ThreadReadOutput> {
  const lines = await adapter.readThread(ctx, channel, threadTs, limit);
  return { platform, channel, thread_ts: threadTs, ...(await gradeAndProject(ctx, adapter, lines, limit ?? DEFAULT_THREAD_LIMIT_ESTIMATE)) };
}

export function chatReadIngestion(label: string, out: { readonly authoredByNonMember?: boolean }): IngestionSource {
  return { kind: "chat-message", label, ...(out.authoredByNonMember === true ? { authoredByNonMember: true } : {}) };
}

function coverageNote(kind: "channel" | "thread", count: number): string {
  return `\n\n[coverage: showing the ${count} most recent ${kind === "channel" ? "messages" : "replies"} this fetch could return — older ${kind === "channel" ? "history" : "replies"} may exist beyond this page]`;
}

export function renderChannelBody(out: ChannelReadResult): string {
  if (out.count === 0) return `No readable messages in ${out.channel}.`;
  const body = `Recent messages in ${out.channel} (oldest first):\n` + out.messages.map((m) => `[${m.author}] ${m.text}`).join("\n");
  return out.possiblyIncomplete ? body + coverageNote("channel", out.count) : body;
}

export function channelReadSource(out: ChannelReadResult): string {
  return `${out.platform} channel ${out.channel}`;
}

export function renderThreadBody(out: ThreadReadResult): string {
  if (out.count === 0) return `No readable replies in thread ${out.thread_ts}.`;
  const body = `Thread ${out.thread_ts} in ${out.channel} (oldest first):\n` + out.messages.map((m) => `[${m.author}] ${m.text}`).join("\n");
  return out.possiblyIncomplete ? body + coverageNote("thread", out.count) : body;
}

export function threadReadSource(out: ThreadReadResult): string {
  return `${out.platform} thread ${out.channel}/${out.thread_ts}`;
}
