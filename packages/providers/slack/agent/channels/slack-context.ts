import type { SlackContext } from "eve/channels/slack";
import { loadThreadContextMessages } from "eve/channels/slack";
import type { SlackMessage } from "eve/channels/slack";
import { MAX_MESSAGES, renderContext, type ContextLine } from "@open-everywhere/core/agent/adapter-api.js";

export { renderContext, type ContextLine };

export function readMoreHint(): string {
  return (
    "Note: the block above is the most recent messages only, capped for context size — there may " +
    "be older history not shown. If you need it, fetch more with the read_channel or read_thread tool."
  );
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
    const entry = renderContext(lines, `slack thread ${message.channelId}/${message.threadTs}`, { readMoreHint: readMoreHint() });
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
    const entry = renderContext(lines, `slack channel ${message.channelId}`, { readMoreHint: readMoreHint() });
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
