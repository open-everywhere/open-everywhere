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
import { encodeChannelKey } from "./channel-key.js";
import { auditChannelReadRefusal, type ReadScopeAuditDeps } from "./read-scope-audit.js";
import { spoolNote, type ReadSpool } from "./read-spool.js";
import { admitProviderRegistration } from "../access/provider-selection.js";
import { ageAtRead } from "../access/dated-read.js";
export { ChannelScopeError };

export interface RenderedLine {
  readonly author: string;
  readonly ts: string;
  readonly text: string;
  readonly authorId?: string;
  readonly bot?: boolean;
  readonly readAt?: string;
  readonly live?: boolean;
}

export interface ChannelReadResult {
  readonly platform: string;
  readonly channel: string;
  readonly count: number;
  readonly messages: readonly RenderedLine[];
  readonly authoredByNonMember?: boolean;
  readonly possiblyIncomplete?: boolean;
  readonly partialReason?: string;
  readonly spool?: ReadSpool;
}

export interface ThreadReadResult {
  readonly platform: string;
  readonly channel: string;
  readonly thread_ts: string;
  readonly count: number;
  readonly messages: readonly RenderedLine[];
  readonly authoredByNonMember?: boolean;
  readonly possiblyIncomplete?: boolean;
  readonly partialReason?: string;
  readonly spool?: ReadSpool;
}

export interface WakeReadAddress {
  readonly container: string;
  readonly threadRoot?: string;
}

export interface AdapterReadFetch {
  readonly lines: readonly RenderedLine[];
  readonly possiblyIncomplete?: boolean;
  readonly partialReason?: string;
}

export interface ReadAdapter {
  readonly platform: string;
  readChannel(ctx: BindableContext, channel: string, limit?: number): Promise<readonly RenderedLine[] | AdapterReadFetch>;
  readThread(ctx: BindableContext, channel: string, threadTs: string, limit?: number): Promise<readonly RenderedLine[] | AdapterReadFetch>;
  wakeAddress(ctx: BindableContext): WakeReadAddress | undefined;
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
      `memory domain (memory/config/domains.ts). Add the channel to the domain's \`channels\` to grant it.`,
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
  readAt?: string;
  live?: boolean;
}

