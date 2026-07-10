import { bindFrom, channelPlatform, type BindableContext } from "../identity/binding.js";
import { capabilitiesForPlatform } from "../identity/capabilities.js";
import { slackForm } from "./slack-events.js";
import { discordPostMessage, discordEditMessage } from "./discord-post.js";
import { createCommentReply } from "./notion-api.js";

export type ReplyTarget =
  | { readonly platform: "slack"; readonly channelId: string; readonly threadTs?: string }
  | { readonly platform: "discord"; readonly channelId: string }
  | { readonly platform: "notion"; readonly discussionId: string };

export function resolveReplyTarget(ctx: BindableContext): ReplyTarget | null {
  const platform = channelPlatform(ctx);
  if (!capabilitiesForPlatform(platform).midTurnPost) return null;
  const binding = bindFrom(ctx);
  if (platform === "notion") {
    const discussionId = typeof binding.target?.discussionId === "string" ? binding.target.discussionId : undefined;
    return discussionId ? { platform: "notion", discussionId } : null;
  }
  const channelId = typeof binding.target?.channelId === "string" ? binding.target.channelId : undefined;
  if (!channelId) return null;
  if (platform === "slack") {
    return { platform: "slack", channelId, threadTs: binding.threadTs };
  }
  return { platform: "discord", channelId };
}

export async function postReply(target: ReplyTarget, text: string): Promise<string> {
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
  const apiKey = process.env.NOTION_API_KEY;
  if (!apiKey || apiKey.length === 0) {
    throw new Error("reply couldn't post to Notion — NOTION_API_KEY is not set.");
  }
  return createCommentReply({ discussionId: target.discussionId, text, apiKey });
}

export async function editReply(target: ReplyTarget, id: string, text: string): Promise<void> {
  if (target.platform === "slack") {
    const res = await slackForm("chat.update", new URLSearchParams({ channel: target.channelId, ts: id, text }).toString());
    if (res?.ok !== true) {
      throw new Error(`update_reply couldn't edit the Slack message — ${(res?.error as string) ?? "unknown error (check the id and SLACK_BOT_TOKEN)"}`);
    }
    return;
  }
  if (target.platform === "discord") {
    await discordEditMessage(target.channelId, id, text);
    return;
  }
  throw new Error("update_reply isn't available on Notion — it has no silent-edit primitive.");
}
