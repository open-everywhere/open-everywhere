import { sendTeamsActivity, replyToTeamsActivity, splitTeamsMessageText, updateTeamsActivity, TEAMS_MESSAGE_TEXT_MAX_LENGTH } from "eve/channels/teams";
import { isTrustedTeamsServiceUrl } from "./teams-origin-codec.js";
import type { PostArm, TargetResolveBag, ReplyTarget, UnifiedWakeOrigin, UnifiedReplyDeps, EditLocus } from "@open-everywhere/core/agent/adapter-api.js";

type TeamsTarget = Extract<ReplyTarget, { platform: "teams" }>;
type TeamsOrigin = Extract<UnifiedWakeOrigin, { platform: "teams" }>;

async function dispatchTeamsReply(target: TeamsTarget, text: string): Promise<string> {
  if (!process.env.MICROSOFT_APP_ID && !process.env.TEAMS_APP_ID) {
    throw new Error("reply couldn't post to Teams — MICROSOFT_APP_ID is not set.");
  }
  if (!isTrustedTeamsServiceUrl(target.serviceUrl)) {
    throw new Error(`reply couldn't post to Teams — serviceUrl is not a Bot Framework host (conversation ${target.conversationId})`);
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

async function editTeamsMessage(locus: EditLocus, messageId: string, text: string): Promise<void> {
  if (!process.env.MICROSOFT_APP_ID && !process.env.TEAMS_APP_ID) {
    throw new Error("edit_reply couldn't update the Teams message — MICROSOFT_APP_ID is not set.");
  }
  if (!locus.serviceUrl || !isTrustedTeamsServiceUrl(locus.serviceUrl)) {
    throw new Error(`edit_reply couldn't update the Teams message — serviceUrl is not a Bot Framework host (conversation ${locus.channelId})`);
  }
  if (text.length > TEAMS_MESSAGE_TEXT_MAX_LENGTH) {
    throw new Error(
      `edit_reply couldn't update the Teams message — the new text is ${text.length} characters and Teams caps one message at ${TEAMS_MESSAGE_TEXT_MAX_LENGTH}. An edit cannot split a message; shorten it, or post a new reply.`,
    );
  }
  try {
    await updateTeamsActivity({
      serviceUrl: locus.serviceUrl,
      conversationId: locus.channelId,
      activityId: messageId,
      body: { type: "message", text },
    });
  } catch {
    throw new Error(`edit_reply couldn't update the Teams message — the Connector update failed (conversation ${locus.channelId})`);
  }
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
  editMessage: editTeamsMessage,
};
