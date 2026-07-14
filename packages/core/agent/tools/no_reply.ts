import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";
import { markNoReplyThisTurn, peekNoReplyThisTurn, type NoReplyReason } from "../channels/no-reply-signal.js";
import { auditToolAction } from "../audit/tool-action.js";
import { auditSilencesEnabled } from "../audit/audit.js";
import { currentWakeId, type BindableContext } from "../identity/binding.js";

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
    "End this turn without posting a reply. Call it, then stop — text after it is discarded. " +
    "`addressed_to_other` — multi-party thread, message is for someone else; " +
    "`reacted_instead` — acknowledged with an emoji react instead of a reply; " +
    "`nothing_to_add` — would just be agreeing/restating, no new information; " +
    "`not_relevant` — auto-respond/firehose message doesn't warrant a response; " +
    "`duplicate` — already covered by an earlier reply or another participant; " +
    "`user_requested_silence` — user asked you to stop / stay quiet; " +
    "`awaiting_context` — passively observing the thread, will weigh in once humans add more; " +
    "`other` — none of the above (say why in `explanation`).",
  inputSchema: z
    .object({
      reason: z.enum(NO_REPLY_REASONS).describe("Why you're not replying — see the tool description for what each value means."),
      explanation: z
        .string()
        .min(10)
        .max(500)
        .optional()
        .describe('Required when reason is "other": why none of the named reasons fit.'),
    })
    .superRefine((v, ctx) => {
      if (v.reason === "other" && (v.explanation === undefined || v.explanation.trim().length < 10)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["explanation"],
          message: 'reason "other" requires an explanation — one sentence on why none of the named reasons fit.',
        });
      }
    }),
  outputSchema: z.object({ acknowledged: z.boolean(), reason: z.string(), note: z.string() }),
  approval: never(),
  async execute(input, ctx) {
    const confabulated =
      /\breply\b[^.]{0,60}?\b(unavailable|not available|isn'?t available|can'?t|cannot)\b/i;
    const confabulatedInverted = /\b(can'?t|cannot|unable to|no way to)\b[^.]{0,30}?\breply\b/i;
    if (input.explanation && (confabulated.test(input.explanation) || confabulatedInverted.test(input.explanation))) {
      throw new Error(
        "`reply` IS in your toolset on every surface in this session — never conclude it's unavailable. " +
          "If you believe it can't deliver, call it and read the error; otherwise pick a named reason for silence.",
      );
    }
    const already = peekNoReplyThisTurn();
    if (already !== null) {
      if (auditSilencesEnabled()) {
        await auditToolAction(ctx, "reply.no_reply_redundant", {
          reason: input.reason,
          already,
          ...(input.explanation !== undefined ? { explanation: input.explanation } : {}),
        });
      }
      return {
        acknowledged: true,
        reason: input.reason,
        note: "Silence already recorded this turn; no second no_reply logged.",
      };
    }
    markNoReplyThisTurn(input.reason as NoReplyReason);
    const wakeId = currentWakeId(ctx as BindableContext);
    if (auditSilencesEnabled()) {
      await auditToolAction(ctx, "reply.no_reply", {
        reason: input.reason,
        ...(wakeId ? { wakeId } : {}),
        ...(input.explanation !== undefined ? { explanation: input.explanation } : {}),
      });
    }
    return {
      acknowledged: true,
      reason: input.reason,
      note: "Turn reply requirement satisfied — silence recorded as this turn's answer.",
    };
  },
});
