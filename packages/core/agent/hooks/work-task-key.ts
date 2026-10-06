import { deploymentOrg } from "../identity/binding.js";
import { readWorkRequest, workLedgerId, WORK_RESULT_DEDUPE_TTL_MS, type WorkRequestRow, type WorkRowStore } from "../channels/work.js";
import { renderWake } from "../channels/normalized-wake.js";
import { postArm } from "../channels/post-arms.js";
import { settlementWakeLine } from "../instructions/seat-prompt.js";
import { outboundKey, postOnce, type MarkEventSeen } from "../operational/post-once.js";
import { getOperationalStore } from "../operational/provider.js";
import { appendAudit } from "../audit/audit.js";
import { clearGenerationDelegation } from "../channels/generation-retirement.js";
import { currentSeatToken, workSessionLedgerId } from "../channels/work-generation.js";
import { dispatchWorkRequest, dispatchWorkResult } from "../channels/unified.js";
import { mintWakeId } from "../channels/unified-window.js";
import { foldWorkFire } from "../routines/fire-work-fold.js";
import { registerWorkReissuer, type WorkStampFailure, type WorkStampVerdict, workStampVerdict } from "../access/work-step-stamp.js";

export { gateWorkCallStamp, liveStepDeliveryId, liveWorkRequestStamp, registerWorkReissuer, workStampVerdict, WORK_CALL_NEEDS_REISSUE_MESSAGE, type WorkStampFailure, type WorkStampVerdict } from "../access/work-step-stamp.js";

export const WORK_TASK_KEYED_ACTION = "work.task_keyed";
export const WORK_NEEDS_REISSUE_ACTION = "work.needs_reissue";

const WORK_TASK_KEY_PREFIX = "oe-work-task-key:";
const WORK_TASK_KEY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface WorkTaskKey {
  readonly requestId: string;
  readonly verdict: "keyed" | "needs-reissue";
  readonly reason?: WorkStampFailure;
}

export function workTaskKeyKey(taskId: string): string {
  return `${WORK_TASK_KEY_PREFIX}${taskId}`;
}

export async function rememberWorkTaskKey(store: WorkRowStore, org: string, taskId: string, key: WorkTaskKey, atIso: string): Promise<void> {
  await store.putTaskResult(org, workTaskKeyKey(taskId), JSON.stringify(key), atIso, WORK_TASK_KEY_TTL_MS);
}

export async function readWorkTaskKey(store: WorkRowStore, org: string, taskId: string): Promise<WorkTaskKey | undefined> {
  try {
    const raw = await store.getTaskResult(org, workTaskKeyKey(taskId));
    if (raw === null) return undefined;
    const row = JSON.parse(raw) as Partial<WorkTaskKey> | null;
    if (row === null || typeof row.requestId !== "string" || (row.verdict !== "keyed" && row.verdict !== "needs-reissue")) return undefined;
    return { requestId: row.requestId, verdict: row.verdict, ...(row.reason === "stamp-absent" || row.reason === "stamp-names-another-request" ? { reason: row.reason } : {}) };
  } catch {
    return undefined;
  }
}

function requesterLabel(row: WorkRequestRow | undefined): string | undefined {
  if (row === undefined) return undefined;
  return row.requester.kind === "requester" ? row.requester.principalId : row.requester.kind === "unverified" ? "oe/unverified" : undefined;
}

export interface WorkTaskKeyDeps {
  readonly org: () => string;
  readonly store: () => WorkRowStore;
  readonly audit: (row: Parameters<typeof appendAudit>[0]) => Promise<unknown>;
}

const LIVE_KEY_DEPS: WorkTaskKeyDeps = { org: deploymentOrg, store: getOperationalStore, audit: appendAudit };

