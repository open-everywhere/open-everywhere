import type { BotAskProbe, BotAskProbeAnswer, BotReplyFacts } from "@open-everywhere/core/agent/adapter-api.js";
import { encodeSlackForm } from "./slack-web-api.js";
import type { ParsedMessageEvent } from "./slack-events.js";

export interface SlackBotAskDeps {
  readonly call: (method: string, body: Record<string, string>) => Promise<Record<string, unknown> | undefined>;
  readonly self: () => Promise<{ readonly userId?: string; readonly botId?: string }>;
}

type SlackMessage = { readonly ts?: unknown; readonly thread_ts?: unknown; readonly user?: unknown; readonly text?: unknown };

export function mentionsUser(text: string, userId: string): boolean {
  return text.includes(`<@${userId}>`) || text.includes(`<@${userId}|`);
}

export function slackBotAskProbe(deps: SlackBotAskDeps): BotAskProbe {
  return async (q): Promise<BotAskProbeAnswer> => {
    try {
      const [platform, teamId] = q.workspaceKey.split("/");
      if (platform !== "slack" || !teamId) return { ok: false, reason: "unreadable" };
      const replies = await deps.call("conversations.replies", { channel: q.channel, ts: q.messageTs, limit: "1", inclusive: "true" });
      const messages = replies?.ok === true && Array.isArray(replies.messages) ? (replies.messages as SlackMessage[]) : [];
      const msg = messages.find((m) => m.ts === q.messageTs);
      if (!msg) return { ok: false, reason: "unreadable" };
      if (msg.user !== q.personId) return { ok: false, reason: "not-yours" };
      const text = typeof msg.text === "string" ? msg.text : "";
      if (!mentionsUser(text, q.bot)) return { ok: false, reason: "bot-not-named" };
      const self = await deps.self().catch(() => ({}) as { userId?: string; botId?: string });
      if (self.userId === undefined) return { ok: false, reason: "unreadable" };
      if (self.userId === q.bot) return { ok: false, reason: "self" };
      const info = await deps.call("users.info", { user: q.bot });
      const user = info?.ok === true && info.user && typeof info.user === "object" ? (info.user as Record<string, unknown>) : undefined;
      if (!user) return { ok: false, reason: "unreadable" };
      if (user.is_bot !== true) return { ok: false, reason: "not-a-bot" };
      const profile = user.profile && typeof user.profile === "object" ? (user.profile as Record<string, unknown>) : {};
      const botId = typeof profile.bot_id === "string" && profile.bot_id.length > 0 ? profile.bot_id : undefined;
      if (botId !== undefined && self.botId !== undefined && botId === self.botId) return { ok: false, reason: "self" };
      const label = [user.real_name, profile.display_name, user.name].find((v) => typeof v === "string" && v.trim().length > 0) as string | undefined;
      return {
        ok: true,
        threadTs: typeof msg.thread_ts === "string" && msg.thread_ts.length > 0 ? msg.thread_ts : q.messageTs,
        botUserId: q.bot,
        ...(botId === undefined ? {} : { botId }),
        ...(label === undefined ? {} : { botLabel: label }),
        askText: text,
      };
    } catch {
      return { ok: false, reason: "unreadable" };
    }
  };
}

export function liveSlackBotAskDeps(
  form: (method: string, body: string) => Promise<Record<string, unknown> | undefined>,
  self: () => Promise<{ readonly userId?: string; readonly botId?: string }>,
): SlackBotAskDeps {
  return { call: (method, body) => form(method, encodeSlackForm(body)), self };
}

export function botReplyCandidate(ev: ParsedMessageEvent): boolean {
  return (Boolean(ev.botId) || ev.subtype === "bot_message") && ev.threadTs !== undefined && ev.threadTs !== ev.ts;
}

export function slackBotReplyFacts(ev: ParsedMessageEvent, org: string, self: { readonly userId?: string; readonly botId?: string }): BotReplyFacts {
  return {
    org,
    platform: "slack",
    workspace: ev.teamId,
    channel: ev.channelId,
    threadTs: ev.threadTs,
    messageTs: ev.ts,
    authorUserId: ev.userId,
    authorBotId: ev.botId,
    subtype: ev.subtype,
    ...(self.userId === undefined ? {} : { selfUserId: self.userId }),
    ...(self.botId === undefined ? {} : { selfBotId: self.botId }),
  };
}
