import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { bindFrom, deploymentOrg, inheritedWakeStampOf, isUnifiedWindowContext, currentWakeId, currentSessionId, currentTurnId, windowGrainOf, windowTaskLabelOf, type BindableContext } from "../identity/binding.js";
import { resolvePartition } from "../memory/partition.js";
import { flushWriteIntentMemory, type MemoryPersistContext } from "../hooks/memory.js";
import { isThreadStopped } from "../channels/engagement.js";
import { noteTurnCloseoutRefusal } from "../model/turn-closeout.js";
import { durableTurnKey, noteStoppedAck, stoppedAckSpent } from "../model/turn-state.js";
import { capabilitiesFor } from "../identity/capabilities.js";
import {
  resolveReplyTarget,
  replyEditLocus,
  postReply,
  auditReplyRefused,
  auditReplyForced,
  replyAuditFor,
  REPLY_DEDUPE_SKIPPED_ID,
  type ReplierLabel,
} from "../channels/reply-post.js";
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
import { replierLabelFor, PENDING_WORK_INSTRUCTION } from "../channels/turn-delivery.js";
import { withRunRefusalBlock } from "../routines/report.js";
import { consumeRoutineRunPermissionRefusals } from "../approvals/card-signal.js";
import {
  markRepliedThisTurn,
  markWakeDoneThisTurn,
  markWakeRepliedThisTurn,
  isWakeDoneThisTurn,
  isWakeDeclinedThisTurn,
  markDoneRefusedThisTurn,
  wasDoneRefusedThisTurn,
  WAKE_DECLINED_REFUSAL_REASON,
  WAKE_DONE_REFUSAL_REASON,
  WAKE_DONE_FORCED_AUDIT_REASON,
  wakeDeclinedRefusalMessage,
  REPLY_STOPPED_REFUSAL_REASON,
  markStoppedAckThisTurn,
  wasStoppedAckSpentThisTurn,
  noteForcedOverrideThisTurn,
  FORCED_OVERRIDE_TURN_LIMIT,
  REPLY_FORCED_LOOP_REASON,
} from "../channels/reply-signal.js";
import { markStandDownSilenceThisTurn, REPLY_STAND_DOWN_ACK_ACTION } from "../channels/stand-down-silence.js";
import { auditToolAction } from "../audit/tool-action.js";
import { END_TURN_WITH_SENTINEL_INSTRUCTION } from "../channels/normalized-wake.js";
import {
  resolveAnswerableReplyTarget,
  replyRefusalMessage,
  answeredThisTurnRefusalMessage,
  boundConversationOrigin,
  sameUnifiedConversation,
  deliveryReachedOwedConversation,
} from "../channels/unified-window.js";
import { addressedWakeThisTurn, claimTasksForAddressedWake } from "../access/dispatch-origin-signal.js";
import {
  DELEGATION_PENDING_REFUSAL_REASON,
  SETTLEMENT_REPORT_POSTED_ACTION,
  delegationPendingRefusalMessage,
  dischargeSettlementReport,
  notePromisedReport,
  pendingDelegationOwing,
  pendingDelegationThisTurn,
  pendingDelegationsOwing,
  settlementReportOwedOn,
} from "../access/pending-delegation-signal.js";
import { retargetTaskWakes, taskWakeUnreadRefusalMessage, TASK_WAKE_UNREAD_REFUSAL_REASON } from "../channels/task-wake.js";
import { rememberWorkReportPromised, workRequestIdOfLedger } from "../channels/work.js";
import { deliveryChangedThisTurn, uningressedTurn } from "../access/task-wake-signal.js";
import { silentRoutineThisTurn } from "../routines/report.js";
import { resolveOwnWindowToken } from "../access/delegation-mount.js";
import { postUnifiedReply, unifiedEditLocus, terminalPostClosesConversation } from "../channels/unified-reply.js";
import { getOperationalStore } from "../operational/provider.js";
import { preRegisterDynamicVariants } from "../access/window-gated.js";
import { FOLLOW_UPS_INPUT } from "../channels/reply-follow-ups.js";
import { answerSurfaceSession, surfaceTurnOf, SURFACE_SIGN_CLEARED_ACTION } from "../channels/surface-session-state.js";

