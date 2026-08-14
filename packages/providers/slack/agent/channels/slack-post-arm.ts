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

export interface SlackPostResult {
  readonly ok?: boolean;
  readonly ts?: unknown;
  readonly error?: unknown;
}

export type SlackPostFn = (body: URLSearchParams) => Promise<SlackPostResult | undefined>;

const livePost: SlackPostFn = (body) => slackForm("chat.postMessage", body.toString());

export async function postSlackMessage(
  base: URLSearchParams,
  replier: ReplierLabel | undefined,
  errPrefix: string,
  post: SlackPostFn = livePost,
  resolveDisplayName: () => Promise<string | undefined> = botDisplayName,
): Promise<string> {
  let usedReplierParams = false;
  let attempt = base;
  if (replier) {
    const name = await resolveDisplayName().catch(() => undefined);
    const params = slackReplierParams(name, replier);
    if (Object.keys(params).length > 0) {
      attempt = new URLSearchParams(base);
      for (const [k, v] of Object.entries(params)) attempt.set(k, v);
      usedReplierParams = true;
    }
  }
  const res = await post(attempt);
  const ts = typeof res?.ts === "string" ? res.ts : undefined;
  if (res?.ok === true && ts) return ts;
  if (usedReplierParams) {
    const retry = await post(base);
    const retryTs = typeof retry?.ts === "string" ? retry.ts : undefined;
    if (retry?.ok === true && retryTs) return retryTs;
    throw new Error(`${errPrefix} — ${(retry?.error as string) ?? (res?.error as string) ?? "no ts returned (check SLACK_BOT_TOKEN)"}`);
  }
  throw new Error(`${errPrefix} — ${(res?.error as string) ?? "no ts returned (check SLACK_BOT_TOKEN)"}`);
}

async function dispatchSlackReply(target: SlackTarget, text: string, replier?: ReplierLabel): Promise<string> {
  const body = new URLSearchParams({ channel: target.channelId, text });
  if (target.threadTs) body.set("thread_ts", target.threadTs);
  return postSlackMessage(body, replier, "reply couldn't post to Slack");
}

async function liveSlackPost(origin: SlackOrigin, text: string, replier?: ReplierLabel): Promise<string> {
  const body = new URLSearchParams({ channel: origin.channelId, text });
  const threadTarget = origin.threadTs ?? origin.replyAnchorTs;
  if (threadTarget) body.set("thread_ts", threadTarget);
  return postSlackMessage(body, replier, "unified reply couldn't post to Slack");
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
