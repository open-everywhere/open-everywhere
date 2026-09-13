import { resolveTeamsAppId, resolveTeamsAppPassword, resolveTeamsTenantId } from "eve/channels/teams";
import {
  auditChannelReadRefusal,
  bindFrom,
  resolvePartition,
  domainKeyOf,
  domainForChannel,
  getConfig,
  refutedReadAuthorIds,
  ChannelScopeError,
  warmCredential,
  type BindableContext,
  type BrokeredSecret,
  type Domain,
  type ReadScopeAuditDeps,
  type WakeReadAddress,
  domainRoster,
} from "@open-everywhere/core/agent/adapter-api.js";
import { noteTeamsReadBoundary, teamsReadBoundary, _resetTeamsReadBoundaryForTest } from "./teams-graph-boundary.js";
import { teamsGraphTeamId } from "./teams-graph-team-id.js";
import { teamsReplyChainRoot } from "./teams-conversation-ref.js";

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
const GRAPH_TOKEN_SCOPE = "https://graph.microsoft.com/.default";
const TOKEN_LOGIN_BASE = "https://login.microsoftonline.com";
const TOKEN_SKEW_MS = 60_000;
const GRAPH_TOKEN_FALLBACK_TTL_SEC = 3600;

const TEAMS_CHANNEL_DEFAULT_LIMIT = 50;
const TEAMS_THREAD_DEFAULT_LIMIT = 100;
const TEAMS_GRAPH_PAGE_SIZE = 50;
const TEAMS_GRAPH_MAX_PAGES = 5;

