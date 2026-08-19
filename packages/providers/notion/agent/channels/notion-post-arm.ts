import { createCommentReply, resolveNotionCredential } from "./notion-api.js";
import { notionChannelCredentialFor } from "./notion-credentials.js";
import { getConfig, resolvePartition, markNotApplied, carryFailureSignals, type Domain } from "@open-everywhere/core/agent/adapter-api.js";
import type { PostArm, TargetResolveBag, ReplyTarget, UnifiedWakeOrigin, UnifiedReplyDeps } from "@open-everywhere/core/agent/adapter-api.js";

function notionDomains(): readonly Domain[] {
  try {
    return getConfig().loadDomains();
  } catch {
    return [];
  }
}

function notionReplyCredential(workspaceId: string | undefined, pageId: string | undefined): string | undefined {
  return notionChannelCredentialFor(workspaceId, pageId, notionDomains());
}

type NotionTarget = Extract<ReplyTarget, { platform: "notion" }>;
type NotionOrigin = Extract<UnifiedWakeOrigin, { platform: "notion" }>;

async function dispatchNotionReply(target: NotionTarget, text: string): Promise<string> {
  const credentialId = target.credentialId ?? notionReplyCredential(target.workspaceId, target.pageId);
  const cred = await resolveNotionCredential(credentialId);
  if (!cred) {
    throw markNotApplied(new Error(`reply couldn't post to Notion — no value stored for notion credential "${credentialId ?? "channel-key"}".`));
  }
  return createCommentReply({ discussionId: target.discussionId, text, ...cred });
}

async function liveNotionPost(origin: NotionOrigin, text: string): Promise<string> {
  const credentialId = origin.credentialId ?? notionReplyCredential(origin.workspaceId, origin.pageId);
  const cred = await resolveNotionCredential(credentialId);
  if (!cred) {
    throw markNotApplied(new Error(`unified reply couldn't post to Notion — no value stored for notion credential "${credentialId ?? "channel-key"}" (discussion ${origin.discussionId})`));
  }
  let id: string;
  try {
    id = await createCommentReply({ discussionId: origin.discussionId, text, ...cred });
  } catch (err) {
    throw carryFailureSignals(err, new Error(`unified reply couldn't post to Notion — createCommentReply failed on discussion ${origin.discussionId}`));
  }
  return id || "unknown";
}

export const notionPostArm: PostArm = {
  platform: "notion",
  resolveTarget: (bag: TargetResolveBag): ReplyTarget | null => {
    const discussionId = bag.str("discussionId");
    if (!discussionId) return null;
    let workspaceId: string | undefined;
    try {
      workspaceId = resolvePartition(bag.ctx).workspace;
    } catch {
      workspaceId = undefined;
    }
    const pageId = bag.str("pageId");
    const credentialId = bag.str("credentialId");
    return {
      platform: "notion",
      discussionId,
      ...(pageId ? { pageId } : {}),
      ...(workspaceId ? { workspaceId } : {}),
      ...(credentialId ? { credentialId } : {}),
    };
  },
  dispatchReply: (target, text) => dispatchNotionReply(target as NotionTarget, text),
  dispatchUnified: (origin, text, deps: UnifiedReplyDeps) => (deps.postNotion ?? liveNotionPost)(origin as NotionOrigin, text),
  describeRedriveTarget: (origin) => `notion discussion ${(origin as NotionOrigin).discussionId}`,
  redriveContainerId: (origin) => (origin as NotionOrigin).discussionId,
};
