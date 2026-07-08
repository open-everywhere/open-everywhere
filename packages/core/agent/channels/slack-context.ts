import type { SlackContext } from "eve/channels/slack";
import { loadThreadContextMessages } from "eve/channels/slack";
import type { SlackMessage } from "eve/channels/slack";
import { wrapUntrusted } from "../access/untrusted.js";

const MAX_MESSAGES = 50;
const MAX_CHARS = 12_000;

type SenderType = "user" | "bot" | "agent" | "unknown";

export interface ContextLine {
  readonly senderType: SenderType;
  readonly senderId?: string;
  readonly ts: string;
  readonly text: string;
}

function attribution(l: ContextLine): string {
  if (l.senderType === "agent") return "[sender_type=agent]";
  if (l.senderId) return `[sender_type=${l.senderType} sender_id=${l.senderId}]`;
  return `[sender_type=${l.senderType}]`;
}

export function linesFromMessages(
  raw: ReadonlyArray<Record<string, unknown>>,
  ids: { readonly userId?: string; readonly botId?: string },
): ContextLine[] {
  const lines: ContextLine[] = [];
  for (const m of raw) {
    if (typeof m.subtype === "string" && m.subtype.length > 0) continue;
    const text = typeof m.text === "string" ? m.text : "";
    if (!text) continue;
    const user = typeof m.user === "string" ? m.user : undefined;
    const botId = typeof m.bot_id === "string" ? m.bot_id : undefined;
    const ts = (m.ts as string) ?? "";
    const isMe = (ids.userId !== undefined && user === ids.userId) || (ids.botId !== undefined && botId === ids.botId);
    if (isMe) lines.push({ senderType: "agent", ts, text });
    else if (botId) lines.push({ senderType: "bot", senderId: botId, ts, text });
    else if (user) lines.push({ senderType: "user", senderId: user, ts, text });
    else lines.push({ senderType: "unknown", ts, text });
  }
  return lines;
}

export function renderContext(lines: readonly ContextLine[], source: string): string | null {
  const kept: string[] = [];
  let chars = 0;
  for (let i = lines.length - 1; i >= 0 && kept.length < MAX_MESSAGES; i--) {
    const l = lines[i];
    const text = l.text.trim();
    if (!text) continue;
    const rendered = `${attribution(l)} ${text}`;
    if (chars + rendered.length > MAX_CHARS && kept.length > 0) break;
    chars += rendered.length;
    kept.unshift(rendered);
  }
  if (kept.length === 0) return null;
  const body = `Recent conversation (oldest first), for context:\n${kept.join("\n")}`;
  return wrapUntrusted(body, { source });
}

let botIdentityCache: Promise<{ userId?: string; botId?: string }> | undefined;

async function botIdentity(ctx: SlackContext): Promise<{ userId?: string; botId?: string }> {
  if (!botIdentityCache) {
    botIdentityCache = (async () => {
      try {
        const res = await ctx.slack.request("auth.test", {});
        if (res.ok) {
          const r = res as unknown as { user_id?: string; bot_id?: string };
          return { userId: r.user_id, botId: r.bot_id };
        }
      } catch {
      }
      return {};
    })();
  }
  return botIdentityCache;
}

export function _resetBotIdentityCache(): void {
  botIdentityCache = undefined;
}

async function threadContext(ctx: SlackContext, message: SlackMessage): Promise<string[]> {
  try {
    const msgs = await loadThreadContextMessages(
      ctx.thread,
      { ts: message.ts, threadTs: message.threadTs },
      { since: "last-agent-reply" },
    );
    const lines: ContextLine[] = msgs.map((m) => {
      if (m.isMe) return { senderType: "agent" as const, ts: m.ts, text: m.markdown || m.text };
      if (m.botId) return { senderType: "bot" as const, senderId: m.botId, ts: m.ts, text: m.markdown || m.text };
      if (m.user) return { senderType: "user" as const, senderId: m.user, ts: m.ts, text: m.markdown || m.text };
      return { senderType: "unknown" as const, ts: m.ts, text: m.markdown || m.text };
    });
    const entry = renderContext(lines, `slack thread ${message.channelId}/${message.threadTs}`);
    return entry ? [entry] : [];
  } catch {
    return [];
  }
}

async function channelBackscroll(ctx: SlackContext, message: SlackMessage): Promise<string[]> {
  try {
    const res = await ctx.slack.request("conversations.history", {
      channel: message.channelId,
      latest: message.ts,
      inclusive: false,
      limit: MAX_MESSAGES,
    });
    if (!res.ok || !Array.isArray((res as { messages?: unknown }).messages)) return [];
    const raw = (res as unknown as { messages: Array<Record<string, unknown>> }).messages;
    const { userId: meUser, botId: meBot } = await botIdentity(ctx);
    const lines = linesFromMessages(raw, { userId: meUser, botId: meBot });
    lines.reverse();
    const entry = renderContext(lines, `slack channel ${message.channelId}`);
    return entry ? [entry] : [];
  } catch {
    return [];
  }
}

export async function loadConversationContext(ctx: SlackContext, message: SlackMessage): Promise<string[]> {
  return message.threadTs && message.threadTs !== message.ts
    ? threadContext(ctx, message)
    : channelBackscroll(ctx, message);
}
