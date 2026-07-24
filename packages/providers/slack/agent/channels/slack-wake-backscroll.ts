import { callSlackApi } from "eve/channels/slack";
import { linesFromMessages, READ_MORE_HINT } from "./slack-context.js";
import {
  renderContext,
  sinceLastAgentReply,
  WAKE_BACKSCROLL_MAX,
  clusterBackscroll,
  type ContextLine,
  type NormalizedMessage,
  type BackscrollTrustFor,
  type WakeMessageInput,
} from "@open-everywhere/core/agent/adapter-api.js";

export { WAKE_BACKSCROLL_MAX };

export interface WakeBotIdentity {
  readonly userId?: string;
  readonly botId?: string;
}

export type SlackRequester = (method: string, params: Record<string, string>) => Promise<Record<string, unknown> | undefined>;

export interface WakeBackscrollInput {
  readonly channelId: string;
  readonly ts: string;
  readonly threadTs?: string;
}

export interface WakeBackscrollDeps {
  readonly request: SlackRequester;
  readonly identity: () => Promise<WakeBotIdentity>;
}

const liveRequest: SlackRequester = async (method, params) => {
  try {
    return (await callSlackApi({ botToken: undefined, operation: method, body: params })) as Record<string, unknown>;
  } catch {
    return undefined;
  }
};

let wakeBotIdentityPromise: Promise<WakeBotIdentity> | undefined;
function liveWakeBotIdentity(): Promise<WakeBotIdentity> {
  if (!wakeBotIdentityPromise) {
    wakeBotIdentityPromise = (async () => {
      const res = await liveRequest("auth.test", {});
      if (res?.ok === true) {
        return {
          userId: typeof res.user_id === "string" ? res.user_id : undefined,
          botId: typeof res.bot_id === "string" ? res.bot_id : undefined,
        };
      }
      return {};
    })();
  }
  return wakeBotIdentityPromise;
}

export function _resetWakeBotIdentity(): void {
  wakeBotIdentityPromise = undefined;
}

const liveDeps: WakeBackscrollDeps = { request: liveRequest, identity: liveWakeBotIdentity };

export interface WakeBackscrollLines {
  readonly lines: readonly ContextLine[];
  readonly source: string;
  readonly readMoreHint: string;
}

export async function fetchWakeBackscrollLines(input: WakeBackscrollInput, deps: WakeBackscrollDeps = liveDeps): Promise<WakeBackscrollLines | null> {
  try {
    const ids = await deps.identity().catch(() => ({} as WakeBotIdentity));
    if (input.threadTs) {
      const res = await deps.request("conversations.replies", {
        channel: input.channelId,
        ts: input.threadTs,
        limit: "100",
      });
      const raw = extractMessages(res);
      if (!raw) return null;
      const priorRaw = raw.filter((m) => (typeof m.ts === "string" ? m.ts : "") !== input.ts);
      const lines = sinceLastAgentReply(linesFromMessages(priorRaw, ids));
      return cappedEntry(lines, `slack thread ${input.channelId}/${input.threadTs}`);
    }
    const res = await deps.request("conversations.history", {
      channel: input.channelId,
      latest: input.ts,
      inclusive: "false",
      limit: String(WAKE_BACKSCROLL_MAX),
    });
    const raw = extractMessages(res);
    if (!raw) return null;
    const lines = linesFromMessages(raw, ids);
    lines.reverse();
    return cappedEntry(lines, `slack channel ${input.channelId}`);
  } catch {
    return null;
  }
}

export async function fetchWakeBackscroll(input: WakeBackscrollInput, deps: WakeBackscrollDeps = liveDeps): Promise<string[]> {
  const res = await fetchWakeBackscrollLines(input, deps);
  if (!res) return [];
  const entry = renderContext(res.lines, res.source, { readMoreHint: res.readMoreHint });
  return entry ? [entry] : [];
}

function extractMessages(res: Record<string, unknown> | undefined): Array<Record<string, unknown>> | undefined {
  if (!res || res.ok !== true || !Array.isArray(res.messages)) return undefined;
  return res.messages as Array<Record<string, unknown>>;
}

function cappedEntry(lines: readonly ContextLine[], source: string): WakeBackscrollLines | null {
  const capped = lines.slice(-WAKE_BACKSCROLL_MAX);
  if (capped.length === 0) return null;
  return { lines: capped, source, readMoreHint: READ_MORE_HINT };
}

export const RAW_FETCH_REACHBACK_HOURS = Number(process.env.OE_SUPERVISOR_BACKSCROLL_REACHBACK_HOURS) || 168;

const RAW_FETCH_PAGE_LIMIT = 200;

const RAW_FETCH_MAX_PAGES = 3;

const MAX_THREADS_ENRICHED = 8;

const THREAD_REPLIES_LIMIT = 100;

export function isBackscrollVisible(line: ContextLine): boolean {
  return (
    line.senderType === "agent" ||
    line.senderType === "user" ||
    (line.senderType === "bot" && line.senderId !== undefined)
  );
}

export interface WakeEnvelopeBackscrollInput {
  readonly channelId: string;
  readonly ts: string;
  readonly reachbackHours?: number;
}

