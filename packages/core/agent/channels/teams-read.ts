import { resolveTeamsAppId, resolveTeamsAppPassword, resolveTeamsTenantId } from "eve/channels/teams";
import { bindFrom, type BindableContext } from "../identity/binding.js";
import { resolvePartition, domainKeyOf } from "../memory/partition.js";
import { domainForChannel, type Domain } from "../memory/domain.js";
import { getConfig } from "../access/config.js";
import { ChannelScopeError } from "./slack-read.js";

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
const GRAPH_TOKEN_SCOPE = "https://graph.microsoft.com/.default";
const TOKEN_LOGIN_BASE = "https://login.microsoftonline.com";
const TOKEN_SKEW_MS = 60_000;

const TEAMS_CHANNEL_DEFAULT_LIMIT = 50;
const TEAMS_THREAD_DEFAULT_LIMIT = 100;
const TEAMS_GRAPH_PAGE_SIZE = 50;
const TEAMS_GRAPH_MAX_PAGES = 5;

interface CachedGraphToken {
  readonly token: string;
  readonly expiresAt: number;
}

let cachedGraphToken: CachedGraphToken | undefined;

async function mintTeamsGraphToken(): Promise<string> {
  if (cachedGraphToken && Date.now() < cachedGraphToken.expiresAt - TOKEN_SKEW_MS) return cachedGraphToken.token;
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
  cachedGraphToken = { token: json.access_token, expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000 };
  return json.access_token;
}

export type TeamsGraphRequester = (url: string) => Promise<unknown>;

const liveTeamsGraphRequest: TeamsGraphRequester = async (url) => {
  const token = await mintTeamsGraphToken();
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
  return { author: authorOf(m), ts: m.id ?? "", text, createdMs: Number.isFinite(parsed) ? parsed : 0 };
}

export function teamsLinesFromRaw(raw: unknown): TeamsRenderedLine[] {
  if (!Array.isArray(raw)) return [];
  const lines = (raw as GraphChatMessage[]).map(toIntermediate).filter((l): l is Intermediate => l !== undefined);
  lines.sort((a, b) => a.createdMs - b.createdMs);
  return lines.map(({ author, ts, text }) => ({ author, ts, text }));
}

interface GraphPage {
  readonly value?: readonly GraphChatMessage[];
  readonly ["@odata.nextLink"]?: string;
}

async function fetchGraphPages(req: TeamsGraphRequester, initialUrl: string, limit: number): Promise<GraphChatMessage[]> {
  const all: GraphChatMessage[] = [];
  let url: string | undefined = initialUrl;
  for (let page = 0; page < TEAMS_GRAPH_MAX_PAGES && url && all.length < limit; page++) {
    const json = (await req(url)) as GraphPage;
    all.push(...(Array.isArray(json.value) ? json.value : []));
    url = typeof json["@odata.nextLink"] === "string" ? json["@odata.nextLink"] : undefined;
  }
  return all;
}

function channelMessagesUrl(teamId: string, channelId: string): string {
  return `${GRAPH_BASE}/teams/${encodeURIComponent(teamId)}/channels/${encodeURIComponent(channelId)}/messages?$top=${TEAMS_GRAPH_PAGE_SIZE}`;
}

function threadRepliesUrl(teamId: string, channelId: string, rootMessageId: string): string {
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
    for (const key of domain.channels ?? []) {
      const parts = key.split("/");
      if (parts.length === 3 && parts[0] === "teams" && parts[2]) ids.add(parts[2]);
    }
  }
  return { ids, domain: domain?.name };
}

function assertTeamsChannelAllowed(ctx: BindableContext, channelId: string): void {
  const p = resolvePartition(ctx);
  const { ids, domain } = allowedTeamsChannelIds(domainKeyOf(p), getConfig().loadDomains());
  if (ids.has(sanitizeTeamsChannelId(channelId))) return;
  const scope = domain ? `domain "${domain}"` : "this channel's (no multi-channel domain)";
  throw new ChannelScopeError(
    `channel "${channelId}" is not in ${scope} teams read scope. The agent may only read channels in its ` +
      `memory domain (memory/domains.ts). Add the channel to the domain's \`channels\` to grant it.`,
  );
}

function currentTeamId(ctx: BindableContext): string | undefined {
  const t = bindFrom(ctx).target;
  return typeof t?.teamId === "string" && t.teamId.length > 0 ? t.teamId : undefined;
}

function noTeamIdError(what: string): Error {
  return new Error(
    `read: couldn't resolve this Teams channel's team id from the live session — Teams ${what} need an engaged team-channel turn.`,
  );
}

export const teamsReadAdapter = {
  platform: "teams" as const,
  async readChannel(ctx: BindableContext, channel: string, limit?: number, req: TeamsGraphRequester = liveTeamsGraphRequest): Promise<readonly TeamsRenderedLine[]> {
    assertTeamsChannelAllowed(ctx, channel);
    const teamId = currentTeamId(ctx);
    if (!teamId) throw noTeamIdError("channel reads");
    const n = limit ?? TEAMS_CHANNEL_DEFAULT_LIMIT;
    const raw = await fetchGraphPages(req, channelMessagesUrl(teamId, channel), n);
    return teamsLinesFromRaw(raw).slice(-n);
  },
  async readThread(ctx: BindableContext, channel: string, threadTs: string, limit?: number, req: TeamsGraphRequester = liveTeamsGraphRequest): Promise<readonly TeamsRenderedLine[]> {
    assertTeamsChannelAllowed(ctx, channel);
    const teamId = currentTeamId(ctx);
    if (!teamId) throw noTeamIdError("thread reads");
    const n = limit ?? TEAMS_THREAD_DEFAULT_LIMIT;
    const raw = await fetchGraphPages(req, threadRepliesUrl(teamId, channel, threadTs), n);
    return teamsLinesFromRaw(raw).slice(-n);
  },
};
