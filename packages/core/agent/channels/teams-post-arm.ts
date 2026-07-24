import { sendTeamsActivity, replyToTeamsActivity, splitTeamsMessageText } from "eve/channels/teams";
import { isTrustedTeamsServiceUrl } from "./unified-window.js";
import type { PostArm, TargetResolveBag } from "./post-arms.js";
import type { ReplyTarget } from "./reply-post.js";
import type { UnifiedWakeOrigin } from "./unified-window.js";
import type { UnifiedReplyDeps } from "./unified-reply.js";

type TeamsTarget = Extract<ReplyTarget, { platform: "teams" }>;
type TeamsOrigin = Extract<UnifiedWakeOrigin, { platform: "teams" }>;

async function dispatchTeamsReply(target: TeamsTarget, text: string): Promise<string> {
  if (!process.env.MICROSOFT_APP_ID && !process.env.TEAMS_APP_ID) {
    throw new Error("reply couldn't post to Teams — MICROSOFT_APP_ID is not set.");
  }
  const res = target.replyToActivityId
    ? await replyToTeamsActivity({
        serviceUrl: target.serviceUrl,
        conversationId: target.conversationId,
        activityId: target.replyToActivityId,
        body: { type: "message", text },
      })
    : await sendTeamsActivity({
        serviceUrl: target.serviceUrl,
        conversationId: target.conversationId,
        body: { type: "message", text },
      });
  return res.id;
}

async function liveTeamsPost(origin: TeamsOrigin, text: string): Promise<string> {
  if (!process.env.MICROSOFT_APP_ID && !process.env.TEAMS_APP_ID) {
    throw new Error(`unified reply couldn't post to Teams — MICROSOFT_APP_ID is not set (conversation ${origin.conversationId})`);
  }
  if (!isTrustedTeamsServiceUrl(origin.serviceUrl)) {
    throw new Error(`unified reply couldn't post to Teams — serviceUrl is not a Bot Framework host (conversation ${origin.conversationId})`);
  }
  let id: string;
  try {
    const res = origin.replyToActivityId
      ? await replyToTeamsActivity({
          serviceUrl: origin.serviceUrl,
          conversationId: origin.conversationId,
          activityId: origin.replyToActivityId,
          body: { type: "message", text },
        })
      : await sendTeamsActivity({
          serviceUrl: origin.serviceUrl,
          conversationId: origin.conversationId,
          body: { type: "message", text },
        });
    id = res.id;
  } catch {
    throw new Error(`unified reply couldn't post to Teams — the Connector post failed (conversation ${origin.conversationId})`);
  }
  return id || "unknown";
}

export const teamsPostArm: PostArm = {
  platform: "teams",
  resolveTarget: (bag: TargetResolveBag): ReplyTarget | null => {
    const serviceUrl = bag.str("serviceUrl");
    const conversationId = bag.str("conversationId");
    return serviceUrl && conversationId ? { platform: "teams", serviceUrl, conversationId } : null;
  },
  dispatchReply: (target, text) => dispatchTeamsReply(target as TeamsTarget, text),
  splitText: (text) => splitTeamsMessageText(text),
  dispatchUnified: (origin, text, deps: UnifiedReplyDeps) => (deps.postTeams ?? liveTeamsPost)(origin as TeamsOrigin, text),
  describeRedriveTarget: (origin) => `teams conversation ${(origin as TeamsOrigin).conversationId}`,
  redriveContainerId: (origin) => (origin as TeamsOrigin).conversationId,
};
