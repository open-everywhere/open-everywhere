import { appendAudit } from "../audit/audit.js";
import { deploymentOrg } from "../identity/binding.js";
import { getOperationalStore } from "../operational/provider.js";
import { readWorkRequest, type WorkRequestRow, type WorkRowStore } from "../channels/work.js";
import { WAKE_TARGET_TTL_MS, type UnifiedWakeOrigin } from "../channels/unified-window.js";
import { turnAnchorKey } from "../channels/turn-registry.js";
import { setSurfaceReaction } from "../channels/surface-message-ops.js";
import { STOP_HAND_SLACK_NAME, STOP_HAND_UNICODE } from "../status/status.js";
import type { AuditDetail } from "../audit/scrubbed-text.js";

export const WORK_STATUS_ACTION = "work.status";

export type WorkJobState = "working" | "completed" | "failed" | "cancelled";

export interface WorkJobStatus {
  readonly requestId: string;
  readonly taskId: string;
  readonly state: WorkJobState;
  readonly startedAt: string;
  readonly settledAt?: string;
  readonly anchorKey?: string;
}

export interface AnchoredWorkJob {
  readonly requestId: string;
  readonly taskId: string;
}

const WORK_STATUS_TTL_MS = WAKE_TARGET_TTL_MS;
const WORK_STATUS_PREFIX = "oe-work-status:";
const WORK_HAND_PREFIX = "oe-work-hand:";

const STOP_HAND = { slackName: STOP_HAND_SLACK_NAME, unicode: STOP_HAND_UNICODE } as const;

export function workStatusKey(requestId: string): string {
  return `${WORK_STATUS_PREFIX}${requestId}`;
}

export function workHandKey(anchorKey: string): string {
  return `${WORK_HAND_PREFIX}${anchorKey}`;
}

export function askingMessageOf(origin: UnifiedWakeOrigin): { readonly platform: string; readonly channelId: string; readonly messageId: string } | undefined {
  if (origin.platform === "discord") {
    return origin.messageId !== undefined && origin.messageId.length > 0 ? { platform: "discord", channelId: origin.channelId, messageId: origin.messageId } : undefined;
  }
  if (origin.platform === "slack") {
    const messageId = origin.threadTs ?? origin.replyAnchorTs;
    return messageId !== undefined && messageId.length > 0 ? { platform: "slack", channelId: origin.channelId, messageId } : undefined;
  }
  return undefined;
}

const STATES: readonly WorkJobState[] = ["working", "completed", "failed", "cancelled"];

export async function readWorkJobStatus(store: WorkRowStore, org: string, requestId: string): Promise<WorkJobStatus | undefined> {
  try {
    const raw = await store.getTaskResult(org, workStatusKey(requestId));
    if (raw === null) return undefined;
    const row = JSON.parse(raw) as Partial<WorkJobStatus> | null;
    if (
      row === null ||
      row.requestId !== requestId ||
      typeof row.taskId !== "string" ||
      row.taskId.length === 0 ||
      !STATES.includes(row.state as WorkJobState) ||
      typeof row.startedAt !== "string"
    ) {
      return undefined;
    }
    return row as WorkJobStatus;
  } catch {
    return undefined;
  }
}

async function writeWorkJobStatus(store: WorkRowStore, org: string, status: WorkJobStatus): Promise<void> {
  await store.putTaskResult(org, workStatusKey(status.requestId), JSON.stringify(status), status.settledAt ?? status.startedAt, WORK_STATUS_TTL_MS);
}

export async function readAnchoredWorkJobs(store: WorkRowStore, org: string, anchorKey: string): Promise<readonly AnchoredWorkJob[]> {
  try {
    const raw = await store.getTaskResult(org, workHandKey(anchorKey));
    if (raw === null) return [];
    const list = JSON.parse(raw) as unknown;
    if (!Array.isArray(list)) return [];
    return list.filter(
      (j): j is AnchoredWorkJob =>
        j !== null && typeof j === "object" && typeof (j as AnchoredWorkJob).requestId === "string" && typeof (j as AnchoredWorkJob).taskId === "string",
    );
  } catch {
    return [];
  }
}

const anchorLocks = new Map<string, Promise<unknown>>();

async function withAnchorLock<T>(anchorKey: string, run: () => Promise<T>): Promise<T> {
  const prev = anchorLocks.get(anchorKey) ?? Promise.resolve();
  const next = prev.then(run, run);
  const settled = next.catch(() => undefined);
  anchorLocks.set(anchorKey, settled);
  try {
    return await next;
  } finally {
    if (anchorLocks.get(anchorKey) === settled) anchorLocks.delete(anchorKey);
  }
}

export interface WorkStatusDeps {
  readonly org: () => string;
  readonly store: () => WorkRowStore;
  readonly react: (platform: string, ref: { readonly channelId: string; readonly messageId: string }, on: boolean) => Promise<boolean>;
  readonly audit: (row: Parameters<typeof appendAudit>[0]) => Promise<unknown>;
  readonly now: () => Date;
}

const LIVE_DEPS: WorkStatusDeps = {
  org: deploymentOrg,
  store: getOperationalStore,
  react: (platform, ref, on) => setSurfaceReaction(platform, ref, STOP_HAND, on),
  audit: appendAudit,
  now: () => new Date(),
};

