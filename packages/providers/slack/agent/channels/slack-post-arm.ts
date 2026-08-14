import { slackForm, botDisplayName } from "./slack-events.js";
import type {
  PostArm,
  TargetResolveBag,
  ReplyTarget,
  ReplierLabel,
  UnifiedWakeOrigin,
  UnifiedReplyDeps,
  DirectMessageRequest,
  DirectMessageDelivery,
} from "@open-everywhere/core/agent/adapter-api.js";

type SlackTarget = Extract<ReplyTarget, { platform: "slack" }>;
type SlackOrigin = Extract<UnifiedWakeOrigin, { platform: "slack" }>;

export function slackReplierParams(agentName: string | undefined, replier: ReplierLabel | undefined): Record<string, string> {
  if (!replier || !agentName || agentName.trim().length === 0) return {};
  return { username: `${agentName} [${replier.taskLabel}]` };
}

async function dispatchSlackReply(target: SlackTarget, text: string, replier?: ReplierLabel): Promise<string> {
  const body = new URLSearchParams({ channel: target.channelId, text });
  if (target.threadTs) body.set("thread_ts", target.threadTs);
  if (replier) {
    const name = await botDisplayName().catch(() => undefined);
    for (const [k, v] of Object.entries(slackReplierParams(name, replier))) body.set(k, v);
  }
  const res = await slackForm("chat.postMessage", body.toString());
  const ts = typeof res?.ts === "string" ? res.ts : undefined;
  if (res?.ok !== true || !ts) {
    throw new Error(`reply couldn't post to Slack — ${(res?.error as string) ?? "no ts returned (check SLACK_BOT_TOKEN)"}`);
  }
  return ts;
}

async function liveSlackPost(origin: SlackOrigin, text: string, replier?: ReplierLabel): Promise<string> {
  const body = new URLSearchParams({ channel: origin.channelId, text });
  const threadTarget = origin.threadTs ?? origin.replyAnchorTs;
  if (threadTarget) body.set("thread_ts", threadTarget);
  if (replier) {
    const name = await botDisplayName().catch(() => undefined);
    for (const [k, v] of Object.entries(slackReplierParams(name, replier))) body.set(k, v);
  }
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
  displayNameCapable: true,
  dispatchReply: (target, text, replier) => dispatchSlackReply(target as SlackTarget, text, replier),
  dispatchUnified: (origin, text, deps: UnifiedReplyDeps, replier) =>
    deps.postSlack ? deps.postSlack(origin as SlackOrigin, text) : liveSlackPost(origin as SlackOrigin, text, replier),
  describeRedriveTarget: (origin) => {
    const o = origin as SlackOrigin;
    return `slack ${o.threadTs ? `thread in ${o.channelId}` : `channel ${o.channelId}`}`;
  },
  redriveContainerId: (origin) => (origin as SlackOrigin).channelId,
  deliverDirectMessage: deliverSlackDirectMessage,
};
