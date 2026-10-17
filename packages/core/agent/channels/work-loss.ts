import { failLostInboundTask } from "../a2a/inbound/answer.js";
import { getOperationalStore } from "../operational/provider.js";
import type { OperationalStore } from "../operational/store.js";
import { appendAudit } from "../audit/audit.js";
import { outboundKey, postOnce } from "../operational/post-once.js";
import { mintWakeId } from "./unified-window.js";
import { dispatchWorkResult } from "./unified.js";
import { readWorkRequest, renderWorkResultWake, workLedgerId, WORK_RESULT_DEDUPE_TTL_MS, type WorkRequestRow } from "./work.js";
import { clearGenerationDelegation } from "./generation-retirement.js";
import { currentSeatToken, workSessionLedgerId, WORK_REQUEST_LOST_ACTION } from "./work-generation.js";
import { foldWorkFire } from "../routines/fire-work-fold.js";
import { deploymentOrg } from "../identity/binding.js";
import type { TaskContinuationRefusal } from "./task-provenance.js";
import { registerContinuationRefusalNotifier } from "../access/work-refusal-notice.js";
import type { AuditDetail } from "../audit/scrubbed-text.js";

export const WORK_REQUEST_REFUSED_ACTION = "work.request_refused";

function lostJobText(reason: string): string {
  return (
    `The work session that ran this job was reset (${reason}) before the job finished. Its workspace and any task ` +
    "still running in it are gone, so this job produced no result. If the job is still needed, forward it again with " +
    "`work` as a new job. If a result for it still arrives later, it comes from the old work session."
  );
}

export interface LostWorkDeps {
  readonly store?: Pick<OperationalStore, "getTaskResult" | "putTaskResult" | "deleteTaskResult" | "getChannelSession" | "markEventSeen">;
  readonly dispatch?: typeof dispatchWorkResult;
  readonly audit?: typeof appendAudit;
  readonly foldFire?: typeof foldWorkFire;
}

export async function notifyLostWorkRequests(
  input: { readonly org: string; readonly requestIds: readonly string[]; readonly reason: string; readonly workToken: string },
  deps: LostWorkDeps = {},
): Promise<number> {
  const store = deps.store ?? getOperationalStore();
  const dispatch = deps.dispatch ?? dispatchWorkResult;
  const audit = deps.audit ?? appendAudit;
  let sent = 0;
  for (const requestId of input.requestIds) {
    try {
      const row = await readWorkRequest(store, input.org, requestId);
      if (row === undefined) {
        await audit({ org: input.org, platform: "unified", workspace: "delegation", action: WORK_REQUEST_LOST_ACTION, detail: { requestId, reason: input.reason, outcome: "skipped", why: "request-row-missing", workToken: input.workToken } }).catch(() => undefined);
        continue;
      }
      if (row.fire !== undefined) {
        let lost = false;
        await postOnce({
          org: input.org,
          key: outboundKey({ surface: "work", action: "request.lost", stableId: requestId, payload: requestId }),
          ttlMs: WORK_RESULT_DEDUPE_TTL_MS,
          markEventSeen: (org, key, at, ttl) => store.markEventSeen(org, key, at, ttl),
          run: async () => {
            lost = true;
            await (deps.foldFire ?? foldWorkFire)(row, "failed", { org: input.org });
            await failLostInboundTask({ org: input.org, store, requestId, fire: row.fire!, audit: audit as typeof appendAudit });
          },
        });
        if (lost) {
          await clearGenerationDelegation(input.org, workSessionLedgerId(requestId), store);
          if (row.fire.owesRoom) await clearGenerationDelegation(input.org, workLedgerId(requestId), store);
        }
        await audit({ org: input.org, platform: "unified", workspace: "delegation", action: WORK_REQUEST_LOST_ACTION, detail: { requestId, reason: input.reason, workToken: input.workToken, outcome: lost ? "fire-lost" : "replay-skipped", fire: true } }).catch(() => undefined);
        continue;
      }
      const { ran, delivered, wakeId } = await wakeSeatWithFailedJob({
        org: input.org,
        row,
        requestId,
        dedupeAction: "request.lost",
        taskId: `lost-${requestId.slice(0, 8)}`,
        text: lostJobText(input.reason),
        store,
        dispatch,
      });
      if (ran && delivered) sent += 1;
      await audit({
        org: input.org,
        platform: "unified",
        workspace: "delegation",
        action: WORK_REQUEST_LOST_ACTION,
        detail: { requestId, reason: input.reason, workToken: input.workToken, outcome: !ran ? "replay-skipped" : delivered ? "notified" : "failed", ...(ran ? { wakeId } : {}) },
      }).catch(() => undefined);
    } catch (err) {
      console.warn(`[open-everywhere:work] lost-job notice for request ${requestId} failed: ${String(err)}`);
    }
  }
  return sent;
}

type FailedJobStore = NonNullable<LostWorkDeps["store"]>;

