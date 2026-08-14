import { callSlackApi } from "eve/channels/slack";
import {
  auditChannelReadRefusal,
  getConfig,
  domainForChannel,
  resolvePartition,
  refutedReadAuthorIds,
  ChannelScopeError,
  type BindableContext,
  type ReadScopeAuditDeps,
  type RenderedLine,
} from "@open-everywhere/core/agent/adapter-api.js";
import { slackAuthorIsMember, type SlackMemberProbe } from "./slack-events.js";

export { ChannelScopeError };

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

export async function assertChannelAllowed(ctx: BindableContext, channelId: string, deps?: ReadScopeAuditDeps): Promise<void> {
  const { ids, domain } = allowedChannelIds(ctx);
  if (ids.has(channelId)) return;
  const p = resolvePartition(ctx);
  await auditChannelReadRefusal(
    ctx,
    { platform: "slack", surfaceId: channelId, callerKey: p.surfaceKey, callerDomain: domain, domains: getConfig().loadDomains() },
    deps,
  );
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
  readonly authorId?: string;
  readonly bot?: boolean;
}

export function renderMessages(raw: unknown, opts: { oldestFirst?: boolean } = {}): RenderedMessage[] {
  if (!Array.isArray(raw)) return [];
  const out: RenderedMessage[] = [];
  for (const m of raw as Array<Record<string, unknown>>) {
    if (typeof m.subtype === "string" && m.subtype.length > 0) continue;
    const text = typeof m.text === "string" ? m.text : "";
    if (!text) continue;
    const user = typeof m.user === "string" && m.user.length > 0 ? m.user : undefined;
    const botId = typeof m.bot_id === "string" && m.bot_id.length > 0 ? m.bot_id : undefined;
    out.push({
      author: (m.user as string) ?? (m.bot_id as string) ?? "(unknown)",
      ts: (m.ts as string) ?? "",
      text,
      ...(botId !== undefined ? { bot: true } : user !== undefined ? { authorId: user } : {}),
    });
  }
  if (opts.oldestFirst === false) out.reverse();
  return out;
}

const SLACK_CHANNEL_DEFAULT_LIMIT = 50;
const SLACK_THREAD_DEFAULT_LIMIT = 100;

export type SlackReadCall = typeof callSlackRead;

function slackReadTenant(ctx: BindableContext): { teamId: string; tenantKey: string } {
  const p = resolvePartition(ctx);
  return { teamId: p.workspace, tenantKey: p.workspaceKey };
}

export const slackReadAdapter = {
  platform: "slack" as const,
  async readChannel(ctx: BindableContext, channel: string, limit?: number, call: SlackReadCall = callSlackRead): Promise<readonly RenderedLine[]> {
    await assertChannelAllowed(ctx, channel);
    const res = await call("conversations.history", { channel, limit: limit ?? SLACK_CHANNEL_DEFAULT_LIMIT, inclusive: true });
    return renderMessages(res.messages, { oldestFirst: false });
  },
  async readThread(ctx: BindableContext, channel: string, threadTs: string, limit?: number, call: SlackReadCall = callSlackRead): Promise<readonly RenderedLine[]> {
    await assertChannelAllowed(ctx, channel);
    const res = await call("conversations.replies", { channel, ts: threadTs, limit: limit ?? SLACK_THREAD_DEFAULT_LIMIT });
    return renderMessages(res.messages, { oldestFirst: true });
  },
  async refutedAuthorIds(ctx: BindableContext, lines: readonly RenderedLine[], probe: SlackMemberProbe = slackAuthorIsMember): Promise<readonly string[]> {
    const { teamId, tenantKey } = slackReadTenant(ctx);
    return await refutedReadAuthorIds(lines, tenantKey, {
      surfaceRefuted: async (authorId) => {
        const member = await probe(authorId, teamId);
        return member === undefined ? undefined : !member;
      },
    });
  },
};
