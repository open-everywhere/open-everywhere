import { callLinearGraphQL } from "eve/channels/linear";
import type { SurfaceMessageOps } from "@open-everywhere/core/agent/adapter-api.js";
import { linearCredentialsForOrg } from "./linear-credentials.js";
import { describeLinearError } from "./linear-errors.js";
import { resolveViewer } from "./linear.js";

interface CommentReactionNode {
  readonly id?: string;
  readonly emoji?: string;
  readonly user?: { readonly id?: string };
}

export const linearMessageOps: SurfaceMessageOps = {
  platform: "linear",

  async postText(issueId, text, opts) {
    let data: { commentCreate?: { success?: boolean; comment?: { id?: string } } };
    try {
      data = await callLinearGraphQL<{ commentCreate?: { success?: boolean; comment?: { id?: string } } }>({
        credentials: linearCredentialsForOrg(undefined),
        query: "mutation OeSurfacePostText($input: CommentCreateInput!) { commentCreate(input: $input) { success comment { id } } }",
        queryName: "OeSurfacePostText",
        variables: { input: { issueId, ...(opts?.replyToMessageId ? { parentId: opts.replyToMessageId } : {}), body: text } },
      });
    } catch (err) {
      throw new Error(`Linear: couldn't post to issue ${issueId} (${describeLinearError(err)}).`);
    }
    if (data.commentCreate?.success !== true || !data.commentCreate.comment?.id) {
      throw new Error(`Linear: commentCreate on issue ${issueId} returned no success or no comment id.`);
    }
    return data.commentCreate.comment.id;
  },

  async editMessage(issueId, commentId, text) {
    let data: { commentUpdate?: { success?: boolean } };
    try {
      data = await callLinearGraphQL<{ commentUpdate?: { success?: boolean } }>({
        credentials: linearCredentialsForOrg(undefined),
        query: "mutation OeSurfaceEditMessage($id: String!, $input: CommentUpdateInput!) { commentUpdate(id: $id, input: $input) { success } }",
        queryName: "OeSurfaceEditMessage",
        variables: { id: commentId, input: { body: text } },
      });
    } catch (err) {
      throw new Error(`Linear: couldn't edit comment ${commentId} on issue ${issueId} (${describeLinearError(err)}).`);
    }
    if (data.commentUpdate?.success !== true) {
      throw new Error(`Linear: commentUpdate on comment ${commentId} (issue ${issueId}) returned no success.`);
    }
  },

  async setReaction(issueId, commentId, emoji, on) {
    try {
      if (on) {
        const data = await callLinearGraphQL<{ reactionCreate?: { success?: boolean } }>({
          credentials: linearCredentialsForOrg(undefined),
          query: "mutation OeSurfaceReact($input: ReactionCreateInput!) { reactionCreate(input: $input) { success } }",
          queryName: "OeSurfaceReact",
          variables: { input: { commentId, emoji } },
        });
        if (data.reactionCreate?.success !== true) {
          console.warn(`[open-everywhere:linear] reaction add returned no success for comment ${commentId} (issue ${issueId})`);
        }
        return;
      }
      const viewer = await resolveViewer(undefined);
      if (!viewer.id) {
        console.warn(`[open-everywhere:linear] reaction remove skipped for comment ${commentId} — app viewer id unresolved (fail-closed: never guess whose reaction to delete)`);
        return;
      }
      const lookup = await callLinearGraphQL<{ comment?: { reactions?: { nodes?: CommentReactionNode[] } } }>({
        credentials: linearCredentialsForOrg(undefined),
        query: "query OeSurfaceReactionLookup($id: String!) { comment(id: $id) { reactions { nodes { id emoji user { id } } } } }",
        queryName: "OeSurfaceReactionLookup",
        variables: { id: commentId },
      });
      const mine = (lookup.comment?.reactions?.nodes ?? []).find((r) => r.emoji === emoji && r.user?.id === viewer.id);
      if (!mine?.id) return;
      const del = await callLinearGraphQL<{ reactionDelete?: { success?: boolean } }>({
        credentials: linearCredentialsForOrg(undefined),
        query: "mutation OeSurfaceUnreact($id: String!) { reactionDelete(id: $id) { success } }",
        queryName: "OeSurfaceUnreact",
        variables: { id: mine.id },
      });
      if (del.reactionDelete?.success !== true) {
        console.warn(`[open-everywhere:linear] reaction remove returned no success for comment ${commentId} (issue ${issueId})`);
      }
    } catch (err) {
      console.warn(`[open-everywhere:linear] reaction ${on ? "add" : "remove"} failed for comment ${commentId} (issue ${issueId}): ${describeLinearError(err)}`);
    }
  },
};