async function wakeSeatWithFailedJob(input: {
  readonly org: string;
  readonly row: WorkRequestRow;
  readonly requestId: string;
  readonly dedupeAction: string;
  readonly taskId: string;
  readonly text: string;
  readonly store: FailedJobStore;
  readonly dispatch: typeof dispatchWorkResult;
}): Promise<{ readonly ran: boolean; readonly delivered: boolean; readonly wakeId: string }> {
  const { org, row, requestId, store } = input;
  const seatToken = await currentSeatToken(org, row.seatToken, store);
  const wakeId = mintWakeId();
  let delivered = false;
  let ran = false;
  await postOnce({
    org,
    key: outboundKey({ surface: "work", action: input.dedupeAction, stableId: requestId, payload: requestId }),
    ttlMs: WORK_RESULT_DEDUPE_TTL_MS,
    markEventSeen: (o, key, at, ttl) => store.markEventSeen(o, key, at, ttl),
    run: async () => {
      ran = true;
      delivered = await input.dispatch({
        seatToken,
        wakeId,
        message: renderWorkResultWake({
          wakeId,
          origin: row.origin,
          requestId,
          taskId: input.taskId,
          status: "failed",
          text: input.text,
          nowIso: new Date().toISOString(),
          dispatchWakeId: row.wakeId,
        }),
        origin: row.origin,
        surfaceKey: row.surfaceKey,
        binding: row.binding,
        requester: row.requester,
        nonMemberWake: row.nonMemberWake,
        requestId,
        tainted: row.tainted,
      });
    },
  });
  if (ran && delivered) {
    await clearGenerationDelegation(org, workLedgerId(requestId), store);
    await clearGenerationDelegation(org, workSessionLedgerId(requestId), store);
  }
  return { ran, delivered, wakeId };
}

export function refusedFollowUpText(taskId: string, reason: TaskContinuationRefusal): string {
  if (reason === "task-working") {
    return (
      `The work session did not run this follow-up: task ${taskId} was still working on an earlier message, so it could not take a new one. ` +
      `Nothing in this follow-up was done. When the earlier result arrives, forward the follow-up again with \`work\` and the same taskId if it is still needed.`
    );
  }
  if (reason === "cross-room") {
    return (
      `The work session did not run this follow-up: task ${taskId} was opened in a different conversation, so it cannot be continued from this one. ` +
      "Nothing in this follow-up was done. If it is still needed, forward it again with `work` as a new job (no taskId), with everything it needs in the brief."
    );
  }
  return (
    `The work session did not run this follow-up: task ${taskId} cannot be continued there (${reason}). Nothing in this follow-up was done. ` +
    "If it is still needed, forward it again with `work` as a new job (no taskId), with everything it needs in the brief."
  );
}

export async function notifyRefusedWorkRequest(
  input: { readonly org: string; readonly requestId: string; readonly taskId: string; readonly reason: TaskContinuationRefusal },
  deps: LostWorkDeps = {},
): Promise<boolean> {
  const { org, requestId } = input;
  const audit = deps.audit ?? appendAudit;
  const record = (detail: AuditDetail) =>
    audit({ org, platform: "unified", workspace: "delegation", action: WORK_REQUEST_REFUSED_ACTION, detail: { requestId, taskId: input.taskId, reason: input.reason, ...detail } }).catch(() => undefined);
  try {
    const store = deps.store ?? getOperationalStore();
    const row = await readWorkRequest(store, org, requestId);
    if (row === undefined) {
      await record({ outcome: "skipped", why: "request-row-missing" });
      return false;
    }
    if (row.fire !== undefined) {
      let folded = false;
      await postOnce({
        org,
        key: outboundKey({ surface: "work", action: "request.refused", stableId: requestId, payload: requestId }),
        ttlMs: WORK_RESULT_DEDUPE_TTL_MS,
        markEventSeen: (o, key, at, ttl) => store.markEventSeen(o, key, at, ttl),
        run: async () => {
          folded = true;
          await (deps.foldFire ?? foldWorkFire)(row, "failed", { org });
          await failLostInboundTask({ org, store, requestId, fire: row.fire!, audit: audit as typeof appendAudit });
        },
      });
      if (folded) {
        await clearGenerationDelegation(org, workSessionLedgerId(requestId), store);
        if (row.fire.owesRoom) await clearGenerationDelegation(org, workLedgerId(requestId), store);
      }
      await record({ outcome: folded ? "fire-failed" : "replay-skipped", fire: true });
      return false;
    }
    const { ran, delivered, wakeId } = await wakeSeatWithFailedJob({
      org,
      row,
      requestId,
      dedupeAction: "request.refused",
      taskId: input.taskId,
      text: refusedFollowUpText(input.taskId, input.reason),
      store,
      dispatch: deps.dispatch ?? dispatchWorkResult,
    });
    await record(!ran ? { outcome: "replay-skipped" } : { outcome: delivered ? "notified" : "failed", wakeId });
    return ran && delivered;
  } catch (err) {
    console.warn(`[open-everywhere:work] refused-follow-up notice for request ${requestId} failed: ${String(err)}`);
    await record({ outcome: "failed", why: "error" });
    return false;
  }
}

registerContinuationRefusalNotifier((input) => notifyRefusedWorkRequest({ org: deploymentOrg(), ...input }));
