import { defineTool } from "eve/tools";
import { z } from "zod";
import { windowGated } from "../access/window-gated.js";
import { oneshotAgentEnabled } from "../access/delegation-flag.js";
import { forwardsToWorkSession } from "../access/work-session.js";
import { resolveOwnWindowToken } from "../access/delegation-mount.js";
import { notePendingDelegation } from "../access/pending-delegation-signal.js";
import { taintKindsThisTurn, untrustedIngestedThisTurn } from "../access/taint-signal.js";
import { currentSessionId, currentTurnId, currentWakeId, deploymentOrg, platformIdentityAttributesFor, type BindableContext } from "../identity/binding.js";
import { resolveUnifiedWakeAuthority } from "../channels/unified-window.js";
import { dispatchWorkRequest } from "../channels/unified.js";
import { clearGenerationDelegation, generationOfTask, noteGenerationDelegation } from "../channels/generation-retirement.js";
import { continuationRoute, resolveWorkGeneration, workSessionLedgerId, type ContinuationRoute, type WorkGeneration } from "../channels/work-generation.js";
import { notifyLostWorkRequests } from "../channels/work-loss.js";
import { OE_WORK_RESULT_QUIET_ATTR, readWorkBrief, readWorkRequest, readWorkTaskRequest, renderFreshFollowUpBrief, renderJobBrief, renderWorkRequest, rememberWorkBrief, rememberWorkReportPromised, rememberWorkRequest, workLedgerId, workRequestIdFor, workTokenForSeat, WORK_FORWARDED_ACTION, WORK_FORWARD_FAILED_ACTION, type WorkRowStore } from "../channels/work.js";
import { parseWindowToken, isWorkWindowToken } from "../channels/window-key.js";
import { ownAccountStampToForward } from "../connections/own-account-carriage.js";
import { getOperationalStore } from "../operational/provider.js";
import { outboundKey, postOnce, type ForgetEventSeen, type MarkEventSeen } from "../operational/post-once.js";
import { appendAudit } from "../audit/audit.js";
import { auditErrorDetail } from "../audit/tool-action.js";
import { DispatchNotDeliveredError } from "../channels/self-dispatch.js";
import { rememberWorkForward } from "../hooks/work-task-key.js";
import { currentInvokerPosture } from "../access/invoker-posture-state.js";
import { requesterAsksForWake } from "../access/requester-messages.js";
import { auditTaskContinuation, continuationAdmitted, taskContinuationRefusalMessage } from "../channels/task-provenance.js";
import { NO_HANDOFF_NARRATION_RULE } from "../instructions/seat-prompt.js";
import { noteJobForwarded } from "../channels/work-surface-wait.js";

function quietResultWake(ctx: BindableContext): boolean {
  const v = (ctx as { session?: { auth?: { current?: { attributes?: Record<string, unknown> } } } }).session?.auth?.current?.attributes?.[OE_WORK_RESULT_QUIET_ATTR];
  return (Array.isArray(v) ? v[0] : v) === "true";
}

export function canForwardWork(ctx: BindableContext): boolean {
  if (!oneshotAgentEnabled()) return false;
  const raw = ctx.channel?.continuationToken;
  if (typeof raw !== "string" || raw.length === 0) return true;
  return forwardsToWorkSession(ctx);
}

export interface ForwardWorkDeps {
  readonly forwards: (ctx: BindableContext) => boolean;
  readonly org: () => string;
  readonly store: () => WorkRowStore & Parameters<typeof resolveUnifiedWakeAuthority>[0];
  readonly dispatch: typeof dispatchWorkRequest;
  readonly markEventSeen?: MarkEventSeen;
  readonly forgetEventSeen?: ForgetEventSeen;
  readonly tainted: () => boolean;
  readonly taintKinds: () => readonly string[];
  readonly audit: (row: Parameters<typeof appendAudit>[0]) => Promise<unknown>;
  readonly resolveWork?: (input: { readonly org: string; readonly seatToken: string; readonly surfaceKey: string; readonly atIso: string }) => Promise<WorkGeneration>;
  readonly notifyLost?: typeof notifyLostWorkRequests;
  readonly requesterAsks?: typeof requesterAsksForWake;
}

