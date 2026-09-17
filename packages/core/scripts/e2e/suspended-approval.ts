import type { AuditWireEntry } from "./audit-read.js";

export const SUSPENDED_APPROVAL_ACTIONS = [
  "wake.ingress",
  "turn.question_bridged",
  "input_response.routed",
  "approval.eve_settled",
  "unified.task_wake",
  "reply.post",
] as const;

export interface SuspendedMessageAnchor {
  readonly platform: string;
  readonly surfaceKey: string;
  readonly vendorTs: string;
}

export interface SuspendedApprovalRequest {
  readonly wakeId: string;
  readonly requestId: string;
  readonly sessionId: string;
  readonly messageId: string;
  readonly platform: string;
  readonly workspace: string;
  readonly containerKey: string;
  readonly bridgedAt: string;
}

export interface SuspendedApprovalLifecycle {
  readonly request: SuspendedApprovalRequest;
  readonly answerWakeId: string;
  readonly routed: AuditWireEntry;
  readonly settled: AuditWireEntry;
  readonly reply: AuditWireEntry;
}

export interface SuspendedReplyCandidate {
  readonly id: string;
  readonly text: string;
}

function nonempty(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function slackVendorTimestamp(ts: string): string | undefined {
  const match = /^(\d+)\.(\d{1,6})$/.exec(ts);
  if (!match) return undefined;
  const seconds = Number(match[1]);
  const fraction = Number(`0.${match[2]}`);
  if (!Number.isFinite(seconds) || !Number.isFinite(fraction)) return undefined;
  const date = new Date(Math.round(seconds * 1000 + fraction * 1000));
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function atOrAfter(row: AuditWireEntry, floor: string): boolean {
  const rowMs = Date.parse(row.ts);
  const floorMs = Date.parse(floor);
  return Number.isFinite(rowMs) && Number.isFinite(floorMs) && rowMs >= floorMs;
}

function settlementRequestId(parentRequestId: string, routedTaskId: string | undefined): string | undefined {
  if (routedTaskId === undefined) return parentRequestId;
  const prefix = `${routedTaskId}:`;
  if (!parentRequestId.startsWith(prefix)) return undefined;
  return nonempty(parentRequestId.slice(prefix.length));
}

function ingressWakeIds(rows: readonly AuditWireEntry[], anchor: SuspendedMessageAnchor): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const row of rows) {
    if (
      row.action !== "wake.ingress" ||
      row.platform !== anchor.platform ||
      row.detail?.surfaceKey !== anchor.surfaceKey ||
      row.detail.vendorTs !== anchor.vendorTs
    ) continue;
    const wakeId = nonempty(row.detail.wakeId);
    if (wakeId) ids.add(wakeId);
  }
  return ids;
}

export function suspendedApprovalRequest(
  rows: readonly AuditWireEntry[],
  input: {
    readonly anchor: SuspendedMessageAnchor;
    readonly destinationPlatform: string;
    readonly destinationWorkspace: string;
    readonly containerKey: string;
  },
): SuspendedApprovalRequest | undefined {
  const wakeIds = ingressWakeIds(rows, input.anchor);
  if (wakeIds.size === 0) return undefined;

  const found = new Map<string, SuspendedApprovalRequest>();
  for (const row of rows) {
    const detail = row.detail;
    if (
      row.action !== "turn.question_bridged" ||
      row.platform !== "unified" ||
      row.workspace !== input.destinationWorkspace ||
      detail?.kind !== "tool-approval" ||
      detail.platform !== input.destinationPlatform ||
      detail.containerKey !== input.containerKey
    ) continue;
    const wakeId = nonempty(detail.wakeId);
    const requestId = nonempty(detail.requestId);
    const sessionId = nonempty(detail.sessionId);
    const messageId = nonempty(detail.id);
    if (!wakeId || !wakeIds.has(wakeId) || !requestId || !sessionId || !messageId) continue;
    const candidate = {
      wakeId,
      requestId,
      sessionId,
      messageId,
      platform: input.destinationPlatform,
      workspace: input.destinationWorkspace,
      containerKey: input.containerKey,
      bridgedAt: row.ts,
    };
    found.set(`${requestId}\u0000${sessionId}\u0000${messageId}`, candidate);
  }
  return found.size === 1 ? found.values().next().value : undefined;
}

