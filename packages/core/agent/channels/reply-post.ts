import { bindFrom, channelPlatform, type BindableContext } from "../identity/binding.js";
import { slackForm } from "./slack-events.js";
import { discordPostMessage, discordEditMessage } from "./discord-post.js";

export interface ReplyTarget {
  readonly platform: "slack" | "discord";
  readonly channelId: string;
  readonly threadTs?: string;
}

export function resolveReplyTarget(ctx: BindableContext): ReplyTarget | null {
  const platform = channelPlatform(ctx);
  if (platform !== "slack" && platform !== "discord") return null;
  const binding = bindFrom(ctx);
  const channelId = typeof binding.target?.channelId === "string" ? binding.target.channelId : undefined;
  if (!channelId) return null;
  const threadTs = platform === "slack" ? binding.threadTs : undefined;
  return { platform, channelId, threadTs };
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
  return discordPostMessage(target.channelId, text);
}

export async function editReply(target: ReplyTarget, id: string, text: string): Promise<void> {
  if (target.platform === "slack") {
    const res = await slackForm("chat.update", new URLSearchParams({ channel: target.channelId, ts: id, text }).toString());
    if (res?.ok !== true) {
      throw new Error(`update_reply couldn't edit the Slack message — ${(res?.error as string) ?? "unknown error (check the id and SLACK_BOT_TOKEN)"}`);
    }
    return;
  }
  await discordEditMessage(target.channelId, id, text);
}