function replierFor(ctx: BindableContext): ReplierLabel | undefined {
  return replierLabelFor(windowGrainOf(ctx), windowTaskLabelOf(ctx));
}

interface StandDownState {
  readonly stopped: boolean;
  readonly refuse: boolean;
}

const STAND_DOWN_CLEAR: StandDownState = { stopped: false, refuse: false };

function stoppedRefusalText(): string {
  return (
    "You were asked to stand down in this conversation and that stop is recorded, so nothing was posted. " +
    "You have already posted here once this turn; anything further is exactly what the person asked you to stop doing. " +
    `${END_TURN_WITH_SENTINEL_INSTRUCTION} Someone @mentioning you is what brings you back.`
  );
}

async function standDownState(
  bind: BindableContext,
  turnId: string | undefined,
  namesBoundConversation?: () => Promise<boolean>,
): Promise<StandDownState> {
  try {
    const binding = bindFrom(bind);
    const stopped = await isThreadStopped(resolvePartition(bind), binding.engagementKey ?? binding.threadTs);
    if (!stopped) return STAND_DOWN_CLEAR;
    if (namesBoundConversation !== undefined && !(await namesBoundConversation())) return STAND_DOWN_CLEAR;
    if (wasStoppedAckSpentThisTurn(turnId)) return { stopped, refuse: true };
    const rowKey = standDownRowKey(bind, turnId);
    return { stopped, refuse: rowKey !== undefined && (await stoppedAckSpent(rowKey)) };
  } catch {
    return STAND_DOWN_CLEAR;
  }
}

function standDownRowKey(bind: BindableContext, turnId: string | undefined): string | undefined {
  if (turnId === undefined || turnId.length === 0) return undefined;
  try {
    return durableTurnKey(currentSessionId(bind), turnId);
  } catch {
    return undefined;
  }
}

async function spendStoppedAck(bind: BindableContext, turnId: string | undefined, arm: "unified" | "per-surface"): Promise<void> {
  markStoppedAckThisTurn(turnId);
  markStandDownSilenceThisTurn(turnId);
  const rowKey = standDownRowKey(bind, turnId);
  if (rowKey !== undefined) await noteStoppedAck(rowKey);
  let anchor: string | undefined;
  let sessionId: string | undefined;
  try {
    const binding = bindFrom(bind);
    anchor = binding.engagementKey ?? binding.threadTs;
    sessionId = currentSessionId(bind);
  } catch {
  }
  await auditToolAction(bind, REPLY_STAND_DOWN_ACK_ACTION, {
    arm,
    ...(anchor !== undefined ? { anchor } : {}),
    ...(sessionId !== undefined ? { sessionId } : {}),
  });
}

