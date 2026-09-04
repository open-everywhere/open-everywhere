import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { deploymentOrg, isUnifiedWindowContext, currentWakeId, currentTurnId, windowGrainOf, windowTaskLabelOf, type BindableContext } from "../identity/binding.js";
import { capabilitiesFor } from "../identity/capabilities.js";
import { resolveReplyTarget, replyEditLocus, postReply, auditReplyRefused, auditReplyForced, replyAuditFor, type ReplierLabel } from "../channels/reply-post.js";
import {
  replyFreshness,
  staleReplyRefusalMessage,
  markStaleRefusedThisTurn,
  wasStaleRefusedThisTurn,
  REPLY_STALE_REFUSAL_REASON,
  REPLY_FORCED_AUDIT_REASON,
} from "../channels/reply-freshness.js";
import { refuseIfShouldFold } from "../channels/reply-fold.js";
import { tailWindow } from "../channels/session-tail-record.js";
import { replierLabelFor, withPendingWorkFrame } from "../channels/turn-delivery.js";
import { withRunRefusalBlock } from "../routines/report.js";
import { consumeRoutineRunPermissionRefusals } from "../approvals/card-signal.js";
import { noteTerminalCallGrain } from "../channels/turn-terminal-actions.js";
import { markRepliedThisTurn, markWakeDoneThisTurn, markWakeRepliedThisTurn, isWakeDoneThisTurn, isWakeDeclinedThisTurn, WAKE_DECLINED_REFUSAL_REASON, WAKE_DONE_REFUSAL_REASON, wakeDeclinedRefusalMessage } from "../channels/reply-signal.js";
import { resolveAnswerableReplyTarget, replyRefusalMessage } from "../channels/unified-window.js";
import { addressedWakeThisTurn, claimTasksForAddressedWake } from "../access/dispatch-origin-signal.js";
import { DELEGATION_PENDING_REFUSAL_REASON, delegationPendingRefusalMessage, pendingDelegationOwing } from "../access/pending-delegation-signal.js";
import { retargetTaskWakes, taskWakeUnreadRefusalMessage, TASK_WAKE_UNREAD_REFUSAL_REASON } from "../channels/task-wake.js";
import { uningressedTurn } from "../access/task-wake-signal.js";
import { silentRoutineThisTurn } from "../routines/report.js";
import { resolveOwnWindowToken } from "../access/delegation-mount.js";
import { postUnifiedReply, unifiedEditLocus } from "../channels/unified-reply.js";
import { getOperationalStore } from "../operational/provider.js";
import { preRegisterDynamicVariants } from "../access/window-gated.js";

function replierFor(ctx: BindableContext): ReplierLabel | undefined {
  return replierLabelFor(windowGrainOf(ctx), windowTaskLabelOf(ctx));
}

