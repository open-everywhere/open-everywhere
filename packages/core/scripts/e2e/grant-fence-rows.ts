import type { AuditWireEntry } from "./audit-read.js";

export interface FenceRowDetail {
  readonly op?: unknown;
  readonly reason?: unknown;
  readonly tier?: unknown;
  readonly grant?: unknown;
  readonly routine?: unknown;
  readonly connector?: unknown;
  readonly owner?: unknown;
  readonly ownerPlatform?: unknown;
  readonly grantId?: unknown;
  readonly outcome?: unknown;
  readonly gate?: unknown;
}

const detailOf = (e: AuditWireEntry): FenceRowDetail => (e.detail ?? {}) as FenceRowDetail;

export function connectorToolGrantKind(tool: string): string {
  return `connector.tool:${tool}`;
}

export const ASK_UNATTENDED_REASONS: readonly string[] = ["ask-unattended", "ask-unattended-tainted"];

export function isUnattendedFenceRefusal(e: AuditWireEntry, op: string): boolean {
  if (e.action !== "connector.refused") return false;
  const d = detailOf(e);
  return d.op === op && typeof d.reason === "string" && ASK_UNATTENDED_REASONS.includes(d.reason);
}

export function isUnattendedLift(e: AuditWireEntry, op: string): boolean {
  return e.action === "connector.unattended_lift" && detailOf(e).op === op;
}

export function splitFenceRows(
  rows: readonly AuditWireEntry[],
  op: string,
): { readonly refused: readonly AuditWireEntry[]; readonly lifted: readonly AuditWireEntry[]; readonly otherRefusals: readonly AuditWireEntry[] } {
  return {
    refused: rows.filter((e) => isUnattendedFenceRefusal(e, op)),
    lifted: rows.filter((e) => isUnattendedLift(e, op)),
    otherRefusals: rows.filter((e) => e.action === "connector.refused" && detailOf(e).op === op && !isUnattendedFenceRefusal(e, op)),
  };
}

export function allAtWriteTier(rows: readonly AuditWireEntry[]): boolean {
  return rows.length > 0 && rows.every((e) => detailOf(e).tier === "write");
}

export function allNameGrantKind(rows: readonly AuditWireEntry[], expected: string): boolean {
  return rows.length > 0 && rows.every((e) => detailOf(e).grant === expected);
}

export function allAttributedToRoutine(rows: readonly AuditWireEntry[]): boolean {
  return rows.length > 0 && rows.every((e) => typeof detailOf(e).routine === "string" && (detailOf(e).routine as string).length > 0);
}

export function ownerPlatformOf(e: AuditWireEntry): string | undefined {
  const owner = detailOf(e).owner;
  if (typeof owner !== "string") return undefined;
  const head = owner.split("/")[0];
  return head !== undefined && head.length > 0 && head.length < owner.length ? head : undefined;
}

export function discordOwnedAsks(rows: readonly AuditWireEntry[]): readonly AuditWireEntry[] {
  return rows.filter((e) => e.action === "grant.asked" && ownerPlatformOf(e) === "discord");
}

export function discordOwnedGrants(rows: readonly AuditWireEntry[]): readonly AuditWireEntry[] {
  return rows.filter((e) => e.action === "grant.granted" && ownerPlatformOf(e) === "discord");
}

export function noticesForGrant(rows: readonly AuditWireEntry[], grantId: string): readonly AuditWireEntry[] {
  return rows.filter((e) => e.action === "grant.notified" && detailOf(e).grantId === grantId);
}

export function refusedUnverifiedRequester(rows: readonly AuditWireEntry[]): readonly AuditWireEntry[] {
  return rows.filter((e) => e.action === "grant.refused" && detailOf(e).gate === "unverified_requester");
}

export function allNoticesDelivered(rows: readonly AuditWireEntry[], platform: string): boolean {
  return rows.length > 0 && rows.every((e) => detailOf(e).outcome === "sent" && detailOf(e).ownerPlatform === platform);
}
