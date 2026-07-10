import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { channelPlatform, type BindableContext } from "../identity/binding.js";
import { resolveReplyTarget, postReply } from "../channels/reply-post.js";
import { markRepliedThisTurn } from "../channels/reply-signal.js";
import { auditToolAction } from "../audit/tool-action.js";

export default defineDynamic({
  events: {
    "session.started": (_event, ctx) => {
      const platform = channelPlatform(ctx as BindableContext);
      if (platform !== "slack" && platform !== "discord") return null;
      return defineTool({
        description:
          "Post a message into this conversation NOW, without ending your turn. Posting is an " +
          "action, not turn-completion: reply, keep working, and finish with `no_reply` when " +
          "you're done. A reply NOTIFIES the channel — use it for an answer, a question, a " +
          "result, or a blocker, never for a mere progress tick (edit a status message with " +
          "`update_reply` for that). Returns the posted message's `id` — pass it to " +
          "`update_reply` to silently edit this message later (e.g. a live status you keep " +
          "current). Posts into the conversation that woke you; you can't target another channel.",
        inputSchema: z.object({
          text: z.string().min(1).describe("The message to post (channel mrkdwn/markdown). Keep it one curated message, not a stack."),
        }),
        outputSchema: z.object({ posted: z.boolean(), id: z.string() }),
        async execute(input, ctx) {
          const target = resolveReplyTarget(ctx);
          if (!target) {
            throw new Error(
              "reply couldn't resolve this conversation's channel — try again from a real Slack/Discord channel or thread, not a synthetic context.",
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