export async function keyWorkTask(input: { readonly taskId: string; readonly callId: string; readonly workSessionId: string; readonly joined: string; readonly stamped: string | undefined }, deps: WorkTaskKeyDeps = LIVE_KEY_DEPS): Promise<WorkStampVerdict> {
  const verdict = workStampVerdict(input.joined, input.stamped);
  const org = deps.org();
  const store = deps.store();
  try {
    await rememberWorkTaskKey(store, org, input.taskId, { requestId: input.joined, verdict: verdict.kind, ...(verdict.kind === "needs-reissue" ? { reason: verdict.reason } : {}) }, new Date().toISOString());
  } catch (err) {
    console.warn(`[open-everywhere:work] task ${input.taskId}: the key row could NOT be written — its settlement fails closed: ${String(err).slice(0, 160)}`);
  }
  const row = await readWorkRequest(store, org, input.joined).catch(() => undefined);
  const requester = requesterLabel(row);
  await deps
    .audit({
      org,
      platform: "unified",
      workspace: "delegation",
      action: WORK_TASK_KEYED_ACTION,
      ...(row?.requester.kind === "requester" ? { principalId: row.requester.principalId } : {}),
      detail: {
        taskId: input.taskId,
        callId: input.callId,
        workSession: input.workSessionId,
        requestId: input.joined,
        verdict: verdict.kind,
        tier: "child",
        ...(requester !== undefined ? { requester } : {}),
        ...(verdict.kind === "needs-reissue" ? { reason: verdict.reason, ...(verdict.stamped !== undefined ? { stamped: verdict.stamped } : {}) } : {}),
      },
    })
    .catch(() => undefined);
  if (verdict.kind === "needs-reissue") {
    console.warn(`[open-everywhere:work] task ${input.taskId} started for request ${input.joined} under ANOTHER step's stamp (${verdict.reason}) — its result is withheld and the seat is told to forward it again`);
  }
  return verdict;
}

export function renderNeedsReissueNote(input: { readonly requestId: string; readonly dispatchWakeId: string; readonly taskId?: string; readonly edge?: "validate" | "task.started" }): string {
  const job = `The job you forwarded with \`work\` (request ${input.requestId}${input.taskId !== undefined ? `, task ${input.taskId}` : ""})`;
  const address = `The people who asked are still waiting, and the address of their wake is on the next line:\n${settlementWakeLine(input.dispatchWakeId)}`;
  if (input.edge === "task.started") {
    return (
      `${job} RAN under another job's requester stamp, so OE withheld its result rather than report it as this request's. ` +
      "It may already have acted (posted, written, opened something). Check what it did before you forward it again with `work`; " +
      `do not tell anyone it did nothing. ${address}`
    );
  }
  return (
    `${job} was NOT run: the work session could not start it under the requester who asked for it, so OE refused it before ` +
    "anything started. Forward it AGAIN now: call `work` once more with the same brief. Then carry on. " +
    address
  );
}

export function renderNeedsReissueWake(input: { readonly wakeId: string; readonly row: WorkRequestRow; readonly requestId: string; readonly nowIso: string; readonly taskId?: string; readonly edge?: "validate" | "task.started" }): string {
  const arm = postArm(input.row.origin.platform);
  const containerId = arm?.redriveContainerId ? arm.redriveContainerId(input.row.origin) : input.row.origin.platform;
  return renderWake(
    {
      platform: input.row.origin.platform,
      reason: "dispatch",
      addressing: "direct-mention",
      wakeId: input.wakeId,
      locus: { channel: { id: containerId } },
      trigger: { kind: "notice" },
      systemNote: renderNeedsReissueNote({ requestId: input.requestId, dispatchWakeId: input.row.wakeId, ...(input.taskId !== undefined ? { taskId: input.taskId } : {}), ...(input.edge !== undefined ? { edge: input.edge } : {}) }),
    },
    () => input.nowIso,
  ).message;
}

export interface NeedsReissueDeps extends WorkTaskKeyDeps {
  readonly dispatch: (input: Parameters<typeof dispatchWorkResult>[0]) => Promise<boolean>;
  readonly mintWakeId: () => string;
  readonly markEventSeen?: MarkEventSeen;
  readonly clearLedger: (org: string, ledgerId: string) => Promise<void>;
  readonly liveSeat?: (org: string, recordedSeatToken: string) => Promise<string>;
  readonly foldFire?: typeof foldWorkFire;
}

async function liveNeedsReissueDeps(): Promise<NeedsReissueDeps> {
  return {
    ...LIVE_KEY_DEPS,
    dispatch: dispatchWorkResult,
    mintWakeId,
    clearLedger: (org, ledgerId) => clearGenerationDelegation(org, ledgerId),
    liveSeat: (org, recordedSeatToken) => currentSeatToken(org, recordedSeatToken),
  };
}

