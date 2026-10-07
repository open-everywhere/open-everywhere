import type { AuditWireEntry } from "./audit-read.js";
import { seatDelegationRows, WORK_FORWARDED_ACTION } from "./read-channel-lib.js";

export const WORK_RESULT_WAKE_ACTION = "work.result_wake";

export const GITHUB_NOTION_REST_ACTIONS = [
  "github.dispatched",
  "wake.ingress",
  "wake.turn_start",
  "reply.post",
  "egress.policy",
  WORK_FORWARDED_ACTION,
  "delegation.task_started",
  "delegation.task_settled",
  WORK_RESULT_WAKE_ACTION,
] as const;

export interface GithubNotionOrigin {
  readonly surfaceKey: string;
  readonly issueNumber: number;
  readonly commentId: number;
  readonly vendorCreatedAt: string;
}

export interface GithubNotionLifecycle {
  readonly deliveryId: string;
  readonly wakeId: string;
  readonly sessionId: string;
}

function detailString(row: AuditWireEntry, key: string): string | undefined {
  const value = row.detail?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function detailNumber(row: AuditWireEntry, key: string): number | undefined {
  const value = row.detail?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function githubNotionOriginLifecycle(rows: readonly AuditWireEntry[], origin: GithubNotionOrigin): GithubNotionLifecycle | undefined {
  const vendorTsMs = Date.parse(origin.vendorCreatedAt);
  if (Number.isNaN(vendorTsMs)) return undefined;
  const vendorTs = new Date(vendorTsMs).toISOString();

  const dispatched = rows.filter(
    (row) =>
      row.action === "github.dispatched" &&
      row.platform === "github" &&
      row.surface === origin.surfaceKey &&
      detailNumber(row, "issueNumber") === origin.issueNumber &&
      detailString(row, "commentId") === String(origin.commentId),
  );
  if (dispatched.length !== 1) return undefined;
  const wakeId = detailString(dispatched[0]!, "wakeId");
  if (!wakeId) return undefined;

  const ingresses = rows.filter(
    (row) =>
      row.action === "wake.ingress" &&
      row.platform === "github" &&
      row.surface === origin.surfaceKey &&
      detailString(row, "wakeId") === wakeId &&
      detailString(row, "surfaceKey") === origin.surfaceKey &&
      detailString(row, "vendorTs") === vendorTs &&
      detailString(row, "vendorTsSource") === "vendor-time",
  );
  if (ingresses.length !== 1) return undefined;
  const deliveryId = detailString(ingresses[0]!, "deliveryId");
  if (!deliveryId) return undefined;

  const starts = rows.filter((row) => row.action === "wake.turn_start" && detailString(row, "wakeId") === wakeId);
  const sessionIds = [...new Set(starts.map((row) => detailString(row, "sessionId")).filter((id): id is string => id !== undefined))];
  if (starts.some((row) => detailString(row, "sessionId") === undefined) || sessionIds.length !== 1) return undefined;
  return { deliveryId, wakeId, sessionId: sessionIds[0]! };
}

export function githubNotionReplyRow(
  rows: readonly AuditWireEntry[],
  input: {
    readonly replyId: number;
    readonly sessionId: string;
  },
): AuditWireEntry | undefined {
  const matches = rows.filter(
    (row) =>
      row.action === "reply.post" &&
      row.platform === "github" &&
      detailString(row, "id") === String(input.replyId) &&
      detailString(row, "sessionId") === input.sessionId,
  );
  return matches.length === 1 ? matches[0] : undefined;
}

export interface GithubNotionForward {
  readonly requestId: string;
  readonly workSessionId: string;
  readonly taskId: string;
  readonly resultWakeId: string;
}

export function githubNotionForward(rows: readonly AuditWireEntry[], lifecycle: GithubNotionLifecycle): GithubNotionForward | undefined {
  const joined = seatDelegationRows(rows, lifecycle.sessionId, lifecycle.wakeId);
  const forwards = joined.forwards.filter((row) => detailString(row, "wakeId") === lifecycle.wakeId);
  if (forwards.length !== 1) return undefined;
  const requestId = detailString(forwards[0]!, "requestId");
  if (!requestId) return undefined;
  const started = joined.started.filter((row) => detailString(row, "request") === requestId);
  if (started.length !== 1) return undefined;
  const workSessionId = detailString(started[0]!, "session");
  const taskId = detailString(started[0]!, "task");
  if (!workSessionId || !taskId || workSessionId === lifecycle.sessionId) return undefined;
  const settled = joined.settled.filter((row) => detailString(row, "task") === taskId && detailString(row, "session") === workSessionId);
  if (settled.length !== 1) return undefined;
  const results = rows.filter(
    (row) =>
      row.action === WORK_RESULT_WAKE_ACTION &&
      detailString(row, "requestId") === requestId &&
      detailString(row, "outcome") === "delivered",
  );
  if (results.length !== 1) return undefined;
  const resultWakeId = detailString(results[0]!, "wakeId");
  if (!resultWakeId) return undefined;
  return { requestId, workSessionId, taskId, resultWakeId };
}

export function githubNotionReplyNamesBlock(body: string, blockId: string): boolean {
  const normalized = blockId.toLowerCase().replaceAll("-", "");
  return normalized.length > 0 && body.toLowerCase().replaceAll("-", "").includes(normalized);
}