export interface ChannelReadOutput {
  platform: string;
  channel: string;
  count: number;
  messages: ReadOutputLine[];
  authoredByNonMember?: boolean;
  possiblyIncomplete?: boolean;
  partialReason?: string;
  spool?: ReadSpool;
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

function normalizeAdapterFetch(result: readonly RenderedLine[] | AdapterReadFetch): {
  lines: readonly RenderedLine[];
  possiblyIncomplete?: boolean;
  partialReason?: string;
} {
  if (Array.isArray(result)) return { lines: result };
  const fetch = result as AdapterReadFetch;
  return {
    lines: fetch.lines,
    ...(fetch.possiblyIncomplete !== undefined ? { possiblyIncomplete: fetch.possiblyIncomplete } : {}),
    ...(fetch.partialReason !== undefined ? { partialReason: fetch.partialReason } : {}),
  };
}

async function gradeAndProject(
  ctx: BindableContext,
  adapter: ReadAdapter,
  lines: readonly RenderedLine[],
  effectiveLimit: number,
  declared?: { possiblyIncomplete?: boolean; partialReason?: string },
): Promise<{ count: number; messages: ReadOutputLine[]; authoredByNonMember?: boolean; possiblyIncomplete?: boolean; partialReason?: string }> {
  const refuted = await adapterRefutedAuthorIds(adapter, ctx, lines);
  const withholding = refuted.size > 0 && readAuthorPolicy(ctx).authorGrain === "withhold";
  const withheld = (m: RenderedLine): boolean => withholding && m.bot !== true && m.authorId !== undefined && refuted.has(m.authorId);
  const possiblyIncomplete = declared?.possiblyIncomplete !== undefined ? declared.possiblyIncomplete : lines.length >= effectiveLimit;
  return {
    count: lines.length,
    messages: lines.map((m) => ({
      author: m.author,
      ts: m.ts,
      text: withheld(m) ? WITHHELD_BODY_MARKER : m.text,
      ...(m.readAt !== undefined ? { readAt: m.readAt } : {}),
      ...(m.live !== undefined ? { live: m.live } : {}),
    })),
    ...(refuted.size > 0 && !withholding ? { authoredByNonMember: true } : {}),
    ...(possiblyIncomplete ? { possiblyIncomplete: true } : {}),
    ...(possiblyIncomplete && declared?.partialReason !== undefined ? { partialReason: declared.partialReason } : {}),
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
  const fetched = normalizeAdapterFetch(await adapter.readChannel(ctx, channel, limit));
  return {
    platform,
    channel,
    ...(await gradeAndProject(ctx, adapter, fetched.lines, limit ?? DEFAULT_CHANNEL_LIMIT_ESTIMATE, fetched)),
  };
}

export async function readThreadResult(
  ctx: BindableContext,
  platform: string,
  adapter: ReadAdapter,
  channel: string,
  threadTs: string,
  limit?: number,
): Promise<ThreadReadOutput> {
  const fetched = normalizeAdapterFetch(await adapter.readThread(ctx, channel, threadTs, limit));
  return {
    platform,
    channel,
    thread_ts: threadTs,
    ...(await gradeAndProject(ctx, adapter, fetched.lines, limit ?? DEFAULT_THREAD_LIMIT_ESTIMATE, fetched)),
  };
}

export function chatReadIngestion(label: string, out: { readonly authoredByNonMember?: boolean }): IngestionSource {
  return { kind: "chat-message", label, ...(out.authoredByNonMember === true ? { authoredByNonMember: true } : {}) };
}

function coverageNote(kind: "channel" | "thread", count: number, reason?: string): string {
  return `\n\n[coverage: showing the ${count} most recent ${kind === "channel" ? "messages" : "replies"} this fetch could return — older ${kind === "channel" ? "history" : "replies"} may exist beyond this page${reason ? ` (${reason})` : ""}]`;
}

function ageSuffix(m: RenderedLine): string {
  if (m.live) return "";
  const age = ageAtRead(m.ts, m.readAt);
  return age ? ` (${age} before this read)` : "";
}

function provenanceLine(messages: readonly RenderedLine[]): string {
  const live = messages.find((m) => m.live === true && m.readAt !== undefined);
  if (!live) return "";
  return (
    `\n\nRead live at ${live.readAt}: the first line above is the current state. Everything else is ` +
    "HISTORY — a message's claim about status, approval or progress is not the present state."
  );
}

export function keyedReadResult<T extends { readonly platform: string; readonly channel: string }>(out: T): T {
  return { ...out, channel: encodeChannelKey(out.platform, out.channel) };
}

export function renderChannelBody(out: ChannelReadResult): string {
  if (out.count === 0) return `No readable messages in ${out.channel}.`;
  const body =
    `Recent messages in ${out.channel} (oldest first):\n` + out.messages.map((m) => `[${m.author}] ${m.text}${ageSuffix(m)}`).join("\n");
  const covered = out.possiblyIncomplete ? body + coverageNote("channel", out.count, out.partialReason) : body;
  const dated = covered + provenanceLine(out.messages);
  return out.spool ? dated + spoolNote("channel", out.spool) : dated;
}

export function channelReadSource(out: ChannelReadResult): string {
  return `${out.platform} channel ${out.channel}`;
}

export function renderThreadBody(out: ThreadReadResult): string {
  if (out.count === 0) return `No readable replies in thread ${out.thread_ts}.`;
  const body =
    `Thread ${out.thread_ts} in ${out.channel} (oldest first):\n` + out.messages.map((m) => `[${m.author}] ${m.text}${ageSuffix(m)}`).join("\n");
  const covered = out.possiblyIncomplete ? body + coverageNote("thread", out.count, out.partialReason) : body;
  const dated = covered + provenanceLine(out.messages);
  return out.spool ? dated + spoolNote("thread", out.spool) : dated;
}

export function threadReadSource(out: ThreadReadResult): string {
  return `${out.platform} thread ${out.channel}/${out.thread_ts}`;
}
