import { defineTool } from "eve/tools";
import { z } from "zod";
import { windowGated } from "../access/window-gated.js";
import { oneshotAgentEnabled } from "../access/delegation-flag.js";
import { forwardsToWorkSession } from "../access/work-session.js";
import { resolveOwnWindowToken } from "../access/delegation-mount.js";
import { currentTurnId, currentWakeId, deploymentOrg, type BindableContext } from "../identity/binding.js";
import { noteDelegationRequested } from "../access/pending-delegation-signal.js";
import { resolveUnifiedWakeAuthority } from "../channels/unified-window.js";
import { dispatchWorkRequest } from "../channels/unified.js";
import { readWorkRequest, readWorkTaskRequest, workRequestIdFor, workTokenForSeat, type WorkRowStore } from "../channels/work.js";
import { auditWorkCancel, mayCancelWork, principalAdministers, relayWorkCancel, type WorkAdminCheck, type WorkCancelRelayDeps } from "../channels/work-cancel.js";
import { readWorkJobStatus, renderWorkJobStatus } from "../hooks/work-status.js";
import { getOperationalStore } from "../operational/provider.js";
import { type ForgetEventSeen, type MarkEventSeen } from "../operational/post-once.js";
import { appendAudit } from "../audit/audit.js";
import { canForwardWork } from "./work.js";

export { principalAdministers };

export const CANCEL_WORK_NOT_YOURS_MESSAGE =
  "cancel_work: only the person who asked for this job, or an admin, can cancel it. Nothing was cancelled.";

export interface CancelWorkDeps {
  readonly forwards: (ctx: BindableContext) => boolean;
  readonly org: () => string;
  readonly store: () => WorkRowStore & Parameters<typeof resolveUnifiedWakeAuthority>[0] & WorkCancelRelayDeps["store"];
  readonly dispatch: typeof dispatchWorkRequest;
  readonly markEventSeen?: MarkEventSeen;
  readonly forgetEventSeen?: ForgetEventSeen;
  readonly isAdmin: WorkAdminCheck;
  readonly audit: (row: Parameters<typeof appendAudit>[0]) => Promise<unknown>;
}

const LIVE_DEPS: CancelWorkDeps = {
  forwards: forwardsToWorkSession,
  org: deploymentOrg,
  store: getOperationalStore,
  dispatch: dispatchWorkRequest,
  isAdmin: principalAdministers,
  audit: appendAudit,
};

export interface CancelReceipt {
  readonly taskId: string;
  readonly cancelId: string;
  readonly note: string;
}

export type CancelWorkInput = { readonly taskId: string; readonly requestId?: undefined } | { readonly requestId: string; readonly taskId?: undefined };

