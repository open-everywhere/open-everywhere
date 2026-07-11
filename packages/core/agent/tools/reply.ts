import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { deploymentOrg, isUnifiedWindowContext, type BindableContext } from "../identity/binding.js";
import { capabilitiesFor } from "../identity/capabilities.js";
import { resolveReplyTarget, postReply } from "../channels/reply-post.js";
import { markRepliedThisTurn } from "../channels/reply-signal.js";
import { resolveUnifiedWakeTarget } from "../channels/unified-window.js";
import { postUnifiedReply } from "../channels/unified-reply.js";
import { getOperationalStore } from "../operational/provider.js";
import { auditToolAction } from "../audit/tool-action.js";

function unifiedReplyTool() {
  return defineTool({
    description:
      "Post a reply into the conversation a specific wake came from, without ending your turn. " +
      "You are a cross-surface session: each wake envelope carries a `wake-id` naming where it " +
      "came from — pass the wake-id of the message you are answering, and your reply is posted " +
      "into exactly that conversation (its Slack thread, its GitHub issue, …). You cannot " +
      "target anywhere else. Posting is an action, not turn-completion: reply, keep working, " +
      "and finish with `no_reply` when you're done — your terminal text is never posted.",
    inputSchema: z.object({
      text: z.string().min(1).describe("The message to post (the target surface's markdown). One curated message, not a stack."),
      wake: z.string().min(1).describe("The `wake-id` from the envelope of the wake you are answering — your reply posts into that wake's conversation."),
    }),
    outputSchema: z.object({ posted: z.boolean(), id: z.string() }),
    async execute(input, ctx) {
      const origin = await resolveUnifiedWakeTarget(getOperationalStore(), deploymentOrg(), input.wake);
      if (!origin) {
        throw new Error(
          `reply couldn't resolve wake-id "${input.wake.slice(0, 64)}" — pass the exact wake-id from the envelope of the message you're answering (an unknown or expired id is never guessed).`,
        );
      }
      const id = await postUnifiedReply(origin, input.text);
      markRepliedThisTurn();
      await auditToolAction(ctx, "reply.post", { id, platform: origin.platform, wakeId: input.wake });
      return { posted: true, id };
    },
  });
}

export default defineDynamic({
  events: {
    "session.started": (_event, ctx) => {
      if (isUnifiedWindowContext(ctx as BindableContext)) return unifiedReplyTool();
      const caps = capabilitiesFor(ctx as BindableContext);
      if (!caps.midTurnPost) return null;
      const description = caps.silentEdit
        ? "Post a message into this conversation NOW, without ending your turn. Posting is an " +
          "action, not turn-completion: reply, keep working, and finish with `no_reply` when " +
          "you're done. A reply NOTIFIES the channel — use it for an answer, a question, a " +
          "result, or a blocker, never for a mere progress tick (edit a status message with " +
          "`update_reply` for that). Returns the posted message's `id` — pass it to " +
          "`update_reply` to silently edit this message later (e.g. a live status you keep " +
          "current). Posts into the conversation that woke you; you can't target another channel."
        : "Post a message into this conversation NOW, without ending your turn. Posting is an " +
          "action, not turn-completion: reply, keep working, and finish with `no_reply` when " +
          "you're done. A reply NOTIFIES the thread — use it for an answer, a question, a " +
          "result, or a blocker. Posts here are FINAL (no silent edit on this surface, so there " +
          "is no `update_reply`) — send fewer, curated messages rather than a running status. " +
          "Posts into the conversation that woke you; you can't target another place.";
      return defineTool({
        description,
        inputSchema: z.object({
          text: z.string().min(1).describe("The message to post (channel mrkdwn/markdown). Keep it one curated message, not a stack."),
        }),
        outputSchema: z.object({ posted: z.boolean(), id: z.string() }),
        async execute(input, ctx) {
          const target = resolveReplyTarget(ctx);
          if (!target) {
            throw new Error(
              "reply couldn't resolve this conversation — try again from a real channel, thread, or discussion, not a synthetic context.",
            );
          }
          const id = await postReply(target, input.text);
          markRepliedThisTurn();
          await auditToolAction(ctx, "reply.post", { id, platform: target.platform });
          return { posted: true, id };
        },
      });
    },
  },
});