async function mintTeamsGraphTokenOnce(): Promise<BrokeredSecret> {
  const [appId, appPassword, tenantId] = await Promise.all([resolveTeamsAppId(), resolveTeamsAppPassword(), resolveTeamsTenantId()]);
  if (!tenantId) {
    throw new Error(
      "read: Teams channel reads need MICROSOFT_TENANT_ID (or TEAMS_TENANT_ID) set — Graph's " +
        "client-credential token is tenant-scoped (unlike the Bot Connector token, which tolerates an absent tenant).",
    );
  }
  const body = new URLSearchParams({ client_id: appId, client_secret: appPassword, grant_type: "client_credentials", scope: GRAPH_TOKEN_SCOPE });
  const res = await fetch(`${TOKEN_LOGIN_BASE}/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const json = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
  if (!res.ok || !json.access_token) {
    throw new Error(`read: Teams Graph token request failed — ${json.error_description ?? json.error ?? `HTTP ${res.status}`}.`);
  }
  await noteTeamsReadBoundary(json.access_token);
  return { value: json.access_token, expiresAtMs: Date.now() + (json.expires_in ?? GRAPH_TOKEN_FALLBACK_TTL_SEC) * 1000 };
}

const teamsGraphToken = warmCredential({
  name: "teams.graph-app-only",
  platform: "teams",
  auditAction: "teams.token_mint_failed",
  refresh: "re-mint",
  refreshMarginMs: TOKEN_SKEW_MS,
  fallbackTtlSeconds: GRAPH_TOKEN_FALLBACK_TTL_SEC,
  mint: mintTeamsGraphTokenOnce,
});

export function _resetTeamsGraphTokenCache(): void {
  teamsGraphToken.reset();
  _resetTeamsReadBoundaryForTest();
}

export type TeamsGraphRequester = (url: string) => Promise<unknown>;

export const liveTeamsGraphRequest: TeamsGraphRequester = async (url) => {
  const token = await teamsGraphToken.get();
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`read: Teams Graph GET failed (HTTP ${res.status}) for ${url}${text ? ` — ${text.slice(0, 200)}` : ""}`);
  }
  return res.json();
};

interface GraphChatMessage {
  readonly id?: string;
  readonly createdDateTime?: string;
  readonly deletedDateTime?: string | null;
  readonly messageType?: string;
  readonly from?: {
    readonly user?: { readonly id?: string; readonly displayName?: string };
    readonly application?: { readonly id?: string; readonly displayName?: string };
  };
  readonly body?: { readonly contentType?: string; readonly content?: string };
}

export interface TeamsRenderedLine {
  readonly author: string;
  readonly ts: string;
  readonly text: string;
  readonly authorId?: string;
  readonly bot?: boolean;
}

export function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function authorOf(m: GraphChatMessage): string {
  return m.from?.user?.displayName ?? m.from?.user?.id ?? m.from?.application?.displayName ?? m.from?.application?.id ?? "(unknown)";
}

function isConversationMessage(m: GraphChatMessage): boolean {
  if (m.deletedDateTime) return false;
  return m.messageType === undefined || m.messageType === "message";
}

interface Intermediate extends TeamsRenderedLine {
  readonly createdMs: number;
}

function toIntermediate(m: GraphChatMessage): Intermediate | undefined {
  if (!isConversationMessage(m)) return undefined;
  const text = stripHtml(m.body?.content ?? "");
  if (!text) return undefined;
  const parsed = m.createdDateTime ? Date.parse(m.createdDateTime) : Number.NaN;
  const userId = m.from?.user?.id;
  const isApp = m.from?.user === undefined && m.from?.application !== undefined;
  return {
    author: authorOf(m),
    ts: m.id ?? "",
    text,
    createdMs: Number.isFinite(parsed) ? parsed : 0,
    ...(isApp ? { bot: true } : typeof userId === "string" && userId.length > 0 ? { authorId: userId } : {}),
  };
}

export function teamsLinesFromRaw(raw: unknown): TeamsRenderedLine[] {
  return teamsTimedLinesFromRaw(raw).map(({ createdMs: _createdMs, ...line }) => line);
}

export function teamsTimedLinesFromRaw(raw: unknown): Array<TeamsRenderedLine & { readonly createdMs: number }> {
  if (!Array.isArray(raw)) return [];
  const lines = (raw as GraphChatMessage[]).map(toIntermediate).filter((l): l is Intermediate => l !== undefined);
  lines.sort((a, b) => a.createdMs - b.createdMs);
  return lines;
}

interface GraphPage {
  readonly value?: readonly GraphChatMessage[];
  readonly ["@odata.nextLink"]?: string;
}

export async function fetchGraphPages(req: TeamsGraphRequester, initialUrl: string, limit: number): Promise<GraphChatMessage[]> {
  const all: GraphChatMessage[] = [];
  let url: string | undefined = initialUrl;
  for (let page = 0; page < TEAMS_GRAPH_MAX_PAGES && url && all.length < limit; page++) {
    const json = (await req(url)) as GraphPage;
    all.push(...(Array.isArray(json.value) ? json.value : []));
    url = typeof json["@odata.nextLink"] === "string" ? json["@odata.nextLink"] : undefined;
  }
  return all;
}

export function channelMessagesUrl(teamId: string, channelId: string): string {
  return `${GRAPH_BASE}/teams/${encodeURIComponent(teamId)}/channels/${encodeURIComponent(channelId)}/messages?$top=${TEAMS_GRAPH_PAGE_SIZE}`;
}

export function threadRepliesUrl(teamId: string, channelId: string, rootMessageId: string): string {
  return `${GRAPH_BASE}/teams/${encodeURIComponent(teamId)}/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(rootMessageId)}/replies?$top=${TEAMS_GRAPH_PAGE_SIZE}`;
}

const UNSAFE_SEGMENT_CHARS = /[^a-zA-Z0-9._-]+/g;

export function sanitizeTeamsChannelId(value: string): string {
  return value.trim().replace(UNSAFE_SEGMENT_CHARS, "-").replace(/^[-.]+|[-.]+$/g, "").slice(0, 100);
}

export function allowedTeamsChannelIds(channelGrainKey: string, domains: readonly Domain[]): { ids: Set<string>; domain?: string } {
  const ids = new Set<string>();
  const own = channelGrainKey.split("/")[2];
  if (own) ids.add(own);
  const domain = domainForChannel(channelGrainKey, domains);
  if (domain) {
    for (const key of domainRoster(domain)) {
      const parts = key.split("/");
      if (parts.length === 3 && parts[0] === "teams" && parts[2]) ids.add(parts[2]);
    }
  }
  return { ids, domain: domain?.name };
}

export async function assertTeamsChannelAllowed(ctx: BindableContext, channelId: string, deps?: ReadScopeAuditDeps): Promise<void> {
  const p = resolvePartition(ctx);
  const domains = getConfig().loadDomains();
  const callerKey = domainKeyOf(p);
  const { ids, domain } = allowedTeamsChannelIds(callerKey, domains);
  const wanted = sanitizeTeamsChannelId(channelId);
  if (ids.has(wanted)) return;
  await auditChannelReadRefusal(ctx, { platform: "teams", surfaceId: wanted, callerKey, callerDomain: domain, domains, boundary: teamsReadBoundary() }, deps);
  const scope = domain ? `domain "${domain}"` : "this channel's (no multi-channel domain)";
  throw new ChannelScopeError(
    `channel "${channelId}" is not in ${scope} teams read scope. The agent may only read channels in its ` +
      `memory domain (memory/config/domains.ts). Add the channel to the domain's \`channels\` to grant it.`,
  );
}

