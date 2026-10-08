import { getConfig } from "../access/config.js";
import { criteriaDomain } from "../memory/domain.js";
import { rosterHasPrincipal, tryPrincipalKey } from "../identity/principal-key.js";
import type { RequesterVerdict } from "../access/requester-identity.js";
import type { SurfaceBinding } from "../identity/binding.js";
import { dispatchWorkRequest } from "./unified.js";
import { workTokenHoldingTask } from "./work-generation.js";
import { readWorkRequest, rememberWorkCancel, renderWorkCancel, workRequestIdFor, workTokenForSeat, WORK_CANCEL_ACTION, type WorkRequestRow, type WorkRowStore } from "./work.js";
import { parseWindowToken } from "./window-key.js";
import type { UnifiedWakeOrigin } from "./unified-window.js";
import { outboundKey, postOnce, type ForgetEventSeen, type MarkEventSeen } from "../operational/post-once.js";
import { appendAudit } from "../audit/audit.js";
import { getOperationalStore } from "../operational/provider.js";
import { readAnchoredWorkJobs, readWorkJobStatus } from "../hooks/work-status.js";

export interface WorkCancelActor {
  readonly requester: RequesterVerdict;
  readonly binding: Pick<SurfaceBinding, "platform" | "workspace" | "enterprise">;
}

export function principalAdministers(actor: { readonly principalId: string; readonly binding: Pick<SurfaceBinding, "platform" | "workspace" | "enterprise"> }, domain: string | undefined): boolean {
  if (tryPrincipalKey(actor.binding.platform, actor.binding.workspace, actor.principalId) === undefined) return false;
  const admits = (roster: readonly string[] | undefined): boolean =>
    rosterHasPrincipal(roster, actor.binding.platform, actor.binding.workspace, actor.principalId, actor.binding.enterprise);
  const domains = getConfig().loadDomains();
  if (admits(criteriaDomain("org", domains)?.admins)) return true;
  if (domain === undefined) return false;
  return admits(domains.find((d) => d.name === domain)?.admins);
}

export function sameWorkRequester(actor: WorkCancelActor, row: Pick<WorkRequestRow, "requester" | "binding">): boolean {
  return (
    actor.requester.kind === "requester" &&
    row.requester.kind === "requester" &&
    actor.requester.principalId === row.requester.principalId &&
    actor.binding.platform === row.binding.platform &&
    actor.binding.workspace === row.binding.workspace
  );
}

export type WorkAdminCheck = (actor: { readonly principalId: string; readonly binding: Pick<SurfaceBinding, "platform" | "workspace" | "enterprise"> }, domain: string | undefined) => boolean;

export function mayCancelWork(actor: WorkCancelActor, row: Pick<WorkRequestRow, "requester" | "binding" | "seatToken">, isAdmin: WorkAdminCheck): boolean {
  if (sameWorkRequester(actor, row)) return true;
  if (actor.requester.kind !== "requester") return false;
  return isAdmin({ principalId: actor.requester.principalId, binding: actor.binding }, parseWindowToken(row.seatToken)?.domain);
}

export interface WorkCancelRelayDeps {
  readonly store: WorkRowStore & Parameters<typeof workTokenHoldingTask>[3];
  readonly dispatch: typeof dispatchWorkRequest;
  readonly markEventSeen?: MarkEventSeen;
  readonly forgetEventSeen?: ForgetEventSeen;
  readonly audit: (row: Parameters<typeof appendAudit>[0]) => Promise<unknown>;
}

export interface WorkCancelDelivery {
  readonly origin: UnifiedWakeOrigin;
  readonly surfaceKey: string;
  readonly binding: SurfaceBinding;
  readonly requester: RequesterVerdict;
  readonly nonMemberWake: boolean;
  readonly seatWakeId: string;
}

