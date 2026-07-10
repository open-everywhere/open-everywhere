import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { type BindableContext } from "../identity/binding.js";
import { capabilitiesFor } from "../identity/capabilities.js";
import { resolveReplyTarget, postReply } from "../channels/reply-post.js";
import { markRepliedThisTurn } from "../channels/reply-signal.js";
import { auditToolAction } from "../audit/tool-action.js";

export default defineDynamic({
  events: {
    "session.started": (_event, ctx) => {
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
