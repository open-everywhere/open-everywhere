import { callSlackApi } from "eve/channels/slack";
import { getConfig } from "../access/config.js";
import { domainForChannel } from "../memory/domain.js";
import { resolvePartition } from "../memory/partition.js";
import type { BindableContext } from "../identity/binding.js";

export class ChannelScopeError extends Error {}

function channelIdFromKey(key: string): string | null {
  const parts = key.split("/");
  if (parts.length !== 3 || parts[0] !== "slack") return null;
  return parts[2] || null;
}

export function allowedChannelIds(ctx: BindableContext): { ids: Set<string>; domain?: string } {
  const p = resolvePartition(ctx);
  const ids = new Set<string>();
  const own = channelIdFromKey(p.surfaceKey);
  if (own) ids.add(own);
  const domain = domainForChannel(p.surfaceKey, getConfig().loadDomains());
  if (domain) {
    for (const key of domain.channels ?? []) {
      const id = channelIdFromKey(key);
      if (id) ids.add(id);
    }
  }
  return { ids, domain: domain?.name };
}

export function assertChannelAllowed(ctx: BindableContext, channelId: string): void {
  const { ids, domain } = allowedChannelIds(ctx);
  if (ids.has(channelId)) return;
  const scope = domain ? `domain "${domain}"` : "this channel's (no multi-channel domain)";
  throw new ChannelScopeError(
    `channel "${channelId}" is not in ${scope} read scope. The agent may only read channels in its ` +
      `memory domain (memory/domains.ts). Add the channel to the domain's \`channels\` to grant it.`,
  );
}

export function readableChannelList(ctx: BindableContext): string[] {
  return [...allowedChannelIds(ctx).ids].sort();
}

interface SlackReadResponse {
  readonly ok: boolean;
  readonly error?: string;
  readonly [key: string]: unknown;
}

export async function callSlackRead(operation: string, params: Record<string, string | number | boolean>): Promise<SlackReadResponse> {
  if (!process.env.SLACK_BOT_TOKEN) {
    throw new Error("SLACK_BOT_TOKEN is not set — the Slack read tools need the bot token to call the Web API.");
  }
  const json = (await callSlackApi({ botToken: undefined, operation, body: params })) as SlackReadResponse;
  if (!json.ok) throw new Error(`Slack ${operation} failed: ${json.error ?? "unknown error"}`);
  return json;
}

export interface RenderedMessage {
  readonly author: string;
  readonly ts: string;
  readonly text: string;
}

export function renderMessages(raw: unknown, opts: { oldestFirst?: boolean } = {}): RenderedMessage[] {
  if (!Array.isArray(raw)) return [];
  const out: RenderedMessage[] = [];
  for (const m of raw as Array<Record<string, unknown>>) {
    if (typeof m.subtype === "string" && m.subtype.length > 0) continue;
    const text = typeof m.text === "string" ? m.text : "";
    if (!text) continue;
    out.push({ author: (m.user as string) ?? (m.bot_id as string) ?? "(unknown)", ts: (m.ts as string) ?? "", text });
  }
  if (opts.oldestFirst === false) out.reverse();
  return out;
}
