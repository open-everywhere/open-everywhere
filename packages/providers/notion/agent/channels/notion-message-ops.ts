import type { SurfaceMessageOps } from "@open-everywhere/core/agent/adapter-api.js";
import { getConfig, type Domain } from "@open-everywhere/core/agent/adapter-api.js";
import { createPageComment, createCommentReply, updateComment, resolveNotionCredential, retrieveComment, type ResolvedNotionCredential } from "./notion-api.js";
import { notionChannelCredentialFor } from "./notion-credentials.js";
import { parseNotionConversationKey } from "./notion-identity.js";

function notionDomains(): readonly Domain[] {
  try {
    return getConfig().loadDomains();
  } catch {
    return [];
  }
}

function requireConversation(channelId: string): { readonly workspaceId: string; readonly pageId: string } {
  const parsed = parseNotionConversationKey(channelId);
  if (!parsed) throw new Error(`Notion surface message ops: "${channelId}" is not a conversation id (expected "<workspace>/<page>").`);
  return parsed;
}

async function requireCredential(workspaceId: string, pageId: string): Promise<ResolvedNotionCredential> {
  const credentialId = notionChannelCredentialFor(workspaceId, pageId, notionDomains());
  const cred = await resolveNotionCredential(credentialId);
  if (!cred) throw new Error(`Notion surface message ops: no value stored for notion credential "${credentialId ?? "channel-key"}".`);
  return cred;
}

export const notionMessageOps: SurfaceMessageOps = {
  platform: "notion",

  async postText(channelId, text, opts) {
    const { workspaceId, pageId } = requireConversation(channelId);
    const cred = await requireCredential(workspaceId, pageId);
    if (opts?.replyToMessageId) {
      let discussionId: string | undefined;
      try {
        discussionId = (await retrieveComment(opts.replyToMessageId, cred)).discussion_id;
      } catch {
        discussionId = undefined;
      }
      if (discussionId) return createCommentReply({ discussionId, text, ...cred });
    }
    return createPageComment({ pageId, text, ...cred });
  },

  async editMessage(channelId, messageId, text) {
    const { workspaceId, pageId } = requireConversation(channelId);
    const cred = await requireCredential(workspaceId, pageId);
    await updateComment({ commentId: messageId, text, ...cred });
  },
};