export async function wakeSeatNeedsReissue(
  input: { readonly requestId: string; readonly edge: "validate" | "task.started"; readonly reason: WorkStampFailure; readonly stamped?: string; readonly taskId?: string },
  depsIn?: NeedsReissueDeps,
): Promise<boolean> {
  let deps: NeedsReissueDeps;
  try {
    deps = depsIn ?? (await liveNeedsReissueDeps());
  } catch {
    return false;
  }
  const org = deps.org();
  const store = deps.store();
  const audit = (detail: Record<string, unknown>) =>
    deps
      .audit({
        org,
        platform: "unified",
        workspace: "delegation",
        action: WORK_NEEDS_REISSUE_ACTION,
        detail: { requestId: input.requestId, edge: input.edge, reason: input.reason, ...(input.stamped !== undefined ? { stamped: input.stamped } : {}), ...(input.taskId !== undefined ? { taskId: input.taskId } : {}), ...detail },
      })
      .catch(() => undefined);
  const row = await readWorkRequest(store, org, input.requestId).catch(() => undefined);
  if (row === undefined) {
    await audit({ outcome: "skipped", why: "request-row-missing" });
    return false;
  }
  if (row.fire !== undefined) {
    let lost = false;
    await postOnce({
      org,
      key: outboundKey({ surface: "work", action: "work.needs_reissue", stableId: input.requestId, payload: input.requestId }),
      ttlMs: WORK_RESULT_DEDUPE_TTL_MS,
      ...(deps.markEventSeen ? { markEventSeen: deps.markEventSeen } : {}),
      run: async () => {
        lost = true;
        await (deps.foldFire ?? foldWorkFire)(row, "failed", { org });
      },
    });
    if (lost) {
      await deps.clearLedger(org, workSessionLedgerId(input.requestId)).catch(() => undefined);
      if (row.fire.owesRoom) await deps.clearLedger(org, workLedgerId(input.requestId)).catch(() => undefined);
    }
    await audit({ outcome: lost ? "fire-lost" : "replay-skipped", fire: true });
    return false;
  }
  const wakeId = deps.mintWakeId();
  const seatToken = deps.liveSeat ? await deps.liveSeat(org, row.seatToken).catch(() => row.seatToken) : row.seatToken;
  let delivered = false;
  let ran = false;
  await postOnce({
    org,
    key: outboundKey({ surface: "work", action: "work.needs_reissue", stableId: input.requestId, payload: input.requestId }),
    ...(deps.markEventSeen ? { markEventSeen: deps.markEventSeen } : {}),
    run: async () => {
      ran = true;
      delivered = await deps.dispatch({
        seatToken,
        wakeId,
        message: renderNeedsReissueWake({ wakeId, row, requestId: input.requestId, nowIso: new Date().toISOString(), edge: input.edge, ...(input.taskId !== undefined ? { taskId: input.taskId } : {}) }),
        origin: row.origin,
        surfaceKey: row.surfaceKey,
        binding: row.binding,
        requester: row.requester,
        nonMemberWake: row.nonMemberWake,
        requestId: input.requestId,
        tainted: row.tainted,
      });
    },
  });
  if (ran && delivered) await deps.clearLedger(org, workLedgerId(input.requestId)).catch(() => undefined);
  if (ran) await deps.clearLedger(org, workSessionLedgerId(input.requestId)).catch(() => undefined);
  await audit(ran ? { outcome: delivered ? "delivered" : "failed", wakeId } : { outcome: "replay-skipped" });
  return ran && delivered;
}

const WORK_FORWARD_PREFIX = "oe-work-forward:";
const WORK_REDELIVER_PREFIX = "oe-work-redeliver:";
const WORK_FORWARD_TTL_MS = WORK_TASK_KEY_TTL_MS;

export type WorkForward = Parameters<typeof dispatchWorkRequest>[0];

export async function rememberWorkForward(store: WorkRowStore, org: string, forward: WorkForward, atIso: string): Promise<void> {
  await store.putTaskResult(org, `${WORK_FORWARD_PREFIX}${forward.requestId}`, JSON.stringify(forward), atIso, WORK_FORWARD_TTL_MS);
}

