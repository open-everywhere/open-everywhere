import { createCommentReply, resolveNotionApiKey } from "./notion-api.js";
import type { PostArm, TargetResolveBag } from "./post-arms.js";
import type { ReplyTarget } from "./reply-post.js";
import type { UnifiedWakeOrigin } from "./unified-window.js";
import type { UnifiedReplyDeps } from "./unified-reply.js";

type NotionTarget = Extract<ReplyTarget, { platform: "notion" }>;
type NotionOrigin = Extract<UnifiedWakeOrigin, { platform: "notion" }>;

async function dispatchNotionReply(target: NotionTarget, text: string): Promise<string> {
  const apiKey = await resolveNotionApiKey();
  if (!apiKey || apiKey.length === 0) {
    throw new Error("reply couldn't post to Notion — NOTION_CHANNEL_API_KEY is not set.");
  }
  return createCommentReply({ discussionId: target.discussionId, text, apiKey });
}

async function liveNotionPost(origin: NotionOrigin, text: string): Promise<string> {
  const apiKey = await resolveNotionApiKey();
  if (!apiKey || apiKey.length === 0) {
    throw new Error(`unified reply couldn't post to Notion — NOTION_CHANNEL_API_KEY is not set (discussion ${origin.discussionId})`);
  }
  let id: string;
  try {
    id = await createCommentReply({ discussionId: origin.discussionId, text, apiKey });
  } catch {
    throw new Error(`unified reply couldn't post to Notion — createCommentReply failed on discussion ${origin.discussionId}`);
  }
  return id || "unknown";
}

export const notionPostArm: PostArm = {
  platform: "notion",
  resolveTarget: (bag: TargetResolveBag): ReplyTarget | null => {
    const discussionId = bag.str("discussionId");
    return discussionId ? { platform: "notion", discussionId } : null;
  },
  dispatchReply: (target, text) => dispatchNotionReply(target as NotionTarget, text),
  dispatchUnified: (origin, text, deps: UnifiedReplyDeps) => (deps.postNotion ?? liveNotionPost)(origin as NotionOrigin, text),
  describeRedriveTarget: (origin) => `notion discussion ${(origin as NotionOrigin).discussionId}`,
  redriveContainerId: (origin) => (origin as NotionOrigin).discussionId,
};
