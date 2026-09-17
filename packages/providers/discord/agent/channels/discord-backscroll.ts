import {
  sinceLastAgentReply,
  WAKE_BACKSCROLL_MAX,
  fetchedBackscroll,
  resolveWakeTrustFromContext,
  armedAuthorTrustTenants,
  catchUpSender,
  type ContextLine,
  type NormalizedMessage,
  type BackscrollTrustFor,
  type SeatCatchUpFetch,
  type SeatCatchUpRequest,
  type WakeMessageInput,
  type BindableContext,
  type AuthorTrustQuery,
} from "@open-everywhere/core/agent/adapter-api.js";
import { discordAuthorRoles } from "../approvals/discord-admin.js";

export interface DiscordBackscrollInput {
  readonly channelId: string;
  readonly triggerMessageId: string;
  readonly isThread: boolean;
  readonly botId?: string;
}

export type DiscordRequester = (channelId: string, query: Record<string, string>) => Promise<unknown>;

export interface DiscordBackscrollDeps {
  readonly request: DiscordRequester;
}

const liveRequest: DiscordRequester = async (channelId, query) => {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token || !channelId) return undefined;
  try {
    const qs = new URLSearchParams(query).toString();
    const res = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages?${qs}`, {
      headers: { authorization: `Bot ${token}` },
    });
    if (!res.ok) return undefined;
    return await res.json();
  } catch {
    return undefined;
  }
};

const liveDeps: DiscordBackscrollDeps = { request: liveRequest };

function isConversationType(type: unknown): boolean {
  return type === 0 || type === 19;
}

export function linesFromDiscordMessages(raw: ReadonlyArray<Record<string, unknown>>, botId?: string): ContextLine[] {
  const lines: ContextLine[] = [];
  for (const m of raw) {
    if (!isConversationType(m.type)) continue;
    const text = typeof m.content === "string" ? m.content : "";
    if (!text) continue;
    const author = typeof m.author === "object" && m.author !== null ? (m.author as Record<string, unknown>) : undefined;
    const authorId = author && typeof author.id === "string" ? author.id : undefined;
    const isBot = author?.bot === true;
    const id = typeof m.id === "string" ? m.id : "";
    if (botId !== undefined && authorId === botId) lines.push({ senderType: "agent", ts: id, text });
    else if (isBot && authorId) lines.push({ senderType: "bot", senderId: authorId, ts: id, text });
    else if (authorId) lines.push({ senderType: "user", senderId: authorId, ts: id, text });
    else lines.push({ senderType: "unknown", ts: id, text });
  }
  return lines;
}

export type DiscordRoleProbe = (guildId: string, userId: string) => Promise<readonly string[] | undefined>;

export async function gradeDiscordContextLines(
  lines: readonly ContextLine[],
  ctx: BindableContext,
  guildId: string | undefined,
  roleProbe: DiscordRoleProbe = discordAuthorRoles,
): Promise<ContextLine[]> {
  const withTrust = lines.map((l): ContextLine =>
    l.senderType !== "user" ? l : { ...l, trust: resolveWakeTrustFromContext(ctx, { id: l.senderId, isBot: false }) },
  );
  const tenantKey = guildId !== undefined ? `discord/${guildId}` : undefined;
  if (tenantKey === undefined || !armedAuthorTrustTenants().includes(tenantKey)) return withTrust;

  const candidates = new Set<string>();
  for (const l of withTrust) {
    if (l.senderType === "user" && l.senderId !== undefined) candidates.add(l.senderId);
  }
  if (candidates.size === 0) return withTrust;
  const ids = [...candidates];
  const roleResults = await Promise.all(ids.map((id) => roleProbe(guildId!, id)));
  const rolesById = new Map(ids.map((id, i) => [id, roleResults[i]] as const));

  return withTrust.map((l) => {
    if (l.senderType !== "user" || l.senderId === undefined) return l;
    const roles = rolesById.get(l.senderId);
    if (roles === undefined) return l;
    const authorTrust: AuthorTrustQuery = {
      tenantKey,
      authorId: l.senderId,
      memberships: roles.map((r) => `${tenantKey}/role:${r}`),
    };
    return { ...l, authorTrust };
  });
}

function extractDiscordMessages(res: unknown): Array<Record<string, unknown>> | undefined {
  if (!Array.isArray(res)) return undefined;
  return res as Array<Record<string, unknown>>;
}

export async function fetchDiscordBackscrollLines(
  input: DiscordBackscrollInput,
  deps: DiscordBackscrollDeps = liveDeps,
): Promise<{ readonly lines: ContextLine[]; readonly source: string } | undefined> {
  try {
    const res = await deps.request(input.channelId, {
      limit: String(WAKE_BACKSCROLL_MAX),
      before: input.triggerMessageId,
    });
    const raw = extractDiscordMessages(res);
    if (!raw) return undefined;
    const ordered = [...raw].reverse();
    let lines = linesFromDiscordMessages(ordered, input.botId);
    if (input.isThread) lines = sinceLastAgentReply(lines);
    const capped = lines.slice(-WAKE_BACKSCROLL_MAX);
    if (capped.length === 0) return undefined;
    return { lines: capped, source: `discord ${input.isThread ? "thread" : "channel"} ${input.channelId}` };
  } catch {
    return undefined;
  }
}

export const DISCORD_RAW_FETCH_REACHBACK_HOURS = Number(process.env.OE_SUPERVISOR_BACKSCROLL_REACHBACK_HOURS) || 168;

const DISCORD_RAW_FETCH_PAGE_LIMIT = 100;

const DISCORD_RAW_FETCH_MAX_PAGES = 3;

const DISCORD_EPOCH_MS = 1_420_070_400_000;

export function snowflakeToMs(id: string): number | undefined {
  try {
    const n = BigInt(id);
    if (n <= 0n) return undefined;
    return Number(n >> 22n) + DISCORD_EPOCH_MS;
  } catch {
    return undefined;
  }
}

function msToSnowflake(ms: number): string {
  const delta = Math.max(0, Math.floor(ms) - DISCORD_EPOCH_MS);
  const id = BigInt(delta) << 22n;
  return (id > 0n ? id : 1n).toString();
}

function messageMs(m: Record<string, unknown>, id: string): number | undefined {
  const iso = typeof m.timestamp === "string" ? Date.parse(m.timestamp) : Number.NaN;
  if (Number.isFinite(iso)) return iso;
  return snowflakeToMs(id);
}

export function isDiscordBackscrollVisible(line: ContextLine): boolean {
  return (
    line.senderType === "agent" ||
    line.senderType === "user" ||
    (line.senderType === "bot" && line.senderId !== undefined)
  );
}

function normalizeDiscordMessage(
  m: Record<string, unknown>,
  botId: string | undefined,
  type: "channel" | "thread",
  threadId: string | undefined,
): NormalizedMessage | undefined {
  const [line] = linesFromDiscordMessages([m], botId);
  if (!line) return undefined;
  if (!isDiscordBackscrollVisible(line)) return undefined;
  const ms = messageMs(m, line.ts);
  if (ms === undefined) return undefined;
  return {
    id: line.ts,
    ms,
    authorId: line.senderId,
    sender: catchUpSender({ self: line.senderType === "agent", bot: line.senderType === "bot" }),
    type,
    threadId,
    text: line.text,
  };
}

async function fetchDiscordWindow(
  request: DiscordRequester,
  channelId: string,
  triggerMessageId: string,
  oldestMs: number,
): Promise<Array<Record<string, unknown>>> {
  const all: Array<Record<string, unknown>> = [];
  let before = triggerMessageId;
  for (let page = 0; page < DISCORD_RAW_FETCH_MAX_PAGES; page++) {
    const res = await request(channelId, { limit: String(DISCORD_RAW_FETCH_PAGE_LIMIT), before });
    const msgs = extractDiscordMessages(res);
    if (!msgs || msgs.length === 0) break;
    all.push(...msgs);
    const oldest = msgs[msgs.length - 1];
    const oldestId = typeof oldest.id === "string" ? oldest.id : undefined;
    if (!oldestId) break;
    const oldestMsThisPage = messageMs(oldest, oldestId);
    if (oldestMsThisPage !== undefined && oldestMsThisPage < oldestMs) break;
    if (msgs.length < DISCORD_RAW_FETCH_PAGE_LIMIT) break;
    before = oldestId;
  }
  return all;
}

export interface DiscordBackscrollWindowInput {
  readonly channelId: string;
  readonly triggerMessageId: string;
  readonly isThread: boolean;
  readonly botId?: string;
  readonly reachbackHours?: number;
  readonly sinceMs?: number;
}

export async function fetchDiscordBackscrollWindow(
  input: DiscordBackscrollWindowInput,
  deps: DiscordBackscrollDeps = liveDeps,
  failureMode: "soft" | "throw" = "soft",
): Promise<NormalizedMessage[]> {
  try {
    const triggerMs = snowflakeToMs(input.triggerMessageId);
    const reachbackHours = input.reachbackHours ?? DISCORD_RAW_FETCH_REACHBACK_HOURS;
    const originMs = triggerMs ?? Date.now();
    const floorMs = originMs - reachbackHours * 3_600_000;
    const oldestMs = typeof input.sinceMs === "number" && Number.isFinite(input.sinceMs) ? Math.max(floorMs, input.sinceMs) : floorMs;

    const raw = await fetchDiscordWindow(deps.request, input.channelId, input.triggerMessageId, oldestMs);
    if (raw.length === 0) return [];

    const type: "channel" | "thread" = input.isThread ? "thread" : "channel";
    const threadId = input.isThread ? input.channelId : undefined;
    const seen = new Set<string>();
    const out: NormalizedMessage[] = [];
    for (const m of raw) {
      const n = normalizeDiscordMessage(m, input.botId, type, threadId);
      if (!n) continue;
      if (n.ms < oldestMs) continue;
      if (seen.has(n.id)) continue;
      seen.add(n.id);
      out.push(n);
    }
    return out;
  } catch (err) {
    if (failureMode === "throw") throw err;
    return [];
  }
}

export async function fetchDiscordWakeEnvelopeBackscroll(
  input: DiscordBackscrollWindowInput,
  deps: DiscordBackscrollDeps = liveDeps,
  trustFor?: BackscrollTrustFor,
): Promise<WakeMessageInput[]> {
  try {
    const window = await fetchDiscordBackscrollWindow(input, deps);
    if (window.length === 0) return [];
    return fetchedBackscroll(window, undefined, trustFor);
  } catch {
    return [];
  }
}

export async function fetchDiscordSeatCatchUp(req: SeatCatchUpRequest, deps: DiscordBackscrollDeps = liveDeps): Promise<readonly NormalizedMessage[]> {
  const isThread = req.threadRoot !== undefined;
  const anchor = req.threadRoot ?? req.container;
  const triggerMessageId = req.excludeId ?? msToSnowflake(req.untilMs ?? Date.now());
  const strictDeps: DiscordBackscrollDeps = {
    request: async (channelId, query) => {
      const res = await deps.request(channelId, query);
      if (!Array.isArray(res)) throw new Error("Discord catch-up request failed");
      return res;
    },
  };
  return fetchDiscordBackscrollWindow({ channelId: anchor, triggerMessageId, isThread, sinceMs: req.sinceMs }, strictDeps, "throw");
}

export const DISCORD_TIMESTAMP_PRECISION_MS = 1;

export const discordSeatCatchUpFetch: SeatCatchUpFetch = (req) => fetchDiscordSeatCatchUp(req);
