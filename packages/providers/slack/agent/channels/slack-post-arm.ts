import { slackForm } from "./slack-events.js";
import type {
  PostArm,
  TargetResolveBag,
  ReplyTarget,
  UnifiedWakeOrigin,
  UnifiedReplyDeps,
  DirectMessageRequest,
  DirectMessageDelivery,
} from "@open-everywhere/core/agent/adapter-api.js";

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

async function deliverSlackDirectMessage(input: DirectMessageRequest): Promise<DirectMessageDelivery> {
  const opened = await slackForm("conversations.open", new URLSearchParams({ users: input.principalId }).toString());
  const channel = opened?.channel as { id?: unknown } | undefined;
  const dmChannelId = typeof channel?.id === "string" ? channel.id : undefined;
  if (opened?.ok !== true || !dmChannelId) {
    throw new Error(
      `couldn't open a Slack DM with the requester — ${(opened?.error as string) ?? "no channel returned (check SLACK_BOT_TOKEN and the im:write bot scope)"}`,
    );
  }
  const posted = await slackForm("chat.postMessage", new URLSearchParams({ channel: dmChannelId, text: input.text }).toString());
  const ts = typeof posted?.ts === "string" ? posted.ts : undefined;
  if (posted?.ok !== true || !ts) {
    throw new Error(`couldn't post the Slack DM — ${(posted?.error as string) ?? "no ts returned (check SLACK_BOT_TOKEN)"}`);
  }
  return { surfaceId: dmChannelId, messageId: ts };
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
  deliverDirectMessage: deliverSlackDirectMessage,
};