export async function cancelWork(input: CancelWorkInput, ctx: unknown, deps: CancelWorkDeps = LIVE_DEPS): Promise<CancelReceipt> {
  const c = ctx as BindableContext;
  if (!oneshotAgentEnabled()) throw new Error("cancel_work: delegation (delegation.oneshotAgent) is disarmed on this deployment.");
  if (!deps.forwards(c)) throw new Error("cancel_work: this seat runs no work session, so it has no forwarded job to cancel.");
  const byTask = typeof input.taskId === "string" && input.taskId.length > 0;
  const byRequest = typeof input.requestId === "string" && input.requestId.length > 0;
  if (byTask === byRequest) throw new Error("cancel_work: name exactly one of `taskId` or `requestId`. Nothing was cancelled.");
  const seatToken = resolveOwnWindowToken(c);
  const workToken = seatToken === undefined ? undefined : workTokenForSeat(seatToken);
  if (seatToken === undefined || workToken === undefined) throw new Error("cancel_work: this seat's work session could not be named, so nothing was cancelled.");
  const org = deps.org();
  const store = deps.store();
  const wakeId = currentWakeId(c);
  const authority = wakeId ? await resolveUnifiedWakeAuthority(store, org, wakeId).catch(() => null) : null;
  if (!wakeId || !authority) throw new Error("cancel_work: couldn't resolve who is asking on this turn, so nothing was cancelled.");

  const named = byTask ? `task id ${input.taskId}` : `request id ${input.requestId}`;
  const requestId = byTask ? await readWorkTaskRequest(store, org, input.taskId!).catch(() => undefined) : input.requestId;
  const row = requestId === undefined ? undefined : await readWorkRequest(store, org, requestId).catch(() => undefined);
  if (row === undefined || workTokenForSeat(row.seatToken) !== workToken) {
    throw new Error(`cancel_work: this conversation forwarded no job with ${named}, so nothing was cancelled.`);
  }
  const status = await readWorkJobStatus(store, org, row.requestId);
  const taskId = byTask ? input.taskId! : status?.taskId;
  if (taskId === undefined) throw new Error(`cancel_work: ${renderWorkJobStatus(undefined, row.requestId)} Nothing was cancelled; try again in a moment.`);
  const callId = typeof (ctx as { callId?: unknown }).callId === "string" ? (ctx as { callId: string }).callId : undefined;
  if (callId === undefined || callId.length === 0) throw new Error("cancel_work: this call carries no call id, so its cancel cannot be made once-only. Nothing was cancelled.");
  const cancelId = workRequestIdFor(`cancel:${callId}`);
  if (!mayCancelWork({ requester: authority.requester, binding: authority.binding }, row, deps.isAdmin)) {
    await auditWorkCancel(deps, org, row, taskId, cancelId, workToken, { outcome: "refused", reason: "not-requester-or-admin", via: "cancel_work" });
    throw new Error(CANCEL_WORK_NOT_YOURS_MESSAGE);
  }
  const settled = status !== undefined && status.taskId === taskId && status.state !== "working" ? status : undefined;
  await relayWorkCancel(
    {
      org,
      row,
      taskId,
      cancelId,
      delivery: { origin: authority.origin, surfaceKey: authority.surfaceKey, binding: authority.binding, requester: authority.requester, nonMemberWake: authority.nonMemberWake, seatWakeId: wakeId },
      via: "cancel_work",
      atIso: new Date().toISOString(),
    },
    { store, dispatch: deps.dispatch, audit: deps.audit, ...(deps.markEventSeen ? { markEventSeen: deps.markEventSeen } : {}), ...(deps.forgetEventSeen ? { forgetEventSeen: deps.forgetEventSeen } : {}) },
  );
  // A relayed stop of a job that is still working owes a later result: the stopped job's result wake
  // arrives as a turn of its own. Noted like a worker request, so a `done: false` ack ends this turn
  // (`continuesTurn` in tools/reply.ts). A refused cancel throws above and a job that already settled
  // owes no wake, so neither is noted, and the turn goes on to read that outcome.
  if (settled === undefined) noteDelegationRequested(currentTurnId(c));
  return {
    taskId,
    cancelId,
    note:
      settled !== undefined
        ? `Cancel sent for task ${taskId}, but ${renderWorkJobStatus(settled, row.requestId)} There is nothing left to stop.`
        : `Cancel sent for task ${taskId}. The work session stops it; if it had already finished, there is nothing left to stop.`,
  };
}

export default windowGated("cancel_work", defineTool({
  description:
    "Stop a job you forwarded with `work`: name its request id (from the `work` receipt) or its task id (from " +
    "a result or notice), exactly one of the two. Only the person who " +
    "asked for the job, or an admin, can cancel it. It returns at once; the work session stops the job.",
  inputSchema: z.object({
    taskId: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/).optional().describe("The task id of the job to stop, as its result or a notice named it."),
    requestId: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/).optional().describe("The request id your `work` receipt named, when you have no task id yet."),
  }),
  outputSchema: z.object({ taskId: z.string(), cancelId: z.string(), note: z.string() }),
  async execute(input, ctx) {
    return await cancelWork(input as CancelWorkInput, ctx);
  },
}), canForwardWork);
