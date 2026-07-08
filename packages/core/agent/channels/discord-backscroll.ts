import { renderContext, sinceLastAgentReply, WAKE_BACKSCROLL_MAX, type ContextLine } from "./context-render.js";

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

function extractDiscordMessages(res: unknown): Array<Record<string, unknown>> | undefined {
  if (!Array.isArray(res)) return undefined;
  return res as Array<Record<string, unknown>>;
}

export async function fetchDiscordBackscroll(input: DiscordBackscrollInput, deps: DiscordBackscrollDeps = liveDeps): Promise<string[]> {
  try {
    const res = await deps.request(input.channelId, {
      limit: String(WAKE_BACKSCROLL_MAX),
      before: input.triggerMessageId,
    });
    const raw = extractDiscordMessages(res);
    if (!raw) return [];
    const ordered = [...raw].reverse();
    let lines = linesFromDiscordMessages(ordered, input.botId);
    if (input.isThread) lines = sinceLastAgentReply(lines);
    const capped = lines.slice(-WAKE_BACKSCROLL_MAX);
    const entry = renderContext(capped, `discord ${input.isThread ? "thread" : "channel"} ${input.channelId}`);
    return entry ? [entry] : [];
  } catch {
    return [];
  }
}
