import { slackForm, botDisplayName } from "./slack-events.js";
import { markdownToSlackMrkdwn } from "./slack-mrkdwn.js";
import { markNotApplied } from "@open-everywhere/core/agent/adapter-api.js";
import type {
  PostArm,
  TargetResolveBag,
  ReplyTarget,
  ReplierLabel,
  EditLocus,
  UnifiedWakeOrigin,
  UnifiedReplyDeps,
  DirectMessageRequest,
  DirectMessageDelivery,
  DirectMessageAction,
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
    throw classifiedPostError(retry, `${errPrefix} — ${(retry?.error as string) ?? (res?.error as string) ?? "no ts returned (check SLACK_BOT_TOKEN)"}`);
  }
  throw classifiedPostError(res, `${errPrefix} — ${(res?.error as string) ?? "no ts returned (check SLACK_BOT_TOKEN)"}`);
}

function classifiedPostError(res: SlackPostResult | undefined, message: string): Error {
  const err = new Error(message);
  return res?.ok === false ? markNotApplied(err) : err;
}

async function dispatchSlackReply(target: SlackTarget, text: string, replier?: ReplierLabel): Promise<string> {
  const body = new URLSearchParams({ channel: target.channelId, text: markdownToSlackMrkdwn(text) });
  if (target.threadTs) body.set("thread_ts", target.threadTs);
  return postSlackMessage(body, replier, "reply couldn't post to Slack");
}

export function slackThreadTarget(origin: Pick<SlackOrigin, "threadTs" | "replyAnchorTs">): string | undefined {
  const anchor = origin.threadTs ?? origin.replyAnchorTs;
  return anchor && anchor.length > 0 ? anchor : undefined;
}

async function liveSlackPost(origin: SlackOrigin, text: string, replier?: ReplierLabel): Promise<string> {
  const body = new URLSearchParams({ channel: origin.channelId, text: markdownToSlackMrkdwn(text) });
  const threadTarget = slackThreadTarget(origin);
  if (threadTarget) body.set("thread_ts", threadTarget);
  return postSlackMessage(body, replier, "unified reply couldn't post to Slack");
}

function slackDirectMessageActionBlock(actions: readonly DirectMessageAction[]): Record<string, unknown> | undefined {
  const elements = actions
    .filter((a) => a.id.length > 0 && a.id.length <= 255 && a.label.length > 0 && a.label.length <= 75)
    .map((a) => ({
      action_id: a.id,
      text: { emoji: true, text: a.label, type: "plain_text" },
      type: "button",
      ...(a.intent === "reject" ? { style: "danger" } : {}),
    }));
  return elements.length > 0 ? { elements, type: "actions" } : undefined;
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
  const rendered = markdownToSlackMrkdwn(input.text);
  const actionBlock = input.actions === undefined ? undefined : slackDirectMessageActionBlock(input.actions);
  const form = new URLSearchParams({ channel: dmChannelId, text: rendered });
  if (actionBlock !== undefined) {
    form.set("blocks", JSON.stringify([{ text: { text: rendered, type: "mrkdwn" }, type: "section" }, actionBlock]));
  }
  const posted = await slackForm("chat.postMessage", form.toString());
  const ts = typeof posted?.ts === "string" ? posted.ts : undefined;
  if (posted?.ok !== true || !ts) {
    throw new Error(`couldn't post the Slack DM — ${(posted?.error as string) ?? "no ts returned (check SLACK_BOT_TOKEN)"}`);
  }
  return { surfaceId: dmChannelId, messageId: ts };
}

async function editSlackMessage(locus: EditLocus, messageId: string, text: string): Promise<void> {
  const body = new URLSearchParams({ channel: locus.channelId, ts: messageId, text: markdownToSlackMrkdwn(text) });
  const res = await slackForm("chat.update", body.toString());
  if (res?.ok !== true) {
    throw markNotApplied(
      new Error(`edit_reply couldn't update the Slack message — ${(res?.error as string) ?? "chat.update returned no ok (check SLACK_BOT_TOKEN)"}`),
    );
  }
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
  editMessage: editSlackMessage,
};
