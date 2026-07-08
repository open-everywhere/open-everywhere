import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";
import { markNoReplyThisTurn, type NoReplyReason } from "../channels/no-reply-signal.js";
import { auditToolAction } from "../audit/tool-action.js";

export const NO_REPLY_REASONS = ["addressed_to_other", "nothing_to_add", "awaiting_context", "duplicate", "noise_reduction"] as const;

export default defineTool({
  description:
    "End this turn WITHOUT posting a reply — prefer this over ending your final message with the " +
    "literal text NO_REPLY (both still work during the transition, but this is audited and " +
    "unambiguous). Call it, then say nothing else — the tool call IS the whole outcome; any text " +
    "after it is discarded. Pick the reason that best fits: `addressed_to_other` — the message " +
    "wasn't for you (someone else was tagged/asked); `nothing_to_add` — you have no useful " +
    "contribution right now; `awaiting_context` — you need more information before you could " +
    "usefully respond, and nobody's asked you a direct question yet; `duplicate` — this would " +
    "just repeat something you (or the thread) already said; `noise_reduction` — a reply here " +
    "would just be noise in a busy thread (a react via the `react` tool is often a better fit " +
    "than either replying or going fully silent).",
  inputSchema: z.object({
    reason: z.enum(NO_REPLY_REASONS).describe("Why you're not replying — see the tool description for what each value means."),
  }),
  outputSchema: z.object({ acknowledged: z.boolean(), reason: z.string() }),
  approval: never(),
  async execute(input, ctx) {
    markNoReplyThisTurn(input.reason as NoReplyReason);
    await auditToolAction(ctx, "reply.no_reply", { reason: input.reason });
    return { acknowledged: true, reason: input.reason };
  },
});