async function currentGraphTeamId(ctx: BindableContext): Promise<string | undefined> {
  const t = bindFrom(ctx).target;
  const botTeamId = typeof t?.teamId === "string" && t.teamId.length > 0 ? t.teamId : undefined;
  const serviceUrl = typeof t?.serviceUrl === "string" && t.serviceUrl.length > 0 ? t.serviceUrl : undefined;
  return await teamsGraphTeamId(botTeamId, serviceUrl);
}

function noTeamIdError(what: string): Error {
  return new Error(
    `read: couldn't resolve this Teams channel's team id from the live session — Teams ${what} need an engaged team-channel turn, ` +
      `and the team's Microsoft 365 group id must be resolvable from the Bot Connector.`,
  );
}

export const teamsReadAdapter = {
  platform: "teams" as const,
  wakeAddress(ctx: BindableContext): WakeReadAddress | undefined {
    const b = bindFrom(ctx);
    const container = typeof b.target?.["channelId"] === "string" ? (b.target["channelId"] as string) : undefined;
    if (!container) return undefined;
    const conversation = typeof b.target?.["conversationId"] === "string" ? (b.target["conversationId"] as string) : undefined;
    const root = conversation ? teamsReplyChainRoot(conversation) : undefined;
    return { container, ...(root ? { threadRoot: root } : {}) };
  },
  async readChannel(ctx: BindableContext, channel: string, limit?: number, req: TeamsGraphRequester = liveTeamsGraphRequest): Promise<readonly TeamsRenderedLine[]> {
    await assertTeamsChannelAllowed(ctx, channel);
    const teamId = await currentGraphTeamId(ctx);
    if (!teamId) throw noTeamIdError("channel reads");
    const n = limit ?? TEAMS_CHANNEL_DEFAULT_LIMIT;
    const raw = await fetchGraphPages(req, channelMessagesUrl(teamId, channel), n);
    return teamsLinesFromRaw(raw).slice(-n);
  },
  async readThread(ctx: BindableContext, channel: string, threadTs: string, limit?: number, req: TeamsGraphRequester = liveTeamsGraphRequest): Promise<readonly TeamsRenderedLine[]> {
    await assertTeamsChannelAllowed(ctx, channel);
    const teamId = await currentGraphTeamId(ctx);
    if (!teamId) throw noTeamIdError("thread reads");
    const n = limit ?? TEAMS_THREAD_DEFAULT_LIMIT;
    const raw = await fetchGraphPages(req, threadRepliesUrl(teamId, channel, threadTs), n);
    return teamsLinesFromRaw(raw).slice(-n);
  },
  async refutedAuthorIds(ctx: BindableContext, lines: readonly TeamsRenderedLine[]): Promise<readonly string[]> {
    return await refutedReadAuthorIds(lines, resolvePartition(ctx).workspaceKey);
  },
};
