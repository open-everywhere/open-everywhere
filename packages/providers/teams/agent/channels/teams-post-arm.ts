import {
  callTeamsConnectorApi,
  resolveTeamsAppId,
  sendTeamsActivity,
  replyToTeamsActivity,
  splitTeamsMessageText,
  updateTeamsActivity,
  TEAMS_MESSAGE_TEXT_MAX_LENGTH,
} from "eve/channels/teams";
import { isTrustedTeamsServiceUrl } from "./teams-origin-codec.js";
import {
  teamsPersonalConversationRef,
  teamsSoleTenantRegion,
  rememberTeamsPersonalConversation,
  type TeamsConversationRef,
} from "./teams-conversation-ref.js";
import { restoreTeamsPersonId } from "./teams-id-restore.js";
import { markNotApplied, carryFailureSignals } from "@open-everywhere/core/agent/adapter-api.js";
import type {
  PostArm,
  TargetResolveBag,
  ReplyTarget,
  UnifiedWakeOrigin,
  UnifiedReplyDeps,
  EditLocus,
  DirectMessageRequest,
  DirectMessageDelivery,
} from "@open-everywhere/core/agent/adapter-api.js";

export type TeamsTarget = Extract<ReplyTarget, { platform: "teams" }>;
type TeamsOrigin = Extract<UnifiedWakeOrigin, { platform: "teams" }>;

export async function dispatchTeamsReply(target: TeamsTarget, text: string): Promise<string> {
  if (!process.env.MICROSOFT_APP_ID && !process.env.TEAMS_APP_ID) {
    throw markNotApplied(new Error("reply couldn't post to Teams — MICROSOFT_APP_ID is not set."));
  }
  if (!isTrustedTeamsServiceUrl(target.serviceUrl)) {
    throw markNotApplied(new Error(`reply couldn't post to Teams — serviceUrl is not a Bot Framework host (conversation ${target.conversationId})`));
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
    throw markNotApplied(new Error(`unified reply couldn't post to Teams — MICROSOFT_APP_ID is not set (conversation ${origin.conversationId})`));
  }
  if (!isTrustedTeamsServiceUrl(origin.serviceUrl)) {
    throw markNotApplied(new Error(`unified reply couldn't post to Teams — serviceUrl is not a Bot Framework host (conversation ${origin.conversationId})`));
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
  } catch (err) {
    throw carryFailureSignals(err, new Error(`unified reply couldn't post to Teams — the Connector post failed (conversation ${origin.conversationId})`));
  }
  return id || "unknown";
}

export async function editTeamsMessage(locus: EditLocus, messageId: string, text: string): Promise<void> {
  if (!process.env.MICROSOFT_APP_ID && !process.env.TEAMS_APP_ID) {
    throw markNotApplied(new Error("edit_reply couldn't update the Teams message — MICROSOFT_APP_ID is not set."));
  }
  if (!locus.serviceUrl || !isTrustedTeamsServiceUrl(locus.serviceUrl)) {
    throw markNotApplied(
      new Error(`edit_reply couldn't update the Teams message — serviceUrl is not a Bot Framework host (conversation ${locus.channelId})`),
    );
  }
  if (text.length > TEAMS_MESSAGE_TEXT_MAX_LENGTH) {
    throw markNotApplied(
      new Error(
        `edit_reply couldn't update the Teams message — the new text is ${text.length} characters and Teams caps one message at ${TEAMS_MESSAGE_TEXT_MAX_LENGTH}. An edit cannot split a message; shorten it, or post a new reply.`,
      ),
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

function requireTeamsAppCredential(what: string): void {
  if (!process.env.MICROSOFT_APP_ID && !process.env.TEAMS_APP_ID) {
    throw markNotApplied(new Error(`${what} couldn't reach Teams — MICROSOFT_APP_ID is not set.`));
  }
}

async function openTeamsPersonalConversation(region: { readonly serviceUrl: string; readonly tenantId: string }, principalId: string): Promise<string> {
  const appId = await resolveTeamsAppId();
  const res = await callTeamsConnectorApi({
    serviceUrl: region.serviceUrl,
    path: "/v3/conversations",
    method: "POST",
    body: {
      isGroup: false,
      bot: { id: `28:${appId}` },
      members: [{ id: principalId }],
      channelData: { tenant: { id: region.tenantId } },
      tenantId: region.tenantId,
    },
  });
  const id = res.ok && res.body && typeof res.body === "object" ? (res.body as { id?: unknown }).id : undefined;
  if (typeof id !== "string" || id.length === 0) {
    throw new Error(
      `couldn't open a Teams 1:1 chat with that account (Bot Framework answered ${res.status}). Microsoft refuses this when the Teams app is not installed for that person in the personal scope.`,
    );
  }
  return id;
}

async function deliverTeamsDirectMessage(input: DirectMessageRequest): Promise<DirectMessageDelivery> {
  requireTeamsAppCredential("the direct message");
  const principalId = await restoreTeamsPersonId(input.principalId.trim());
  if (principalId.length === 0) throw markNotApplied(new Error("the direct message couldn't reach Teams — no account id was given."));

  const stored = await teamsPersonalConversationRef(principalId);
  let ref: TeamsConversationRef;
  if (stored) {
    ref = stored;
  } else {
    const region = await teamsSoleTenantRegion();
    if (!region) {
      throw markNotApplied(
        new Error(
          "the direct message couldn't reach Teams — this deployment holds no Bot Framework conversation reference for that account, and no single Teams tenant it could open one in. A reference is captured when the person messages the bot, or when the bot sees a channel in exactly one tenant.",
        ),
      );
    }
    ref = { ...region, conversationId: await openTeamsPersonalConversation(region, principalId) };
    await rememberTeamsPersonalConversation(principalId, ref);
  }

  if (!isTrustedTeamsServiceUrl(ref.serviceUrl)) {
    throw markNotApplied(new Error("the direct message couldn't reach Teams — the stored serviceUrl is not a Bot Framework host."));
  }

  const parts = splitTeamsMessageText(input.text);
  let messageId = "";
  for (const part of parts) {
    const res = await sendTeamsActivity({ serviceUrl: ref.serviceUrl, conversationId: ref.conversationId, body: { type: "message", text: part } });
    if (messageId.length === 0) messageId = res.id;
  }
  return { surfaceId: ref.conversationId, messageId: messageId || "unknown" };
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
  deliverDirectMessage: deliverTeamsDirectMessage,
};
