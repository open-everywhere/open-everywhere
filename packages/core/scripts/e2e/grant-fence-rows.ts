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
  readonly askId?: unknown;
  readonly expiresAt?: unknown;
  readonly outcome?: unknown;
  readonly gate?: unknown;
}

const detailOf = (e: AuditWireEntry): FenceRowDetail => (e.detail ?? {}) as FenceRowDetail;

export function pinnedConnectorToolPermissionKind(tool: string): string {
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

export function allNamePermissionKind(rows: readonly AuditWireEntry[], expected: string): boolean {
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

export function noticesForGrant(rows: readonly AuditWireEntry[], grantId: string): readonly AuditWireEntry[] {
  return rows.filter((e) => e.action === "grant.notified" && detailOf(e).grantId === grantId);
}

export function surfaceNamesChannel(surface: string | undefined, channelId: string): boolean {
  if (surface === undefined || channelId.length === 0) return false;
  return surface === channelId || surface.endsWith(`/${channelId}`);
}

export function discordOwnedAsksInChannel(rows: readonly AuditWireEntry[], channelId: string): readonly AuditWireEntry[] {
  return discordOwnedAsks(rows).filter((e) => surfaceNamesChannel(e.surface, channelId));
}

export function askIdsOf(rows: readonly AuditWireEntry[]): readonly string[] {
  return rows.map((e) => detailOf(e).askId).filter((id): id is string => typeof id === "string" && id.length > 0);
}

export function grantsForAsks(rows: readonly AuditWireEntry[], askIds: readonly string[]): readonly AuditWireEntry[] {
  const wanted = new Set(askIds);
  return rows.filter((e) => e.action === "grant.granted" && typeof detailOf(e).askId === "string" && wanted.has(detailOf(e).askId as string));
}

export function grantIdsOf(rows: readonly AuditWireEntry[]): readonly string[] {
  return rows.map((e) => detailOf(e).grantId).filter((id): id is string => typeof id === "string" && id.length > 0);
}

export function unexpiredGrants(rows: readonly AuditWireEntry[], nowMs: number): readonly AuditWireEntry[] {
  return rows.filter((e) => {
    const expiresAt = detailOf(e).expiresAt;
    if (typeof expiresAt !== "string") return true;
    const ms = Date.parse(expiresAt);
    return !Number.isFinite(ms) || ms > nowMs;
  });
}

export function usesOfGrants(rows: readonly AuditWireEntry[], grantIds: readonly string[]): readonly AuditWireEntry[] {
  const wanted = new Set(grantIds);
  return rows.filter((e) => e.action === "grant.used" && typeof detailOf(e).grantId === "string" && wanted.has(detailOf(e).grantId as string));
}

export function refusedUnverifiedRequester(rows: readonly AuditWireEntry[]): readonly AuditWireEntry[] {
  return rows.filter((e) => e.action === "grant.refused" && detailOf(e).gate === "unverified_requester");
}

export function refusedGrantAlreadyLive(rows: readonly AuditWireEntry[]): readonly AuditWireEntry[] {
  return rows.filter((e) => e.action === "grant.refused" && detailOf(e).gate === "grant_already_live");
}

export function allNoticesDelivered(rows: readonly AuditWireEntry[], platform: string): boolean {
  return rows.length > 0 && rows.every((e) => detailOf(e).outcome === "sent" && detailOf(e).ownerPlatform === platform);
}