const LIVE_DEPS: ForwardWorkDeps = {
  forwards: forwardsToWorkSession,
  org: deploymentOrg,
  store: getOperationalStore,
  dispatch: dispatchWorkRequest,
  tainted: untrustedIngestedThisTurn,
  taintKinds: taintKindsThisTurn,
  audit: appendAudit,
  resolveWork: (input) => resolveWorkGeneration(input),
  notifyLost: notifyLostWorkRequests,
};

export interface WorkReceipt {
  readonly requestId: string;
  readonly note: string;
}

export async function forwardWork(input: { readonly message: string; readonly taskId?: string }, ctx: unknown, deps: ForwardWorkDeps = LIVE_DEPS): Promise<WorkReceipt> {
  const c = ctx as BindableContext;
  if (!oneshotAgentEnabled()) {
    throw new Error("work: delegation (delegation.oneshotAgent) is disarmed on this deployment — no job can be forwarded.");
  }
  if (!deps.forwards(c)) {
    throw new Error("work: this session does not forward to a work session. Only a conversation seat (a domain seat, a thread seat or a DM seat) holds this verb.");
  }
  const seatToken = resolveOwnWindowToken(c);
  const workToken = seatToken === undefined ? undefined : workTokenForSeat(seatToken);
  if (seatToken === undefined || workToken === undefined) {
    throw new Error("work: this seat has no window token, so it has no work session to forward to.");
  }
  const wakeId = currentWakeId(c);
  const org = deps.org();
  const store = deps.store();
  const authority = wakeId ? await resolveUnifiedWakeAuthority(store, org, wakeId).catch(() => null) : null;
  if (!wakeId || !authority) {
    throw new Error("work: couldn't resolve the conversation that asked for this job, so it was NOT forwarded. Try again on a message-driven turn.");
  }
  const callId = typeof (ctx as { callId?: unknown }).callId === "string" ? (ctx as { callId: string }).callId : undefined;
  if (callId === undefined || callId.length === 0) throw new Error("work: this call carries no call id, so the job cannot be forwarded once-only. It was NOT forwarded.");
  const requestId = workRequestIdFor(callId);
  const turnId = currentTurnId(c);
  const tainted = deps.tainted();
  const taintKinds = tainted ? deps.taintKinds() : [];
  const seatSessionId = currentSessionId(c);
  const identity = platformIdentityAttributesFor(c, authority.binding);
  const ownAccountAsk = ownAccountStampToForward(c);
  const requesterAsks =
    authority.requester.kind === "requester" && !authority.nonMemberWake
      ? (deps.requesterAsks ?? requesterAsksForWake)({ turnId, wakeId, principalId: authority.requester.principalId })
      : [];

  let openingRequest: string | undefined;
  if (input.taskId !== undefined) {
    openingRequest = await readWorkTaskRequest(store, org, input.taskId).catch(() => undefined);
    const opening = openingRequest === undefined ? undefined : await readWorkRequest(store, org, openingRequest).catch(() => undefined);
    const sameWork = opening !== undefined && workTokenForSeat(opening.seatToken) === workToken;
    const verdict = !sameWork
      ? ({ admit: false, reason: "no-provenance" } as const)
      : !continuationAdmitted(opening.origin, authority.origin)
        ? ({ admit: false, reason: "cross-room" } as const)
        : ({ admit: true, openingCallId: opening.requestId } as const);
    auditTaskContinuation({ org, parentSessionId: seatSessionId ?? "", turnId, taskId: input.taskId, verdict });
    if (!verdict.admit) throw new Error(taskContinuationRefusalMessage(verdict.reason));
  }
  const atIso = new Date().toISOString();

  await rememberWorkRequest(store, org, {
    requestId,
    seatToken,
    ...(seatSessionId !== undefined ? { seatSessionId } : {}),
    wakeId,
    origin: authority.origin,
    surfaceKey: authority.surfaceKey,
    binding: authority.binding,
    requester: authority.requester,
    nonMemberWake: authority.nonMemberWake,
    tainted,
    atIso,
    ...(requesterAsks.length > 0 ? { requesterAsks } : {}),
  });
  await noteJobForwarded({ requestId, ctx: c, ...(openingRequest !== undefined ? { openingRequestId: openingRequest } : {}) });
  if (input.taskId !== undefined && quietResultWake(c)) await rememberWorkReportPromised(store, org, requestId, atIso).catch(() => undefined);
  await rememberWorkBrief(store, org, requestId, input.message, atIso);
  await noteGenerationDelegation(org, seatToken, workLedgerId(requestId));
  const recorded = deps.resolveWork ? await readWorkDelivery(store, org, requestId) : undefined;
  const generation: WorkGeneration =
    recorded !== undefined
      ? { token: recorded.token, generation: parseWindowToken(recorded.token)?.generation ?? 1 }
      : deps.resolveWork
        ? await deps.resolveWork({ org, seatToken, surfaceKey: authority.surfaceKey, atIso })
        : { token: workToken, generation: 1 };
  const route: ContinuationRoute =
    recorded === undefined && input.taskId !== undefined && deps.resolveWork
      ? await continuationRoute(
          { org, holdingToken: (openingRequest === undefined ? undefined : (await readWorkDelivery(store, org, openingRequest))?.token) ?? (await generationOfTask(org, input.taskId, store)), currentToken: generation.token },
          store,
        ).catch((): ContinuationRoute => ({ kind: "current" }))
      : { kind: "current" };
  const fresh =
    recorded !== undefined ? recorded.fresh : route.kind === "ended" && input.taskId !== undefined ? { taskId: input.taskId, from: route.from, reason: route.reason } : undefined;
  const deliveryToken = recorded !== undefined ? recorded.token : route.kind === "holding" ? route.token : generation.token;
  const deliveredTaskId = fresh !== undefined ? undefined : input.taskId;
  const seatBrief =
    fresh === undefined
      ? input.message
      : renderFreshFollowUpBrief({
          taskId: fresh.taskId,
          message: input.message,
          ...(await (async () => {
            const earlier = openingRequest === undefined ? undefined : await readWorkBrief(store, org, openingRequest).catch(() => undefined);
            return earlier !== undefined ? { earlierBrief: earlier } : {};
          })()),
        });
  const brief = renderJobBrief(seatBrief, requesterAsks);
  const loss =
    recorded !== undefined
      ? recorded.loss
      : generation.rotated !== undefined
        ? { from: generation.rotated.from, reason: `work-session ${generation.rotated.trigger}`, lost: generation.rotated.lostRequestIds.filter((id) => id !== requestId) }
        : undefined;
  if (recorded === undefined && deps.resolveWork) await rememberWorkDelivery(store, org, requestId, { token: deliveryToken, ...(loss !== undefined ? { loss } : {}), ...(fresh !== undefined ? { fresh } : {}) }, atIso);
  if (loss !== undefined && loss.lost.length > 0 && deps.notifyLost) {
    await deps.notifyLost({ org, requestIds: loss.lost, reason: loss.reason, workToken: loss.from });
  }
  await noteGenerationDelegation(org, deliveryToken, workSessionLedgerId(requestId));
  const forward: Parameters<typeof dispatchWorkRequest>[0] = {
    token: deliveryToken,
    requestId,
    message: renderWorkRequest({ requestId, brief, origin: authority.origin, nowIso: atIso, ...(deliveredTaskId !== undefined ? { taskId: deliveredTaskId } : {}) }),
    origin: authority.origin,
    surfaceKey: authority.surfaceKey,
    binding: authority.binding,
    requester: authority.requester,
    nonMemberWake: authority.nonMemberWake,
    ...(seatSessionId !== undefined ? { seatSessionId } : {}),
    seatWakeId: wakeId,
    tainted,
    invokerPosture: currentInvokerPosture(),
    ...(taintKinds.length > 0 ? { taintKinds } : {}),
    ...(identity !== undefined ? { identity } : {}),
    ...(ownAccountAsk !== undefined ? { ownAccountAsk } : {}),
  };
  await rememberWorkForward(store, org, forward, atIso).catch(() => undefined);
  const forwardKey = outboundKey({ surface: "work", action: "work.forward", stableId: requestId, payload: workToken });
  try {
    await postOnce({
      org,
      key: forwardKey,
      ...(deps.markEventSeen ? { markEventSeen: deps.markEventSeen } : {}),
      ...(deps.forgetEventSeen ? { forgetEventSeen: deps.forgetEventSeen } : {}),
      releaseKeyOnFailure: (err) => err instanceof DispatchNotDeliveredError,
      run: () => deps.dispatch(forward),
    });
  } catch (err) {
    const definite = err instanceof DispatchNotDeliveredError;
    if (definite) {
      await clearGenerationDelegation(org, workLedgerId(requestId));
      await clearGenerationDelegation(org, workSessionLedgerId(requestId));
    } else {
      notePendingDelegation(turnId, workLedgerId(requestId), wakeId);
    }
    await deps
      .audit({
        org,
        platform: "unified",
        workspace: parseWindowToken(seatToken)?.domain ?? "unknown",
        action: WORK_FORWARD_FAILED_ACTION,
        detail: { requestId, wakeId, workToken: deliveryToken, outcome: definite ? "not-delivered" : "unknown", ...auditErrorDetail(err) },
      })
      .catch(() => undefined);
    throw new Error(definite ? FORWARD_FAILED_NOTE : FORWARD_UNKNOWN_NOTE);
  }
  if (input.taskId !== undefined) {
    await noteJobForwarded({ requestId, ctx: c, ...(openingRequest !== undefined ? { openingRequestId: openingRequest } : {}), taskId: input.taskId });
  }
  notePendingDelegation(turnId, workLedgerId(requestId), wakeId);

  await deps.audit({
    org,
    platform: "unified",
    workspace: parseWindowToken(seatToken)?.domain ?? "unknown",
    action: WORK_FORWARDED_ACTION,
    detail: {
      requestId,
      wakeId,
      workToken: deliveryToken,
      workGeneration: parseWindowToken(deliveryToken)?.generation ?? generation.generation,
      ...(generation.runtime !== undefined && route.kind !== "holding" ? { workRuntime: generation.runtime } : {}),
      ...(recorded === undefined && input.taskId !== undefined ? { continuation: fresh !== undefined ? `fresh-${fresh.reason}` : route.kind } : {}),
      briefLen: input.message.length, askCount: requesterAsks.length, tainted, ...(seatSessionId !== undefined ? { seatSessionId } : {}) },
  }).catch(() => undefined);

  return {
    requestId,
    note: fresh !== undefined ? freshFollowUpNote(fresh.taskId) : FORWARDED_NOTE,
  };
}