function auditStatus(deps: WorkStatusDeps, org: string, row: WorkRequestRow | undefined, detail: AuditDetail): Promise<unknown> {
  return deps
    .audit({
      org,
      platform: "unified",
      workspace: "delegation",
      action: WORK_STATUS_ACTION,
      ...(row?.requester.kind === "requester" ? { principalId: row.requester.principalId } : {}),
      detail,
    })
    .catch(() => undefined);
}

export async function noteWorkJobStarted(input: { readonly requestId: string; readonly taskId: string }, deps: WorkStatusDeps = LIVE_DEPS): Promise<boolean> {
  try {
    const org = deps.org();
    const store = deps.store();
    const prior = await readWorkJobStatus(store, org, input.requestId);
    if (prior !== undefined && prior.taskId === input.taskId && prior.state !== "working") return false;
    const row = await readWorkRequest(store, org, input.requestId).catch(() => undefined);
    const asking = row === undefined ? undefined : askingMessageOf(row.origin);
    const anchorKey = asking === undefined ? undefined : turnAnchorKey(asking.platform, asking.channelId, asking.messageId);
    const startedAt = deps.now().toISOString();
    await writeWorkJobStatus(store, org, { requestId: input.requestId, taskId: input.taskId, state: "working", startedAt, ...(anchorKey !== undefined ? { anchorKey } : {}) });
    let handOn = false;
    if (asking !== undefined && anchorKey !== undefined) {
      handOn = await withAnchorLock(anchorKey, async () => {
        const jobs = await readAnchoredWorkJobs(store, org, anchorKey);
        const next = [...jobs.filter((j) => j.requestId !== input.requestId), { requestId: input.requestId, taskId: input.taskId }];
        await store.putTaskResult(org, workHandKey(anchorKey), JSON.stringify(next), startedAt, WORK_STATUS_TTL_MS);
        return await deps.react(asking.platform, { channelId: asking.channelId, messageId: asking.messageId }, true).catch(() => false);
      });
    }
    await auditStatus(deps, org, row, { requestId: input.requestId, taskId: input.taskId, state: "working", hand: handOn ? "placed" : "none" });
    return handOn;
  } catch (err) {
    console.warn(`[open-everywhere:work] status at task.started failed for request ${input.requestId}: ${String(err)}`);
    return false;
  }
}

export function settledWorkJobStateFor(eveStatus: string, ticketRedeemed: boolean): string {
  return eveStatus === "completed" && ticketRedeemed ? "cancelled" : eveStatus;
}

export function settledWorkJobState(status: string): WorkJobState {
  return status === "completed" ? "completed" : status === "cancelled" ? "cancelled" : "failed";
}

export async function noteWorkJobSettled(input: { readonly requestId: string; readonly taskId: string; readonly status: string }, deps: WorkStatusDeps = LIVE_DEPS): Promise<void> {
  try {
    const org = deps.org();
    const store = deps.store();
    const prior = await readWorkJobStatus(store, org, input.requestId);
    const row = await readWorkRequest(store, org, input.requestId).catch(() => undefined);
    const asking = row === undefined ? undefined : askingMessageOf(row.origin);
    const anchorKey = prior?.anchorKey ?? (asking === undefined ? undefined : turnAnchorKey(asking.platform, asking.channelId, asking.messageId));
    const settledAt = deps.now().toISOString();
    const firstWins = prior !== undefined && prior.taskId === input.taskId && prior.state !== "working";
    const state = firstWins ? prior.state : settledWorkJobState(input.status);
    await writeWorkJobStatus(store, org, {
      requestId: input.requestId,
      taskId: input.taskId,
      state,
      startedAt: prior?.startedAt ?? settledAt,
      settledAt: firstWins ? (prior.settledAt ?? settledAt) : settledAt,
      ...(anchorKey !== undefined ? { anchorKey } : {}),
    });
    let hand = "none";
    if (anchorKey !== undefined && asking !== undefined) {
      hand = await withAnchorLock(anchorKey, async () => {
        const jobs = await readAnchoredWorkJobs(store, org, anchorKey);
        const rest = jobs.filter((j) => j.requestId !== input.requestId);
        await store.putTaskResult(org, workHandKey(anchorKey), JSON.stringify(rest), settledAt, WORK_STATUS_TTL_MS);
        if (rest.length > 0) return "kept";
        return (await deps.react(asking.platform, { channelId: asking.channelId, messageId: asking.messageId }, false).catch(() => false)) ? "removed" : "none";
      });
    }
    await auditStatus(deps, org, row, { requestId: input.requestId, taskId: input.taskId, state, hand });
  } catch (err) {
    console.warn(`[open-everywhere:work] status at task.settled failed for request ${input.requestId}: ${String(err)}`);
  }
}

export function renderWorkJobStatus(status: WorkJobStatus | undefined, requestId: string): string {
  if (status === undefined) return `Job ${requestId} has not started in the work session yet.`;
  if (status.state === "working") return `Job ${requestId} (task ${status.taskId}) is working, since ${status.startedAt}.`;
  const word = status.state === "completed" ? "finished" : status.state === "cancelled" ? "was stopped" : "failed";
  return `Job ${requestId} (task ${status.taskId}) ${word}${status.settledAt !== undefined ? ` at ${status.settledAt}` : ""}.`;
}
