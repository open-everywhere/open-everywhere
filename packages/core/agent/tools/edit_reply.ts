import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { deploymentOrg, isUnifiedWindowContext, currentWakeId, currentTurnId, type BindableContext } from "../identity/binding.js";
import { resolveReplyTarget, replyEditLocus, replyAuditFor } from "../channels/reply-post.js";
import { resolveUnifiedEditLocus } from "../channels/unified-reply.js";
import { editPostedMessage, auditReplyEditRefused, editRefusalMessage, EDIT_NO_ARM_REFUSAL_REASON } from "../channels/reply-edit.js";
import { resolveAnswerableReplyTarget, replyRefusalMessage } from "../channels/unified-window.js";
import { withPendingWorkFrame } from "../channels/turn-delivery.js";
import { addressedWakeThisTurn } from "../access/dispatch-origin-signal.js";
import { pendingDelegationOwing } from "../access/pending-delegation-signal.js";
import { silentRoutineThisTurn } from "../routines/report.js";
import { resolveOwnWindowToken } from "../access/oneshot-spawn.js";
import { getOperationalStore } from "../operational/provider.js";
import { preRegisterDynamicEntry } from "../access/window-gated.js";

const editedNote = (platform: string): string =>
  `Message updated on ${platform}. Nobody was notified — an edit changes what is already there, so anything NEW to say still needs a \`reply\`.`;

const MESSAGE_ID = z
  .string()
  .min(1)
  .max(200)
  .describe("The id `reply` returned for the message you are correcting — your own post in this conversation.");

const EDIT_TEXT = z
  .string()
  .min(1)
  .describe("The FULL replacement text. It replaces the message outright, so write the whole corrected message, not just the change.");

export const unifiedEditReplyEntry = defineTool({
  description:
    "Correct one of your own recent posts, in place, instead of posting a follow-up. Use it for a " +
    "cosmetic fix to something you already said — a typo, or a list or summary that has moved on. " +
    "Pass the `wake-id` of the conversation the message is in and the message id `reply` gave you, " +
    "and `text` REPLACES that message outright. It edits only your own posts, it adds no new message " +
    "and notifies nobody, and the surface marks the message as edited. Not every surface can edit — " +
    "where the platform has no edit API the call is refused and says so, and you post a `reply` " +
    "instead. For anything NEW to say, and for withdrawing something you got wrong, post a `reply`.",
  inputSchema: z.object({
    text: EDIT_TEXT,
    wake: z.string().min(1).describe("The `wake-id` of the conversation holding the message — the same id you replied under."),
    message_id: MESSAGE_ID,
  }),
  outputSchema: z.object({ edited: z.boolean(), id: z.string(), note: z.string() }),
  async execute(input, ctx) {
    const bind = ctx as BindableContext;
    const turnWake = currentWakeId(bind);
    const windowToken = resolveOwnWindowToken(bind);
    const turnId = currentTurnId(bind);
    const org = deploymentOrg();
    const store = getOperationalStore();

    const resolution = await resolveAnswerableReplyTarget(store, org, turnWake, windowToken, turnId, input.wake);
    if (!resolution.ok) {
      await auditReplyEditRefused(replyAuditFor(bind, "tool", input.wake), resolution.reason);
      throw new Error(replyRefusalMessage(resolution.reason, input.wake, { turnWake, silent: silentRoutineThisTurn() }));
    }
    const origin = resolution.origin;
    const locus = await resolveUnifiedEditLocus(origin);
    if (!locus) {
      await auditReplyEditRefused(replyAuditFor(bind, "tool", input.wake), EDIT_NO_ARM_REFUSAL_REASON);
      throw new Error(editRefusalMessage(EDIT_NO_ARM_REFUSAL_REASON, origin.platform));
    }

    const owingTask = pendingDelegationOwing(turnId, input.wake, addressedWakeThisTurn(turnId));
    const framed = withPendingWorkFrame(input.text, owingTask !== undefined);

    await editPostedMessage(locus, input.message_id, framed, replyAuditFor(bind, "tool", input.wake));
    return { edited: true, id: input.message_id, note: editedNote(origin.platform) };
  },
});
preRegisterDynamicEntry("edit_reply", "_single", unifiedEditReplyEntry);

const baseEditReplyEntry = defineTool({
  description:
    "Correct one of your own recent posts in this conversation, in place, instead of posting a " +
    "follow-up. Use it for a cosmetic fix to something you already said — a typo, or a list or " +
    "summary that has moved on. Pass the message id `reply` gave you; `text` REPLACES that message " +
    "outright. It edits only your own posts, it adds no new message and notifies nobody, and the " +
    "surface marks the message as edited. Not every surface can edit — where the platform has no " +
    "edit API the call is refused and says so, and you post a `reply` instead. For anything NEW to " +
    "say, and for withdrawing something you got wrong, post a `reply`.",
  inputSchema: z.object({ text: EDIT_TEXT, message_id: MESSAGE_ID }),
  outputSchema: z.object({ edited: z.boolean(), id: z.string(), note: z.string() }),
  async execute(input, ctx) {
    const bind = ctx as BindableContext;
    const target = resolveReplyTarget(bind);
    if (!target) {
      throw new Error(
        "edit_reply couldn't resolve this conversation — try again from a real channel, thread, or discussion, not a synthetic context.",
      );
    }
    const locus = replyEditLocus(target);
    if (!locus) {
      await auditReplyEditRefused(replyAuditFor(bind, "tool"), EDIT_NO_ARM_REFUSAL_REASON);
      throw new Error(editRefusalMessage(EDIT_NO_ARM_REFUSAL_REASON, target.platform));
    }
    await editPostedMessage(locus, input.message_id, input.text, replyAuditFor(bind, "tool"));
    return { edited: true, id: input.message_id, note: editedNote(locus.platform) };
  },
});
preRegisterDynamicEntry("edit_reply", "_base", baseEditReplyEntry);

export default defineDynamic({
  events: {
    "session.started": (_event, ctx) => {
      const c = ctx as BindableContext;
      return isUnifiedWindowContext(c) ? unifiedEditReplyEntry : baseEditReplyEntry;
    },
  },
});