export const unifiedReplyEntry = defineTool({
    endsTurn: true,
    description:
      "Post a reply into the conversation a specific wake came from. A successful reply ENDS " +
      "your turn, so put what this wake needs into it. You are a cross-surface session: each " +
      "wake envelope carries a `wake-id` naming where it came from — pass the wake-id of the " +
      "wake you are answering, this turn's or any earlier wake in this session you have not yet " +
      "answered, and your reply is posted into exactly that conversation (its Slack thread, its " +
      "GitHub issue, …). You cannot target anywhere else. Your terminal text is never posted, so " +
      "this tool is the only way your words reach anyone. To answer several wakes, call `reply` " +
      "once per wake in the same step. If a worker you started is still working, the turn waits " +
      "for its result after your reply and you are called again with it. One answer is ONE " +
      "reply: once you answer a wake with `done: true`, replying to that same wake again in " +
      "this turn is refused. Wherever the conversation can still take one, a second message is " +
      "discouraged rather than blocked. For a short line that says what will happen while the full answer " +
      "comes later, pass `done: false`.",
    inputSchema: z.object({
      text: z.string().min(1).describe("The message to post (the target surface's markdown). One curated message, not a stack."),
      wake: z.string().min(1).describe("The `wake-id` from the envelope of the wake you are answering — your reply posts into that wake's conversation."),
      done: z
        .boolean()
        .optional()
        .default(true)
        .describe(
          "Leave true (the default) to mark this wake answered. Once you mark a wake done, a further reply to that SAME wake in this same turn is REFUSED and posts nothing; a second message is discouraged rather than blocked, and `force: true` posts it at the cost of a near-duplicate in the room. On a surface where your answer CLOSES the conversation — a Linear @mention reply ends the agent session it answers — nothing further can land, so that refusal stands and `force` does not open it. Set false ONLY when you know you will reply to this same wake again later — e.g. you are reporting progress now and the full answer comes after delegated work finishes. While a background worker you started this turn has not reported, `done: true` is REFUSED: you do not have its answer yet, so post a short line with `done: false` that says what will happen, never that a worker has it, and answer when the report arrives.",
        ),
      force: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          "Leave false. Set true ONLY to override a host refusal about the state of the room: that this conversation has moved on (newer messages you have not read are on their way to you), that your own last message here is still the newest one and this should be an edit, or that you already answered this wake in this turn. It posts your reply anyway. It does NOT override a refusal about what the room can still receive — where your answer closed the conversation, no flag reopens it. Use it when posting NOW as a separate message matters more — a time-critical alert, a line that says what will happen, or something that genuinely has to notify the room again. It costs the room a near-duplicate to read, and it is recorded.",
        ),
      followUps: FOLLOW_UPS_INPUT,
    }),
    outputSchema: z.object({ posted: z.boolean(), id: z.string(), note: z.string() }),
    async execute(input, ctx) {
      const bind = ctx as BindableContext;
      const turnWake = currentWakeId(bind);
      const windowToken = resolveOwnWindowToken(bind);
      const turnId = currentTurnId(bind);

      if (isWakeDeclinedThisTurn(turnId, input.wake)) {
        await noteTurnCloseoutRefusal(bind, WAKE_DECLINED_REFUSAL_REASON);
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

      const standDown = await standDownState(bind, turnId, async () => {
        if (input.wake === turnWake) return true;
        const boundOrigin = await boundConversationOrigin(store, org, turnWake);
        return boundOrigin !== undefined && sameUnifiedConversation(boundOrigin, origin);
      });
      if (standDown.refuse) {
        await noteTurnCloseoutRefusal(bind, REPLY_STOPPED_REFUSAL_REASON);
        await auditReplyRefused(replyAuditFor(bind, "tool", input.wake), REPLY_STOPPED_REFUSAL_REASON);
        throw new Error(stoppedRefusalText());
      }

      let doneOverrides = 0;
      let staleOverrides = 0;
      let doneForced = false;
      if (isWakeDoneThisTurn(turnId, input.wake)) {
        if (terminalPostClosesConversation(origin)) {
          await auditReplyRefused(replyAuditFor(bind, "tool", input.wake), WAKE_DONE_REFUSAL_REASON);
          throw new Error(replyRefusalMessage("answered", input.wake));
        }
        if (input.force === true) {
          doneForced = true;
        } else if (!wasDoneRefusedThisTurn(turnId, input.wake)) {
          markDoneRefusedThisTurn(turnId, input.wake);
          await auditReplyRefused(replyAuditFor(bind, "tool", input.wake), WAKE_DONE_REFUSAL_REASON);
          throw new Error(answeredThisTurnRefusalMessage(input.wake));
        }
      }

      const owingTask = pendingDelegationOwing(turnId, input.wake, addressedWakeThisTurn(turnId));
      if (owingTask !== undefined && input.done !== false) {
        await auditReplyRefused(replyAuditFor(bind, "tool", input.wake), DELEGATION_PENDING_REFUSAL_REASON);
        throw new Error(delegationPendingRefusalMessage());
      }

      if (doneForced) {
        doneOverrides = noteForcedOverrideThisTurn(turnId, WAKE_DONE_FORCED_AUDIT_REASON, input.wake);
        if (doneOverrides === 1) await auditReplyForced(replyAuditFor(bind, "tool", input.wake), WAKE_DONE_FORCED_AUDIT_REASON);
      }

      if (!wasStaleRefusedThisTurn(turnId, input.wake)) {
        const freshness = await replyFreshness(store, org, { target: origin, windowToken, inputWake: input.wake, turnWake });
        if (freshness.stale && input.force !== true) {
          markStaleRefusedThisTurn(turnId, input.wake);
          await auditReplyRefused(replyAuditFor(bind, "tool", input.wake), REPLY_STALE_REFUSAL_REASON);
          throw new Error(staleReplyRefusalMessage(freshness));
        }
        if (freshness.stale) {
          staleOverrides = noteForcedOverrideThisTurn(turnId, REPLY_FORCED_AUDIT_REASON, input.wake);
          if (staleOverrides === 1) await auditReplyForced(replyAuditFor(bind, "tool", input.wake), REPLY_FORCED_AUDIT_REASON);
        }
      }

      const owedReport = settlementReportOwedOn(turnId);
      const isSettlementReport =
        owedReport !== undefined && (await deliveryReachedOwedConversation(store, org, owedReport.wake, input.wake, origin));

      const foldOverrides = await refuseIfShouldFold({
        store,
        window: tailWindow(),
        platform: origin.platform,
        locus: unifiedEditLocus(origin),
        turnId,
        audit: replyAuditFor(bind, "tool", input.wake),
        answeringWake: input.wake,
        force: input.force === true,
        settlementReport: isSettlementReport,
      });

      const framed = withRunRefusalBlock(input.text, consumeRoutineRunPermissionRefusals(input.wake));

      await flushWriteIntentMemory(ctx as MemoryPersistContext);

      const id = await postUnifiedReply(
        origin,
        framed,
        {},
        replyAuditFor(ctx as BindableContext, "tool", input.wake),
        replierFor(bind),
        { terminal: input.done !== false },
        { followUps: input.followUps ?? [] },
      );
      markRepliedThisTurn(turnId);
      if (standDown.stopped) await spendStoppedAck(bind, turnId, "unified");
      markWakeRepliedThisTurn(turnId, input.wake);

      if (owingTask !== undefined) {
        for (const task of pendingDelegationsOwing(turnId, input.wake, addressedWakeThisTurn(turnId))) {
          notePromisedReport(task);
          const requestId = workRequestIdOfLedger(task);
          if (requestId !== undefined) await rememberWorkReportPromised(store, org, requestId, new Date().toISOString()).catch(() => undefined);
        }
      }
      if (owedReport !== undefined && isSettlementReport) {
        dischargeSettlementReport();
        await auditToolAction(ctx, SETTLEMENT_REPORT_POSTED_ACTION, { task: owedReport.task, wake: input.wake });
      }

      const claimed = claimTasksForAddressedWake(turnId, input.wake);
      if (claimed.length > 0) {
        await retargetTaskWakes({ org, tasks: claimed, addressedWakeId: input.wake, windowToken, turnId });
      }

      if (input.done !== false) {
        await store.markUnifiedWakeAnswered(org, input.wake, new Date().toISOString(), turnId).catch(() => undefined);
        markWakeDoneThisTurn(turnId, input.wake);
        const surface = surfaceTurnOf(ctx);
        const answersOwnWake = input.wake === inheritedWakeStampOf(bind) || (input.wake === turnWake && !deliveryChangedThisTurn(turnId));
        if (surface !== undefined && answersOwnWake && (await answerSurfaceSession(surface)) !== undefined) {
          await auditToolAction(bind, SURFACE_SIGN_CLEARED_ACTION, { wake: input.wake, ...(turnId !== undefined ? { turnId } : {}) });
        }
      }
      const overrides = Math.max(doneOverrides, staleOverrides, foldOverrides);
      if (overrides >= FORCED_OVERRIDE_TURN_LIMIT) await noteTurnCloseoutRefusal(bind, REPLY_FORCED_LOOP_REASON);

      const doneNote =
        input.done !== false
          ? doneOverrides === 0
            ? " This wake is now ANSWERED — do not reply to it again in this turn; a second call is refused."
            : " This wake was already ANSWERED and you overrode that verdict, so a further call is NOT refused — it just repeats you in the room."
          : " This wake stays OPEN (`done:false`) — reply to it again when the rest of the answer is ready.";
      const editSteer = id === REPLY_DEDUPE_SKIPPED_ID ? "`edit_reply`" : `\`edit_reply\` with wake \`${input.wake}\` and message_id \`${id}\``;
      const overrideNote =
        overrides === 0
          ? ""
          : overrides >= FORCED_OVERRIDE_TURN_LIMIT
            ? ` You have now overridden the same host verdict ${overrides} times in this turn, so this turn ENDS after your next step. Post nothing further here: to correct what you said, call ${editSteer}.`
            : ` You overrode a host verdict, so this landed as a SECOND message beside your own last one. Prefer ${editSteer} over a third message here, and finish with \`no_reply\` when you are done.`;
      const tailNote =
        overrides >= FORCED_OVERRIDE_TURN_LIMIT
          ? " Your terminal prose is still discarded."
          :
            ` Keep working if needed; your terminal prose is still discarded. If nothing is left to do: ${END_TURN_WITH_SENTINEL_INSTRUCTION}`;
      const pendingNote = owingTask !== undefined ? PENDING_WORK_INSTRUCTION : "";
      return {
        posted: true,
        id,
        note: `Turn reply requirement satisfied — posted to ${origin.platform}.${doneNote}${overrideNote}${pendingNote}${tailNote}`,
      };
    },
});