export const FORWARDED_NOTE =
  "Forwarded to this conversation's work session. Your turn does not wait on it, and the result arrives to you " +
  "as a new message; relay it then. When the message addressed you, post one short line that says what will happen " +
  "(reply with done:false); otherwise say it only if the people who asked should hear something now. " +
  `${flatRule(NO_HANDOFF_NARRATION_RULE)}`;

export const FORWARD_FAILED_NOTE =
  "work: the job was NOT started: it was refused before it was handed over, so nothing is running for it. The cause is not known, to you or to the host, so do not name one: " +
  "no service, no error and no outage. You may call `work` once more with the same message. If you do not, or if that call also fails, " +
  "tell the people who asked, in one plain line, that you could not start it, and ask them to try again. Do not mention jobs, tasks or sessions.";

export const FORWARD_UNKNOWN_NOTE =
  "work: it is not known whether the job started: the hand-off broke before it was confirmed. Do not call `work` again for it, because it can be " +
  "running. The cause is not known, to you or to the host, so do not name one: no service, no error and no outage. If its result arrives as a " +
  "new message, relay it. Tell the people who asked, in one plain line, that you are not sure it started and that you will pass on its result " +
  "if one comes (reply with done:false). Do not mention jobs, tasks or sessions.";

function flatRule(rule: string): string {
  return rule.replace(/\s+/g, " ");
}

