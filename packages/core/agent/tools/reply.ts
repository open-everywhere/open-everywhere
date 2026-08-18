import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { bindFrom, deploymentOrg, isUnifiedWindowContext, currentWakeId, currentTurnId, windowGrainOf, windowTaskLabelOf, type BindableContext } from "../identity/binding.js";
import { capabilitiesFor } from "../identity/capabilities.js";
import { resolveReplyTarget, postReply, auditReplyRefused, type ReplyAudit, type ReplierLabel } from "../channels/reply-post.js";
import { replierLabelFor, withPendingWorkFrame } from "../channels/turn-delivery.js";
import { markRepliedThisTurn, markWakeDoneThisTurn, isWakeDoneThisTurn } from "../channels/reply-signal.js";
import { resolveAnswerableReplyTarget, replyRefusalMessage } from "../channels/unified-window.js";
import { addressedWakeThisTurn, claimTasksForAddressedWake } from "../access/dispatch-origin-signal.js";
import { DELEGATION_PENDING_REFUSAL_REASON, delegationPendingRefusalMessage, pendingDelegationOwing } from "../access/pending-delegation-signal.js";
import { retargetTaskWakes, taskWakeUnreadRefusalMessage, TASK_WAKE_UNREAD_REFUSAL_REASON } from "../channels/task-wake.js";
import { uningressedTurn } from "../access/task-wake-signal.js";
import { silentRoutineThisTurn } from "../routines/report.js";
import { resolveOwnWindowToken } from "../access/oneshot-spawn.js";
import { postUnifiedReply } from "../channels/unified-reply.js";
import { getOperationalStore } from "../operational/provider.js";
import { resolvePartition } from "../memory/partition.js";
import { preRegisterDynamicEntry } from "../access/window-gated.js";

function replierFor(ctx: BindableContext): ReplierLabel | undefined {
  return replierLabelFor(windowGrainOf(ctx), windowTaskLabelOf(ctx));
}

function replyAuditFor(ctx: BindableContext, route: ReplyAudit["route"], wakeId?: string): ReplyAudit {
  const p = resolvePartition(ctx);
  const sessionId = (ctx as { session?: { id?: string } }).session?.id;
  return {
    org: p.org,
    platform: p.platform,
    workspace: p.workspace,
    surface: p.surface,
    principalId: bindFrom(ctx).principalId,
    ...(sessionId ? { sessionId } : {}),
    ...(wakeId ? { wakeId } : {}),
    route,
  };
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
    }),
    outputSchema: z.object({ posted: z.boolean(), id: z.string(), note: z.string() }),
    async execute(input, ctx) {
      const bind = ctx as BindableContext;
      const turnWake = currentWakeId(bind);
      const windowToken = resolveOwnWindowToken(bind);
      const turnId = currentTurnId(bind);

      if (isWakeDoneThisTurn(turnId, input.wake)) {
        await auditReplyRefused(replyAuditFor(bind, "tool", input.wake), "answered-this-turn");
        throw new Error(replyRefusalMessage("answered", input.wake));
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

      const framed = withPendingWorkFrame(input.text, owingTask !== undefined);

      const id = await postUnifiedReply(origin, framed, {}, replyAuditFor(ctx as BindableContext, "tool", input.wake), replierFor(bind));
      markRepliedThisTurn();

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
            " This post was delivered under a host line saying a delegated worker is still running and this message is not its result, so do not add that caveat yourself."
          : "";
      return {
        posted: true,
        id,
        note: `Turn reply requirement satisfied — posted to ${origin.platform}.${doneNote}${pendingNote} Keep working if needed; your terminal prose is still discarded.`,
      };
    },
});
preRegisterDynamicEntry("reply", "_single", unifiedReplyEntry);

const baseReplyEntry = defineTool({
        description:
          "Post a message into this conversation NOW, without ending your turn. Posting is an " +
          "action, not turn-completion: reply, keep working, and finish with `no_reply` when " +
          "you're done. A reply NOTIFIES the channel — use it for an answer, a question, a " +
          "result, or a blocker, never for a mere progress tick. Posts are FINAL — send fewer, " +
          "curated messages rather than a running status. Posts into the conversation that woke " +
          "you; you can't target another place.",
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
          const id = await postReply(target, input.text, replyAuditFor(ctx as BindableContext, "tool"), replierFor(ctx as BindableContext));
          markRepliedThisTurn();
          return { posted: true, id };
        },
});
preRegisterDynamicEntry("reply", "_base", baseReplyEntry);

export default defineDynamic({
  events: {
    "session.started": (_event, ctx) => {
      if (isUnifiedWindowContext(ctx as BindableContext)) return unifiedReplyEntry;
      if (!capabilitiesFor(ctx as BindableContext).midTurnPost) return null;
      return baseReplyEntry;
    },
  },
});