function extractCursor(res: Record<string, unknown> | undefined): string | undefined {
  const meta = res?.response_metadata as { next_cursor?: unknown } | undefined;
  const cursor = meta?.next_cursor;
  return typeof cursor === "string" && cursor.length > 0 ? cursor : undefined;
}

async function fetchChannelWindow(
  request: SlackRequester,
  channelId: string,
  latest: string,
  oldest: string,
): Promise<Array<Record<string, unknown>>> {
  const all: Array<Record<string, unknown>> = [];
  let cursor: string | undefined;
  for (let page = 0; page < RAW_FETCH_MAX_PAGES; page++) {
    const res = await request("conversations.history", {
      channel: channelId,
      latest,
      inclusive: "false",
      oldest,
      limit: String(RAW_FETCH_PAGE_LIMIT),
      ...(cursor ? { cursor } : {}),
    });
    const msgs = extractMessages(res);
    if (!msgs) break;
    all.push(...msgs);
    cursor = extractCursor(res);
    if (!cursor) break;
  }
  return all;
}

async function fetchThreadReplies(
  request: SlackRequester,
  channelId: string,
  channelMsgs: ReadonlyArray<Record<string, unknown>>,
): Promise<Array<{ root: string; msgs: Array<Record<string, unknown>> }>> {
  const roots: string[] = [];
  for (const m of channelMsgs) {
    if (roots.length >= MAX_THREADS_ENRICHED) break;
    const ts = typeof m.ts === "string" ? m.ts : undefined;
    const threadTs = typeof m.thread_ts === "string" ? m.thread_ts : undefined;
    const replyCount = typeof m.reply_count === "number" ? m.reply_count : 0;
    if (ts && replyCount > 0 && (!threadTs || threadTs === ts)) roots.push(ts);
  }
  const out: Array<{ root: string; msgs: Array<Record<string, unknown>> }> = [];
  for (const root of roots) {
    const res = await request("conversations.replies", { channel: channelId, ts: root, limit: String(THREAD_REPLIES_LIMIT) });
    const msgs = extractMessages(res);
    if (msgs) out.push({ root, msgs });
  }
  return out;
}

function normalizeOne(
  m: Record<string, unknown>,
  ids: WakeBotIdentity,
  type: "channel" | "thread",
  threadId: string | undefined,
): NormalizedMessage | undefined {
  const [line] = linesFromMessages([m], ids);
  if (!line) return undefined;
  if (!isBackscrollVisible(line)) return undefined;
  const seconds = Number.parseFloat(line.ts);
  if (!Number.isFinite(seconds)) return undefined;
  return {
    id: line.ts,
    ms: seconds * 1000,
    authorId: line.senderId,
    sender: line.senderType === "agent" ? "self" : line.senderType === "bot" ? "bot" : "human",
    type,
    threadId,
    text: line.text,
  };
}

export async function fetchSlackBackscrollWindow(
  input: WakeEnvelopeBackscrollInput,
  deps: WakeBackscrollDeps = liveDeps,
): Promise<NormalizedMessage[]> {
  try {
    const ids = await deps.identity().catch(() => ({} as WakeBotIdentity));
    const latestSeconds = Number.parseFloat(input.ts);
    if (!Number.isFinite(latestSeconds)) return [];
    const reachbackHours = input.reachbackHours ?? RAW_FETCH_REACHBACK_HOURS;
    const oldestSeconds = latestSeconds - reachbackHours * 3600;
    const oldest = String(oldestSeconds);

    const channelMsgs = await fetchChannelWindow(deps.request, input.channelId, input.ts, oldest);
    if (channelMsgs.length === 0) return [];
    const threadGroups = await fetchThreadReplies(deps.request, input.channelId, channelMsgs);

    const seen = new Set<string>();
    const out: NormalizedMessage[] = [];
    const add = (n: NormalizedMessage | undefined) => {
      if (n && !seen.has(n.id)) {
        seen.add(n.id);
        out.push(n);
      }
    };
    for (const m of channelMsgs) add(normalizeOne(m, ids, "channel", undefined));
    for (const g of threadGroups) {
      for (const m of g.msgs) {
        const ts = typeof m.ts === "string" ? m.ts : "";
        if (ts === g.root) continue;
        const secs = Number.parseFloat(ts);
        if (Number.isFinite(secs) && secs < oldestSeconds) continue;
        add(normalizeOne(m, ids, "thread", g.root));
      }
    }
    return out;
  } catch {
    return [];
  }
}

export async function fetchWakeEnvelopeBackscroll(
  input: WakeEnvelopeBackscrollInput,
  deps: WakeBackscrollDeps = liveDeps,
  trustFor?: BackscrollTrustFor,
): Promise<WakeMessageInput[]> {
  try {
    const window = await fetchSlackBackscrollWindow(input, deps);
    if (window.length === 0) return [];
    const nowMs = Number.parseFloat(input.ts) * 1000;
    return clusterBackscroll(window, nowMs, undefined, trustFor);
  } catch {
    return [];
  }
}
