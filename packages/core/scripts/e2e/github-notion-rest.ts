import type { AuditWireEntry } from "./audit-read.js";

export const GITHUB_NOTION_REST_ACTIONS = ["github.dispatched", "wake.ingress", "wake.turn_start", "reply.post", "egress.policy"] as const;

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
