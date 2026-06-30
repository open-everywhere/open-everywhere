import type { SlackContext } from "eve/channels/slack";
import { loadThreadContextMessages } from "eve/channels/slack";
import type { SlackMessage } from "eve/channels/slack";
import { wrapUntrusted } from "../access/untrusted.js";

const MAX_MESSAGES = 50;
const MAX_CHARS = 12_000;

interface ContextLine {
  readonly author: string;
  readonly ts: string;
  readonly text: string;
  readonly isMe: boolean;
}

function renderContext(lines: readonly ContextLine[], source: string): string | null {
  const kept: string[] = [];
  let chars = 0;
  for (let i = lines.length - 1; i >= 0 && kept.length < MAX_MESSAGES; i--) {
    const l = lines[i];
    const text = l.text.trim();
    if (!text) continue;
    const who = l.isMe ? "you (the agent)" : l.author;
    const rendered = `[${who}] ${text}`;
    if (chars + rendered.length > MAX_CHARS && kept.length > 0) break;
    chars += rendered.length;
    kept.unshift(rendered);
  }
  if (kept.length === 0) return null;
  const body = `Recent conversation (oldest first), for context:\n${kept.join("\n")}`;
  return wrapUntrusted(body, { source });
}

async function threadContext(ctx: SlackContext, message: SlackMessage): Promise<string[]> {
  try {
    const msgs = await loadThreadContextMessages(
      ctx.thread,
      { ts: message.ts, threadTs: message.threadTs },
      { since: "last-agent-reply" },
    );
    const lines: ContextLine[] = msgs.map((m) => ({
      author: m.user ?? m.botId ?? "(unknown)",
      ts: m.ts,
      text: m.markdown || m.text,
      isMe: m.isMe,
    }));
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
    const lines: ContextLine[] = [];
    for (const m of raw) {
      if (typeof m.subtype === "string" && m.subtype.length > 0) continue;
      const text = typeof m.text === "string" ? m.text : "";
      if (!text) continue;
      lines.push({
        author: (m.user as string) ?? (m.bot_id as string) ?? "(unknown)",
        ts: (m.ts as string) ?? "",
        text,
        isMe: false,
      });
    }
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
