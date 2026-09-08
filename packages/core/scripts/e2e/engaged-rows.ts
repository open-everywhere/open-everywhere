import type { AuditWireEntry } from "./audit-read.js";

export const STOOD_DOWN_ACTION = "engagement.stood_down";

export const REPLY_POST_ACTION = "reply.post";

export function dispatchedAction(platform: string): string {
  return `${platform}.dispatched`;
}

function detail(row: AuditWireEntry): Readonly<Record<string, unknown>> {
  return row.detail ?? {};
}

function detailString(row: AuditWireEntry, key: string): string | undefined {
  const v = detail(row)[key];
  return typeof v === "string" ? v : undefined;
}

export function standDownRows(
  rows: readonly AuditWireEntry[],
  opts: { readonly surface?: string; readonly anchor?: string } = {},
): readonly AuditWireEntry[] {
  return rows.filter(
    (r) =>
      r.action === STOOD_DOWN_ACTION &&
      (opts.surface === undefined || r.surface === opts.surface || detailString(r, "surfaceKey") === opts.surface) &&
      (opts.anchor === undefined || detailString(r, "anchor") === opts.anchor),
  );
}

export function standDownMarked(
  rows: readonly AuditWireEntry[],
  opts: { readonly surface?: string; readonly anchor?: string } = {},
): boolean {
  return standDownRows(rows, opts).some((r) => detail(r)["marked"] === true);
}

export function standDownAttemptedButUnmarked(
  rows: readonly AuditWireEntry[],
  opts: { readonly surface?: string; readonly anchor?: string } = {},
): boolean {
  return standDownRows(rows, opts).some((r) => detail(r)["marked"] === false);
}

export function dispatchAddressings(rows: readonly AuditWireEntry[], platform: string): readonly string[] {
  const action = dispatchedAction(platform);
  return rows.filter((r) => r.action === action).flatMap((r) => {
    const a = detailString(r, "addressing");
    return a === undefined ? [] : [a];
  });
}

export const AMBIENT_LEG_ADDRESSINGS: readonly string[] = ["channel-watch", "thread-follow"];

export function isAmbientLegAddressing(value: unknown): boolean {
  return typeof value === "string" && AMBIENT_LEG_ADDRESSINGS.includes(value);
}

export function reportedThreadFollow(rows: readonly AuditWireEntry[], platform: string): boolean {
  return dispatchAddressings(rows, platform).includes("thread-follow");
}

export function reportedDirectMention(rows: readonly AuditWireEntry[], platform: string): boolean {
  const seen = dispatchAddressings(rows, platform);
  return seen.includes("direct-mention") || seen.includes("direct");
}

export function reportedNameDrop(rows: readonly AuditWireEntry[], platform: string): boolean {
  return dispatchAddressings(rows, platform).includes("name-drop");
}

export function replyPostCount(rows: readonly AuditWireEntry[], opts: { readonly surface?: string } = {}): number {
  return rows.filter((r) => r.action === REPLY_POST_ACTION && (opts.surface === undefined || r.surface === opts.surface)).length;
}
