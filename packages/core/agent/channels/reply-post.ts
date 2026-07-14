import { bindFrom, channelPlatform, type BindableContext } from "../identity/binding.js";
import { capabilitiesForPlatform } from "../identity/capabilities.js";
import { slackForm } from "./slack-events.js";
import { discordPostMessage } from "./discord-post.js";
import { createCommentReply } from "./notion-api.js";
import { sendTelegramMessage } from "eve/channels/telegram";
import { sendTeamsActivity } from "eve/channels/teams";
import { createLinearAgentActivity } from "eve/channels/linear";

export type ReplyTarget =
  | { readonly platform: "slack"; readonly channelId: string; readonly threadTs?: string }
  | { readonly platform: "discord"; readonly channelId: string }
  | { readonly platform: "notion"; readonly discussionId: string }
  | { readonly platform: "telegram"; readonly chatId: string; readonly messageThreadId?: number }
  | { readonly platform: "teams"; readonly serviceUrl: string; readonly conversationId: string }
  | { readonly platform: "linear"; readonly agentSessionId: string };

export function resolveReplyTarget(ctx: BindableContext): ReplyTarget | null {
  const platform = channelPlatform(ctx);
  if (!capabilitiesForPlatform(platform).midTurnPost) return null;
  const t = bindFrom(ctx).target;
  const str = (k: string): string | undefined => (typeof t?.[k] === "string" && (t[k] as string).length > 0 ? (t[k] as string) : undefined);
  const num = (k: string): number | undefined => (typeof t?.[k] === "number" ? (t[k] as number) : undefined);
  switch (platform) {
    case "slack": {
      const channelId = str("channelId");
      return channelId ? { platform: "slack", channelId, threadTs: bindFrom(ctx).threadTs } : null;
    }
    case "discord": {
      const channelId = str("channelId");
      return channelId ? { platform: "discord", channelId } : null;
    }
    case "notion": {
      const discussionId = str("discussionId");
      return discussionId ? { platform: "notion", discussionId } : null;
    }
    case "telegram": {
      const chatId = str("chatId");
      if (!chatId) return null;
      const messageThreadId = num("messageThreadId");
      return { platform: "telegram", chatId, ...(messageThreadId !== undefined ? { messageThreadId } : {}) };
    }
    case "teams": {
      const serviceUrl = str("serviceUrl");
      const conversationId = str("conversationId");
      return serviceUrl && conversationId ? { platform: "teams", serviceUrl, conversationId } : null;
    }
    case "linear": {
      const agentSessionId = str("agentSessionId");
      return agentSessionId ? { platform: "linear", agentSessionId } : null;
    }
    default:
      return null;
  }
}

export async function postReply(target: ReplyTarget, text: string): Promise<string> {
  if (process.env.OE_EGRESS_SPOOF === "1") {
    if (process.env.VERCEL) throw new Error("OE_EGRESS_SPOOF is a local-eval flag — refusing on Vercel.");
    console.warn(`[oe] OE_EGRESS_SPOOF: swallowed a ${target.platform} reply (${text.length}c)`);
    return `spoof-${target.platform}-${Date.now()}`;
  }
  if (target.platform === "slack") {
    const body = new URLSearchParams({ channel: target.channelId, text });
    if (target.threadTs) body.set("thread_ts", target.threadTs);
    const res = await slackForm("chat.postMessage", body.toString());
    const ts = typeof res?.ts === "string" ? res.ts : undefined;
    if (res?.ok !== true || !ts) {
      throw new Error(`reply couldn't post to Slack — ${(res?.error as string) ?? "no ts returned (check SLACK_BOT_TOKEN)"}`);
    }
    return ts;
  }
  if (target.platform === "discord") {
    return discordPostMessage(target.channelId, text);
  }
  if (target.platform === "notion") {
    const apiKey = process.env.NOTION_API_KEY;
    if (!apiKey || apiKey.length === 0) {
      throw new Error("reply couldn't post to Notion — NOTION_API_KEY is not set.");
    }
    return createCommentReply({ discussionId: target.discussionId, text, apiKey });
  }
  if (target.platform === "telegram") {
    if (!process.env.TELEGRAM_BOT_TOKEN) {
      throw new Error("reply couldn't post to Telegram — TELEGRAM_BOT_TOKEN is not set.");
    }
    const res = await sendTelegramMessage({
      chatId: target.chatId,
      body: { text, ...(target.messageThreadId !== undefined ? { message_thread_id: target.messageThreadId } : {}) },
    });
    return res.id;
  }
  if (target.platform === "teams") {
    if (!process.env.MICROSOFT_APP_ID && !process.env.TEAMS_APP_ID) {
      throw new Error("reply couldn't post to Teams — MICROSOFT_APP_ID is not set.");
    }
    const res = await sendTeamsActivity({
      serviceUrl: target.serviceUrl,
      conversationId: target.conversationId,
      body: { type: "message", text },
    });
    return res.id;
  }
  const res = await createLinearAgentActivity({
    activity: { agentSessionId: target.agentSessionId, content: { body: text, type: "response" } },
  });
  return res.id;
}