export function freshFollowUpNote(taskId: string): string {
  return (
    `The job you asked to continue (task ${taskId}) ran in an earlier work session that can no longer continue it, ` +
    "so this follow-up was forwarded as a NEW job, with the earlier job's brief attached. The new job does not have the earlier job's work. " +
    "Tell the people who asked, in one plain line, that this part starts again from the beginning (reply with done:false), then carry on. Do not mention jobs, tasks or sessions. " +
    "The result arrives to you as a new message."
  );
}

function workDeliveryKey(requestId: string): string {
  return `oe-work-delivered:${requestId}`;
}

interface WorkDelivery {
  readonly token: string;
  readonly loss?: { readonly from: string; readonly reason: string; readonly lost: readonly string[] };
  readonly fresh?: { readonly taskId: string; readonly from: string; readonly reason: string };
}

async function readWorkDelivery(store: WorkRowStore, org: string, requestId: string): Promise<WorkDelivery | undefined> {
  try {
    const raw = await store.getTaskResult(org, workDeliveryKey(requestId));
    if (raw === null) return undefined;
    const row = JSON.parse(raw) as { token?: unknown; loss?: { from?: unknown; reason?: unknown; lost?: unknown }; fresh?: { taskId?: unknown; from?: unknown; reason?: unknown } } | null;
    const token = row?.token;
    if (typeof token !== "string" || !isWorkWindowToken(token)) return undefined;
    const l = row?.loss;
    const loss =
      l !== undefined && typeof l.from === "string" && typeof l.reason === "string" && Array.isArray(l.lost)
        ? { from: l.from, reason: l.reason, lost: l.lost.filter((id): id is string => typeof id === "string" && id.length > 0) }
        : undefined;
    const f = row?.fresh;
    const fresh =
      f !== undefined && typeof f.taskId === "string" && typeof f.from === "string" && typeof f.reason === "string" ? { taskId: f.taskId, from: f.from, reason: f.reason } : undefined;
    return { token, ...(loss !== undefined ? { loss } : {}), ...(fresh !== undefined ? { fresh } : {}) };
  } catch {
    return undefined;
  }
}

