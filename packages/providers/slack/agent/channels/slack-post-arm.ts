import { slackForm } from "./slack-events.js";
import type { PostArm, TargetResolveBag, ReplyTarget, UnifiedWakeOrigin, UnifiedReplyDeps } from "@open-everywhere/core/agent/adapter-api.js";

type SlackTarget = Extract<ReplyTarget, { platform: "slack" }>;
type SlackOrigin = Extract<UnifiedWakeOrigin, { platform: "slack" }>;

async function dispatchSlackReply(target: SlackTarget, text: string): Promise<string> {
  const body = new URLSearchParams({ channel: target.channelId, text });
  if (target.threadTs) body.set("thread_ts", target.threadTs);
  const res = await slackForm("chat.postMessage", body.toString());
  const ts = typeof res?.ts === "string" ? res.ts : undefined;
  if (res?.ok !== true || !ts) {
    throw new Error(`reply couldn't post to Slack — ${(res?.error as string) ?? "no ts returned (check SLACK_BOT_TOKEN)"}`);
  }
  return ts;
}

async function liveSlackPost(origin: SlackOrigin, text: string): Promise<string> {
  const body = new URLSearchParams({ channel: origin.channelId, text });
  const threadTarget = origin.threadTs ?? origin.replyAnchorTs;
  if (threadTarget) body.set("thread_ts", threadTarget);
  const res = await slackForm("chat.postMessage", body.toString());
  const ts = typeof res?.ts === "string" ? res.ts : undefined;
  if (res?.ok !== true || !ts) {
    throw new Error(`unified reply couldn't post to Slack — ${(res?.error as string) ?? "no ts returned (check SLACK_BOT_TOKEN)"}`);
  }
  return ts;
}

export const slackPostArm: PostArm = {
  platform: "slack",
  resolveTarget: (bag: TargetResolveBag): ReplyTarget | null => {
    const channelId = bag.str("channelId");
    return channelId ? { platform: "slack", channelId, threadTs: bag.threadTs } : null;
  },
  dispatchReply: (target, text) => dispatchSlackReply(target as SlackTarget, text),
  dispatchUnified: (origin, text, deps: UnifiedReplyDeps) => (deps.postSlack ?? liveSlackPost)(origin as SlackOrigin, text),
  describeRedriveTarget: (origin) => {
    const o = origin as SlackOrigin;
    return `slack ${o.threadTs ? `thread in ${o.channelId}` : `channel ${o.channelId}`}`;
  },
  redriveContainerId: (origin) => (origin as SlackOrigin).channelId,
};