export async function readWorkForward(store: WorkRowStore, org: string, requestId: string): Promise<WorkForward | undefined> {
  try {
    const raw = await store.getTaskResult(org, `${WORK_FORWARD_PREFIX}${requestId}`);
    if (raw === null) return undefined;
    const f = JSON.parse(raw) as Partial<WorkForward> | null;
    if (
      f === null ||
      f.requestId !== requestId ||
      typeof f.token !== "string" ||
      typeof f.message !== "string" ||
      typeof f.surfaceKey !== "string" ||
      typeof f.seatWakeId !== "string" ||
      typeof f.tainted !== "boolean" ||
      typeof f.nonMemberWake !== "boolean" ||
      typeof f.origin !== "object" ||
      typeof f.binding !== "object" ||
      typeof f.requester !== "object" ||
      f.origin === null ||
      f.binding === null ||
      f.requester === null ||
      (f.invokerPosture !== undefined && !["untrusted-remote", "unattended-fire", "attended-fire", "interactive"].includes(f.invokerPosture as string))
    ) {
      return undefined;
    }
    return f as WorkForward;
  } catch {
    return undefined;
  }
}

export interface ReissueDeps extends NeedsReissueDeps {
  readonly redeliver: (forward: WorkForward) => Promise<void>;
  readonly wakeSeat: typeof wakeSeatNeedsReissue;
}

async function liveReissueDeps(): Promise<ReissueDeps> {
  return { ...(await liveNeedsReissueDeps()), redeliver: dispatchWorkRequest, wakeSeat: wakeSeatNeedsReissue };
}

export async function reissueWorkRequest(
  input: { readonly requestId: string; readonly reason: WorkStampFailure; readonly stamped?: string; readonly deliveryId?: string },
  depsIn?: ReissueDeps,
): Promise<"redelivered" | "seat" | "replay"> {
  let deps: ReissueDeps;
  try {
    deps = depsIn ?? (await liveReissueDeps());
  } catch {
    return "seat";
  }
  const org = deps.org();
  const store = deps.store();
  const resentKey = `${WORK_REDELIVER_PREFIX}${input.requestId}`;
  const resent = await store.getTaskResult(org, resentKey).catch(() => null);
  const forward = await readWorkForward(store, org, input.requestId).catch(() => undefined);
  const sendOnce = async (f: WorkForward): Promise<{ ran: boolean; delivered: boolean }> => {
    let ran = false;
    let delivered = false;
    await postOnce({
      org,
      key: outboundKey({ surface: "work", action: "work.redeliver", stableId: input.requestId, payload: input.requestId }),
      ...(deps.markEventSeen ? { markEventSeen: deps.markEventSeen } : {}),
      run: async () => {
        ran = true;
        try {
          await deps.redeliver(f);
          delivered = true;
        } catch {
          delivered = false;
        }
      },
    });
    return { ran, delivered };
  };
  if (resent !== null) {
    let prior: { stamped?: unknown; deliveryId?: unknown } | null = null;
    try {
      prior = JSON.parse(resent) as { stamped?: unknown; deliveryId?: unknown } | null;
    } catch {
      prior = null;
    }
    const sameStep = input.deliveryId !== undefined && prior?.deliveryId === input.deliveryId && prior?.stamped === (input.stamped ?? null);
    if (sameStep) {
      if (forward !== undefined) await sendOnce(forward);
      return "redelivered";
    }
  }
  if (forward !== undefined && resent === null) {
    await store.putTaskResult(org, resentKey, JSON.stringify({ stamped: input.stamped ?? null, deliveryId: input.deliveryId ?? null }), new Date().toISOString(), WORK_FORWARD_TTL_MS).catch(() => undefined);
    const { ran, delivered } = await sendOnce(forward);
    if (ran && delivered) {
      await deps
        .audit({
          org,
          platform: "unified",
          workspace: "delegation",
          action: WORK_NEEDS_REISSUE_ACTION,
          detail: { requestId: input.requestId, edge: "validate", reason: input.reason, ...(input.stamped !== undefined ? { stamped: input.stamped } : {}), outcome: "redelivered" },
        })
        .catch(() => undefined);
      return "redelivered";
    }
  }
  const woke = await deps.wakeSeat({ requestId: input.requestId, edge: "validate", reason: input.reason, ...(input.stamped !== undefined ? { stamped: input.stamped } : {}) }, deps).catch(() => false);
  return woke ? "seat" : "replay";
}

registerWorkReissuer(reissueWorkRequest);