export async function relayWorkCancel(
  input: { readonly org: string; readonly row: WorkRequestRow; readonly taskId: string; readonly cancelId: string; readonly delivery: WorkCancelDelivery; readonly via: "cancel_work" | "reaction"; readonly atIso: string },
  deps: WorkCancelRelayDeps,
): Promise<boolean> {
  const workToken = workTokenForSeat(input.row.seatToken);
  if (workToken === undefined) throw new Error("work cancel: the job's work session could not be named, so nothing was cancelled.");
  const holdingToken = (await workTokenHoldingTask(input.org, input.row.seatToken, input.taskId, deps.store).catch(() => undefined)) ?? workToken;
  await rememberWorkCancel(deps.store, input.org, holdingToken, input.taskId, input.cancelId, input.atIso);
  let delivered = false;
  await postOnce({
    org: input.org,
    key: outboundKey({ surface: "work", action: "work.cancel", stableId: input.cancelId, payload: workToken }),
    ...(deps.markEventSeen ? { markEventSeen: deps.markEventSeen } : {}),
    ...(deps.forgetEventSeen ? { forgetEventSeen: deps.forgetEventSeen } : {}),
    releaseKeyOnFailure: () => true,
    run: async () => {
      await deps.dispatch({
        token: holdingToken,
        requestId: input.cancelId,
        message: renderWorkCancel({ cancelId: input.cancelId, taskId: input.taskId, origin: input.delivery.origin, nowIso: input.atIso }),
        origin: input.delivery.origin,
        surfaceKey: input.delivery.surfaceKey,
        binding: input.delivery.binding,
        requester: input.delivery.requester,
        nonMemberWake: input.delivery.nonMemberWake,
        seatWakeId: input.delivery.seatWakeId,
        cancel: true,
        tainted: false,
      });
      delivered = true;
    },
  });
  await auditWorkCancel(deps, input.org, input.row, input.taskId, input.cancelId, workToken, { outcome: delivered ? "relayed" : "repeat", via: input.via });
  return delivered;
}

export function auditWorkCancel(
  deps: Pick<WorkCancelRelayDeps, "audit">,
  org: string,
  row: WorkRequestRow,
  taskId: string,
  cancelId: string,
  workToken: string | undefined,
  detail: Record<string, unknown>,
): Promise<unknown> {
  const domain = parseWindowToken(row.seatToken)?.domain;
  return deps
    .audit({ org, platform: "unified", workspace: domain ?? "unknown", action: WORK_CANCEL_ACTION, detail: { taskId, request: row.requestId, cancelId, ...(workToken !== undefined ? { workToken } : {}), ...detail } })
    .catch(() => undefined);
}

export interface AnchoredJobStop {
  readonly listed: number;
  readonly relayed: number;
  readonly refused: number;
  readonly repeated: number;
}

export interface AnchoredJobStopDeps extends WorkCancelRelayDeps {
  readonly isAdmin: WorkAdminCheck;
  readonly now: () => Date;
}

export async function stopAnchoredWorkJobs(
  input: { readonly org: string; readonly anchorKey: string; readonly actor: WorkCancelActor; readonly clickId: string },
  deps: AnchoredJobStopDeps,
): Promise<AnchoredJobStop> {
  let listed = 0;
  let relayed = 0;
  let refused = 0;
  let repeated = 0;
  try {
    const jobs = await readAnchoredWorkJobs(deps.store, input.org, input.anchorKey);
    for (const job of jobs) {
      const row = await readWorkRequest(deps.store, input.org, job.requestId).catch(() => undefined);
      if (row === undefined) continue;
      const status = await readWorkJobStatus(deps.store, input.org, job.requestId);
      if (status !== undefined && status.state !== "working") continue;
      listed += 1;
      const cancelId = workRequestIdFor(`cancel-hand:${input.clickId}:${job.requestId}`);
      if (!mayCancelWork(input.actor, row, deps.isAdmin)) {
        refused += 1;
        await auditWorkCancel(deps, input.org, row, job.taskId, cancelId, workTokenForSeat(row.seatToken), { outcome: "refused", reason: "not-requester-or-admin", via: "reaction" });
        continue;
      }
      try {
        const fresh = await relayWorkCancel(
          {
            org: input.org,
            row,
            taskId: job.taskId,
            cancelId,
            delivery: { origin: row.origin, surfaceKey: row.surfaceKey, binding: row.binding, requester: input.actor.requester, nonMemberWake: row.nonMemberWake, seatWakeId: row.wakeId },
            via: "reaction",
            atIso: deps.now().toISOString(),
          },
          deps,
        );
        if (fresh) relayed += 1;
        else repeated += 1;
      } catch (err) {
        await auditWorkCancel(deps, input.org, row, job.taskId, cancelId, workTokenForSeat(row.seatToken), { outcome: "error", via: "reaction", note: String(err).slice(0, 200) });
      }
    }
  } catch (err) {
    console.warn(`[open-everywhere:work] ✋ stop on ${input.anchorKey} failed: ${String(err)}`);
  }
  return { listed, relayed, refused, repeated };
}

export async function stopAnchoredWorkJobsLive(input: { readonly org: string; readonly anchorKey: string; readonly actor: WorkCancelActor; readonly clickId: string }): Promise<AnchoredJobStop> {
  return await stopAnchoredWorkJobs(input, { store: getOperationalStore(), dispatch: dispatchWorkRequest, audit: appendAudit, isAdmin: principalAdministers, now: () => new Date() });
}