export function approvedSuspendedContinuation(
  rows: readonly AuditWireEntry[],
  input: {
    readonly request: SuspendedApprovalRequest;
    readonly answer: SuspendedMessageAnchor;
    readonly replyPlatform: string;
    readonly replyId: string;
  },
): SuspendedApprovalLifecycle | undefined {
  const answerWakeIds = ingressWakeIds(rows, input.answer);
  if (answerWakeIds.size === 0) return undefined;

  const routed = rows.find((row) => {
    const detail = row.detail;
    return (
      row.action === "input_response.routed" &&
      row.platform === "unified" &&
      detail?.requestId === input.request.requestId &&
      detail.optionId === "approve" &&
      typeof detail.wakeId === "string" &&
      answerWakeIds.has(detail.wakeId) &&
      atOrAfter(row, input.request.bridgedAt)
    );
  });
  if (!routed) return undefined;

  const taskId = nonempty(routed.detail?.taskId);
  const settledRequestId = settlementRequestId(input.request.requestId, taskId);
  if (settledRequestId === undefined) return undefined;
  const settled = rows.find(
    (row) =>
      row.action === "approval.eve_settled" &&
      row.detail?.requestId === settledRequestId &&
      row.detail.outcome === "approved" &&
      atOrAfter(row, input.request.bridgedAt),
  );
  if (!settled) return undefined;

  const answerWakeId = nonempty(routed.detail?.wakeId)!;
  const replyWakeFloors = new Map<string, string>([
    [answerWakeId, settled.ts],
    [input.request.wakeId, settled.ts],
  ]);
  if (taskId !== undefined) {
    const installedTaskWake = rows.find(
      (row) =>
        row.action === "unified.task_wake" &&
        row.detail?.task === taskId &&
        (row.detail.outcome === "installed" || row.detail.outcome === "already") &&
        row.detail.sessionId === input.request.sessionId &&
        typeof row.detail.wakeId === "string" &&
        atOrAfter(row, settled.ts),
    );
    const taskWakeId = nonempty(installedTaskWake?.detail?.wakeId);
    if (taskWakeId !== undefined && installedTaskWake !== undefined) replyWakeFloors.set(taskWakeId, installedTaskWake.ts);
  }
  const reply = rows.find(
    (row) => {
      const replyWakeId = nonempty(row.detail?.wakeId);
      const floor = replyWakeId === undefined ? undefined : replyWakeFloors.get(replyWakeId);
      return (
        row.action === "reply.post" &&
        row.platform === input.replyPlatform &&
        row.detail?.id === input.replyId &&
        floor !== undefined &&
        row.detail.sessionId === input.request.sessionId &&
        atOrAfter(row, floor)
      );
    },
  );
  if (!reply) return undefined;

  return { request: input.request, answerWakeId, routed, settled, reply };
}

export function approvedSuspendedReply<T extends SuspendedReplyCandidate>(
  rows: readonly AuditWireEntry[],
  input: {
    readonly request: SuspendedApprovalRequest;
    readonly answer: SuspendedMessageAnchor;
    readonly replyPlatform: string;
    readonly candidates: readonly T[];
    readonly beforeAnswer: ReadonlyMap<string, string>;
  },
): { readonly candidate: T; readonly lifecycle: SuspendedApprovalLifecycle } | undefined {
  for (const candidate of input.candidates) {
    const before = input.beforeAnswer.get(candidate.id);
    if (before !== undefined && before === candidate.text) continue;
    const lifecycle = approvedSuspendedContinuation(rows, {
      request: input.request,
      answer: input.answer,
      replyPlatform: input.replyPlatform,
      replyId: candidate.id,
    });
    if (lifecycle) return { candidate, lifecycle };
  }
  return undefined;
}