export const baseReplyEntry = defineTool({
        endsTurn: true,
        description:
          "Post a message into this conversation NOW. A successful post ENDS your turn, so put " +
          "the whole answer into it; if a worker you started is still working, the turn waits for " +
          "its result and you are called again with it. A reply NOTIFIES the channel — use it for an answer, a question, a " +
          "result, or a blocker, never for a mere progress tick. Send fewer, curated messages " +
          "rather than a running status: to correct one you already sent, call `edit_reply` with " +
          "the id this tool returned instead of posting again. Posts into the conversation that " +
          "woke you; you can't target another place.",
        inputSchema: z.object({
          text: z.string().min(1).describe("The message to post (channel mrkdwn/markdown). Keep it one curated message, not a stack."),
          followUps: FOLLOW_UPS_INPUT,
        }),
        outputSchema: z.object({ posted: z.boolean(), id: z.string(), note: z.string() }),
        async execute(input, ctx) {
          const target = resolveReplyTarget(ctx);
          if (!target) {
            throw new Error(
              "reply couldn't resolve this conversation — try again from a real channel, thread, or discussion, not a synthetic context.",
            );
          }
          const bindBase = ctx as BindableContext;
          const baseTurnId = currentTurnId(bindBase);
          const standDownBase = await standDownState(bindBase, baseTurnId);
          if (standDownBase.refuse) {
            await noteTurnCloseoutRefusal(bindBase, REPLY_STOPPED_REFUSAL_REASON);
            await auditReplyRefused(replyAuditFor(bindBase, "tool"), REPLY_STOPPED_REFUSAL_REASON);
            throw new Error(stoppedRefusalText());
          }
          const owingTask = pendingDelegationThisTurn(baseTurnId);
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
          await flushWriteIntentMemory(ctx as MemoryPersistContext);
          const id = await postReply(target, input.text, replyAuditFor(bindBase, "tool"), replierFor(bindBase), { followUps: input.followUps ?? [] });
          markRepliedThisTurn(baseTurnId);
          if (standDownBase.stopped) await spendStoppedAck(bindBase, baseTurnId, "per-surface");
          return {
            posted: true,
            id,
            note: `Posted to ${target.platform}.${owingTask !== undefined ? PENDING_WORK_INSTRUCTION : ""}`,
          };
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