export const unifiedReplyEntry = defineTool({
    description:
      "Post a reply into the conversation a specific wake came from, without ending your turn. " +
      "You are a cross-surface session: each wake envelope carries a `wake-id` naming where it " +
      "came from — pass the wake-id of the wake you are answering, this turn's or any earlier " +
      "wake in this session you have not yet answered, and your reply is posted into exactly " +
      "that conversation (its Slack thread, its GitHub issue, …). You cannot target anywhere " +
      "else. Posting is an action, not turn-completion: reply, keep working, and finish with " +
      "`no_reply` when you're done — your terminal text is never posted. One answer is ONE " +
      "reply: once you answer a wake with `done: true`, replying to that same wake again in " +
      "this turn is refused. When you plan a multi-part answer, pass `done: false` on the " +
      "earlier parts.",
    inputSchema: z.object({
      text: z.string().min(1).describe("The message to post (the target surface's markdown). One curated message, not a stack."),
      wake: z.string().min(1).describe("The `wake-id` from the envelope of the wake you are answering — your reply posts into that wake's conversation."),
      done: z
        .boolean()
        .optional()
        .default(true)
        .describe(
          "Leave true (the default) to mark this wake answered. Once you mark a wake done, a further reply to that SAME wake in this same turn is REFUSED and posts nothing. Set false ONLY when you know you will reply to this same wake again later — e.g. you are reporting progress now and the full answer comes after delegated work finishes. While a background worker you started this turn has not reported, `done: true` is REFUSED: you do not have its answer yet, so post a hand-off note with `done: false` and answer when the report arrives.",
        ),
      force: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          "Leave false. Set true ONLY to override a host refusal about the state of the room: that this conversation has moved on (newer messages you have not read are on their way to you), or that your own last message here is still the newest one and this should be an edit. It posts your reply anyway. Use it when posting NOW as a separate message matters more — a time-critical alert, a hand-off note, or something that genuinely has to notify the room again. It costs the room a near-duplicate to read, and it is recorded.",
        ),
    }),
    outputSchema: z.object({ posted: z.boolean(), id: z.string(), note: z.string() }),
    async execute(input, ctx) {
      const bind = ctx as BindableContext;
      const turnWake = currentWakeId(bind);
      const windowToken = resolveOwnWindowToken(bind);
      const turnId = currentTurnId(bind);

      if (isWakeDoneThisTurn(turnId, input.wake)) {
        await auditReplyRefused(replyAuditFor(bind, "tool", input.wake), WAKE_DONE_REFUSAL_REASON);
        throw new Error(replyRefusalMessage("answered", input.wake));
      }

      if (isWakeDeclinedThisTurn(turnId, input.wake)) {
        await auditReplyRefused(replyAuditFor(bind, "tool", input.wake), WAKE_DECLINED_REFUSAL_REASON);
        throw new Error(wakeDeclinedRefusalMessage());
      }

      if (turnWake === undefined && uningressedTurn(turnId)) {
        await auditReplyRefused(replyAuditFor(bind, "tool", input.wake), TASK_WAKE_UNREAD_REFUSAL_REASON);
        throw new Error(taskWakeUnreadRefusalMessage());
      }

      const org = deploymentOrg();
      const store = getOperationalStore();
      const resolution = await resolveAnswerableReplyTarget(store, org, turnWake, windowToken, turnId, input.wake);
      if (!resolution.ok) {
        await auditReplyRefused(replyAuditFor(bind, "tool", input.wake), resolution.reason);
        throw new Error(replyRefusalMessage(resolution.reason, input.wake, { turnWake, silent: silentRoutineThisTurn() }));
      }
      const origin = resolution.origin;

      const owingTask = pendingDelegationOwing(turnId, input.wake, addressedWakeThisTurn(turnId));
      if (owingTask !== undefined && input.done !== false) {
        await auditReplyRefused(replyAuditFor(bind, "tool", input.wake), DELEGATION_PENDING_REFUSAL_REASON);
        throw new Error(delegationPendingRefusalMessage());
      }

      if (!wasStaleRefusedThisTurn(turnId, input.wake)) {
        const freshness = await replyFreshness(store, org, { target: origin, windowToken, inputWake: input.wake, turnWake });
        if (freshness.stale && input.force !== true) {
          markStaleRefusedThisTurn(turnId, input.wake);
          await auditReplyRefused(replyAuditFor(bind, "tool", input.wake), REPLY_STALE_REFUSAL_REASON);
          throw new Error(staleReplyRefusalMessage(freshness));
        }
        if (freshness.stale) await auditReplyForced(replyAuditFor(bind, "tool", input.wake), REPLY_FORCED_AUDIT_REASON);
      }

      await refuseIfShouldFold({
        store,
        window: tailWindow(),
        platform: origin.platform,
        locus: unifiedEditLocus(origin),
        turnId,
        audit: replyAuditFor(bind, "tool", input.wake),
        answeringWake: input.wake,
        force: input.force === true,
      });

      const framed = withRunRefusalBlock(withPendingWorkFrame(input.text, owingTask !== undefined), consumeRoutineRunPermissionRefusals());

      const id = await postUnifiedReply(
        origin,
        framed,
        {},
        replyAuditFor(ctx as BindableContext, "tool", input.wake),
        replierFor(bind),
        { terminal: input.done !== false },
      );
      markRepliedThisTurn(turnId);
      markWakeRepliedThisTurn(turnId, input.wake);
      noteTerminalCallGrain(bind);

      const claimed = claimTasksForAddressedWake(turnId, input.wake);
      if (claimed.length > 0) {
        await retargetTaskWakes({ org, tasks: claimed, addressedWakeId: input.wake, windowToken, turnId });
      }

      if (input.done !== false) {
        await store.markUnifiedWakeAnswered(org, input.wake, new Date().toISOString(), turnId).catch(() => undefined);
        markWakeDoneThisTurn(turnId, input.wake);
      }
      const doneNote =
        input.done !== false
          ? " This wake is now ANSWERED — do not reply to it again in this turn; a second call is refused."
          : " This wake stays OPEN (`done:false`) — reply to it again when the rest of the answer is ready.";
      const pendingNote =
        owingTask !== undefined
          ? " Your background worker for this conversation has NOT reported yet, so you do not have the answer it was asked for — never write that answer out yourself; report what the worker returns." +
            " This post was delivered under a host line saying this is still being worked on and what follows is an interim update, not the final result, so do not add that caveat yourself."
          : "";
      return {
        posted: true,
        id,
        note: `Turn reply requirement satisfied — posted to ${origin.platform}.${doneNote}${pendingNote} Keep working if needed; your terminal prose is still discarded.`,
      };
    },
});

export const baseReplyEntry = defineTool({
        description:
          "Post a message into this conversation NOW, without ending your turn. Posting is an " +
          "action, not turn-completion: reply, keep working, and finish with `no_reply` when " +
          "you're done. A reply NOTIFIES the channel — use it for an answer, a question, a " +
          "result, or a blocker, never for a mere progress tick. Send fewer, curated messages " +
          "rather than a running status: to correct one you already sent, call `edit_reply` with " +
          "the id this tool returned instead of posting again. Posts into the conversation that " +
          "woke you; you can't target another place.",
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
          const bindBase = ctx as BindableContext;
          const baseTurnId = currentTurnId(bindBase);
          const foldWindow = tailWindow();
          if (foldWindow) {
            await refuseIfShouldFold({
              store: getOperationalStore(),
              window: foldWindow,
              platform: target.platform,
              locus: replyEditLocus(target),
              turnId: baseTurnId,
              audit: replyAuditFor(bindBase, "tool"),
            });
          }
          const id = await postReply(target, input.text, replyAuditFor(bindBase, "tool"), replierFor(bindBase));
          markRepliedThisTurn(baseTurnId);
          noteTerminalCallGrain(bindBase);
          return { posted: true, id };
        },
});
preRegisterDynamicVariants("reply", { _base: baseReplyEntry, _single: unifiedReplyEntry });

export default defineDynamic({
  events: {
    "session.started": (_event, ctx) => {
      const bind = ctx as BindableContext;
      if (isUnifiedWindowContext(bind)) return unifiedReplyEntry;
      const manifest = capabilitiesFor(bind);
      if (!manifest.midTurnPost) return null;
      return baseReplyEntry;
    },
  },
});
