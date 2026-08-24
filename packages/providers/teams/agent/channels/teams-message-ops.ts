import type { SurfaceMessageOps } from "@open-everywhere/core/agent/adapter-api.js";
import { dispatchTeamsReply, editTeamsMessage, type TeamsTarget } from "./teams-post-arm.js";
import { teamsConversationRef } from "./teams-conversation-ref.js";
import { restoreTeamsConversationId } from "./teams-id-restore.js";

async function requireConversationRef(channelId: string): Promise<{ readonly serviceUrl: string; readonly conversationId: string }> {
  const ref = await teamsConversationRef(await restoreTeamsConversationId(channelId));
  if (!ref) {
    throw new Error(
      `Teams surface message ops: no conversation reference for "${channelId}" — this deployment has never seen an inbound activity on that id.`,
    );
  }
  return ref;
}

export const teamsMessageOps: SurfaceMessageOps = {
  platform: "teams",

  async postText(channelId, text, opts) {
    const { serviceUrl, conversationId } = await requireConversationRef(channelId);
    const target: TeamsTarget = {
      platform: "teams",
      serviceUrl,
      conversationId,
      ...(opts?.replyToMessageId ? { replyToActivityId: opts.replyToMessageId } : {}),
    };
    return dispatchTeamsReply(target, text);
  },

  async editMessage(channelId, messageId, text) {
    const { serviceUrl, conversationId } = await requireConversationRef(channelId);
    await editTeamsMessage({ platform: "teams", channelId: conversationId, serviceUrl }, messageId, text);
  },
};
