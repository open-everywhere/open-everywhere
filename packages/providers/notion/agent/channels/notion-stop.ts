import {
  cancelAnchoredTurn,
  resolvePartition,
  turnChannelKey,
  type AttachSessionForCancel,
  type CancelOutcome,
} from "@open-everywhere/core/agent/adapter-api.js";
import { isStopDirective } from "@open-everywhere/core/agent/adapter-api.js";
import { buildNotionAuth, notionConversationKey } from "./notion-identity.js";
import { richTextToPlainText, type NotionComment } from "./notion-api.js";
import type { NotionOwnBotIds } from "./notion-bot-user.js";

export function notionCommentIsStopDirective(comment: NotionComment, own: NotionOwnBotIds): boolean {
  if (!isStopDirective(richTextToPlainText(comment.rich_text))) return false;
  if (!own.primary) return false;
  const author = comment.created_by;
  if (author?.id !== undefined && own.all.has(author.id)) return false;
  if (!author?.id) return false;
  if (author.type && author.type !== "person") return false;
  if (!own.complete && author.type !== "person") return false;
  return true;
}

export interface NotionStopComment {
  readonly workspaceId?: string;
  readonly pageId: string;
  readonly discussionId?: string;
  readonly credentialId?: string;
  readonly requesterId?: string;
}

export interface NotionStopDeps {
  readonly attachSession: AttachSessionForCancel;
  readonly cancel?: typeof cancelAnchoredTurn;
}

export type NotionStopOutcome =
  | { readonly stopped: false; readonly reason: string }
  | { readonly stopped: true; readonly outcome: CancelOutcome };

export async function routeNotionStopComment(stop: NotionStopComment, deps: NotionStopDeps): Promise<NotionStopOutcome> {
  const conversationKey = notionConversationKey(stop.workspaceId, stop.pageId);
  const channelKey = conversationKey ? turnChannelKey("notion", conversationKey) : undefined;
  if (!channelKey) return { stopped: false, reason: "stop: no conversation key" };
  const partition = resolvePartition({
    channel: { kind: "notion" },
    session: {
      auth: {
        current: buildNotionAuth({
          workspaceId: stop.workspaceId,
          pageId: stop.pageId,
          ...(stop.discussionId ? { discussionId: stop.discussionId } : {}),
          ...(stop.credentialId ? { credentialId: stop.credentialId } : {}),
          ...(stop.requesterId ? { principalId: stop.requesterId } : {}),
        }),
      },
    },
  });
  const result = await (deps.cancel ?? cancelAnchoredTurn)({
    org: partition.org,
    platform: "notion",
    workspace: partition.workspace,
    ...(stop.requesterId ? { requestedBy: stop.requesterId } : {}),
    via: "reaction",
    query: { channelKey },
    attachSession: deps.attachSession,
  });
  return { stopped: true, outcome: result.outcome };
}
