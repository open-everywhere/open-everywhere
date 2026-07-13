import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";
import { markNoReplyThisTurn, type NoReplyReason } from "../channels/no-reply-signal.js";
import { auditToolAction } from "../audit/tool-action.js";

export const NO_REPLY_REASONS = [
  "addressed_to_other",
  "reacted_instead",
  "nothing_to_add",
  "not_relevant",
  "duplicate",
  "user_requested_silence",
  "awaiting_context",
  "other",
] as const;

export default defineTool({
  description:
    "End this turn WITHOUT posting a reply — prefer this over ending your final message with the " +
    "literal text NO_REPLY (both still work during the transition, but this is audited and " +
    "unambiguous). Call it, then say nothing else — the tool call IS the whole outcome; any text " +
    "after it is discarded. Pick the reason that best fits: `addressed_to_other` — the message " +
    "wasn't for you (someone else was tagged/asked) in a multi-party thread; `reacted_instead` — " +
    "you acknowledged with an emoji react via the `react` tool instead of replying; `nothing_to_add` " +
    "— you have no useful contribution right now (you'd just be agreeing or restating with no new " +
    "information); `not_relevant` — this is an auto-respond, firehose, or automated message that " +
    "doesn't warrant a response; `duplicate` — this is already covered by an earlier reply or " +
    "another participant; `user_requested_silence` — a user explicitly asked you to stop or stay " +
    "quiet; `awaiting_context` — you're passively observing and will weigh in once humans add more, " +
    "and nobody's asked you a direct question yet; `other` — none of the above fit. (In a busy " +
    "thread where a reply would just add noise, a react via the `react` tool then `reacted_instead` " +
    "is usually the better shape than going fully silent.)",
  inputSchema: z.object({
    reason: z.enum(NO_REPLY_REASONS).describe("Why you're not replying — see the tool description for what each value means."),
  }),
  outputSchema: z.object({ acknowledged: z.boolean(), reason: z.string(), note: z.string() }),
  approval: never(),
  async execute(input, ctx) {
    markNoReplyThisTurn(input.reason as NoReplyReason);
    await auditToolAction(ctx, "reply.no_reply", { reason: input.reason });
    return {
      acknowledged: true,
      reason: input.reason,
      note: "Turn reply requirement satisfied — silence recorded as this turn's answer.",
    };
  },
});