async function rememberWorkDelivery(store: WorkRowStore, org: string, requestId: string, delivery: WorkDelivery, atIso: string): Promise<void> {
  await store.putTaskResult(org, workDeliveryKey(requestId), JSON.stringify(delivery), atIso, WORK_DELIVERY_TTL_MS).catch(() => undefined);
}

const WORK_DELIVERY_TTL_MS = 6 * 60 * 60 * 1000;

export default windowGated("work", defineTool({
  description:
    "Hand a job to this conversation's work session and keep talking. Use it for anything that needs " +
    "real work: reading or changing code, calling a connector, research, a long task. It returns at once " +
    "with a request id; your turn does not wait. When the job finishes, its result arrives to you as a new " +
    "message, and you relay it to the people who asked. Give a self-contained brief: the work session " +
    "sees this message and the asker's own words, and nothing else of this conversation.",
  inputSchema: z.object({
    message: z
      .string()
      .min(1)
      .describe(
        "The job, with everything needed to do it: the goal, what to return, and whether it may change files. " +
          "Add what you know that the job needs. Add no condition, required detail or precaution that the person did not state: each tool states its own limits.",
      ),
    taskId: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,80}$/)
      .optional()
      .describe("To follow up on a job this conversation already ran, the task id its result named. Omit it to start a new job."),
  }),
  outputSchema: z.object({ requestId: z.string(), note: z.string() }),
  async execute(input, ctx) {
    return await forwardWork(input, ctx);
  },
}), canForwardWork);
