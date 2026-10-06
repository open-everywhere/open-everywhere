import { getOperationalStore } from "../operational/provider.js";
import type { OperationalStore } from "../operational/store.js";
import { appendAudit } from "../audit/audit.js";
import { outboundKey, postOnce } from "../operational/post-once.js";
import { mintWakeId } from "./unified-window.js";
import { dispatchWorkResult } from "./unified.js";
import { readWorkRequest, renderWorkResultWake, workLedgerId, WORK_RESULT_DEDUPE_TTL_MS } from "./work.js";
import { clearGenerationDelegation } from "./generation-retirement.js";
import { currentSeatToken, workSessionLedgerId, WORK_REQUEST_LOST_ACTION } from "./work-generation.js";
import { foldWorkFire } from "../routines/fire-work-fold.js";

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
          },
        });
        if (lost) {
          await clearGenerationDelegation(input.org, workSessionLedgerId(requestId), store);
          if (row.fire.owesRoom) await clearGenerationDelegation(input.org, workLedgerId(requestId), store);
        }
        await audit({ org: input.org, platform: "unified", workspace: "delegation", action: WORK_REQUEST_LOST_ACTION, detail: { requestId, reason: input.reason, workToken: input.workToken, outcome: lost ? "fire-lost" : "replay-skipped", fire: true } }).catch(() => undefined);
        continue;
      }
      const seatToken = await currentSeatToken(input.org, row.seatToken, store);
      const wakeId = mintWakeId();
      let delivered = false;
      let ran = false;
      await postOnce({
        org: input.org,
        key: outboundKey({ surface: "work", action: "request.lost", stableId: requestId, payload: requestId }),
        ttlMs: WORK_RESULT_DEDUPE_TTL_MS,
        markEventSeen: (org, key, at, ttl) => store.markEventSeen(org, key, at, ttl),
        run: async () => {
          ran = true;
          delivered = await dispatch({
            seatToken,
            wakeId,
            message: renderWorkResultWake({
              wakeId,
              origin: row.origin,
              requestId,
              taskId: `lost-${requestId.slice(0, 8)}`,
              status: "failed",
              text: lostJobText(input.reason),
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
        sent += 1;
        await clearGenerationDelegation(input.org, workLedgerId(requestId), store);
        await clearGenerationDelegation(input.org, workSessionLedgerId(requestId), store);
      }
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
