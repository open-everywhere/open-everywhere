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
  readonly scopeKey?: unknown;
  readonly domainScopeKey?: unknown;
  readonly callerScopeKey?: unknown;
  readonly wakeId?: unknown;
  readonly sessionId?: unknown;
  readonly vendorTs?: unknown;
  readonly vendorTsSource?: unknown;
  readonly surfaceKey?: unknown;
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

export function discordWakeSessionIds(rows: readonly AuditWireEntry[], messageId: string, channelId: string): readonly string[] {
  if (channelId.length === 0) return [];
  if (!/^[0-9]+$/.test(messageId)) return [];
  let vendorTs: string;
  try {
    const snowflake = BigInt(messageId);
    if (snowflake <= 0n) return [];
    const ms = Number((snowflake >> 22n) + 1_420_070_400_000n);
    if (!Number.isFinite(ms) || Math.abs(ms) > 8.64e15) return [];
    vendorTs = new Date(ms).toISOString();
  } catch {
    return [];
  }
  const wakeIds = new Set(
    rows
      .filter(
        (e) =>
          e.action === "wake.ingress" &&
          e.platform === "discord" &&
          (surfaceNamesChannel(e.surface, channelId) ||
            (typeof detailOf(e).surfaceKey === "string" && surfaceNamesChannel(detailOf(e).surfaceKey as string, channelId))) &&
          detailOf(e).vendorTs === vendorTs &&
          detailOf(e).vendorTsSource === "discord-snowflake",
      )
      .map((e) => detailOf(e).wakeId)
      .filter((id): id is string => typeof id === "string" && id.length > 0),
  );
  if (wakeIds.size !== 1) return [];
  return [
    ...new Set(
      rows
        .filter((e) => e.action === "wake.turn_start" && typeof detailOf(e).wakeId === "string" && wakeIds.has(detailOf(e).wakeId as string))
        .map((e) => detailOf(e).sessionId)
        .filter((id): id is string => typeof id === "string" && id.length > 0),
    ),
  ];
}

export function exactDiscordOwnedAsks(rows: readonly AuditWireEntry[], askId: string, scopeKey: string): readonly AuditWireEntry[] {
  if (askId.length === 0 || scopeKey.length === 0) return [];
  return discordOwnedAsks(rows).filter((e) => detailOf(e).askId === askId && detailOf(e).scopeKey === scopeKey);
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

export function grantsForExactAsk(rows: readonly AuditWireEntry[], askId: string, scopeKeys: readonly string[]): readonly AuditWireEntry[] {
  const wanted = new Set(scopeKeys.filter((key) => key.length > 0));
  if (askId.length === 0 || wanted.size === 0) return [];
  return rows.filter((e) => e.action === "grant.granted" && detailOf(e).askId === askId && typeof detailOf(e).scopeKey === "string" && wanted.has(detailOf(e).scopeKey as string));
}

export function grantIdsOf(rows: readonly AuditWireEntry[]): readonly string[] {
  return rows.map((e) => detailOf(e).grantId).filter((id): id is string => typeof id === "string" && id.length > 0);
}

export function unexpiredGrants(rows: readonly AuditWireEntry[], nowMs: number): readonly AuditWireEntry[] {
  return rows.filter((e) => {
    const expiresAt = detailOf(e).expiresAt;
    if (typeof expiresAt !== "string") return false;
    const ms = Date.parse(expiresAt);
    return Number.isFinite(ms) && ms > nowMs;
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

export function currentDomainScopeKey(rows: readonly AuditWireEntry[], sessionScopeKey: string): string | undefined {
  if (sessionScopeKey.length === 0) return undefined;
  const keys = new Set<string>();
  for (const e of rows) {
    if (e.action !== "grant.asked" && e.action !== "grant.refused") continue;
    if (detailOf(e).scopeKey !== sessionScopeKey) continue;
    const key = detailOf(e).domainScopeKey;
    if (typeof key === "string" && key.length > 0) keys.add(key);
  }
  return keys.size === 1 ? [...keys][0] : undefined;
}

export function isSessionGrantRow(e: AuditWireEntry, sessionScopeKey: string): boolean {
  if (sessionScopeKey.length === 0) return false;
  if (e.action !== "grant.asked" && e.action !== "grant.refused") return false;
  return detailOf(e).scopeKey === sessionScopeKey;
}

export function grantReentryScope(
  saved: { readonly scopeKey: string; readonly domainScopeKey?: string },
  currentSessionId: string,
  currentDomainScopeKeyValue: string | undefined,
): "session" | "domain" | undefined {
  if (saved.scopeKey.length > 0 && saved.scopeKey === currentSessionId) return "session";
  const savedDomain = saved.domainScopeKey;
  if (savedDomain === undefined || savedDomain.length === 0) return undefined;
  return currentDomainScopeKeyValue !== undefined && currentDomainScopeKeyValue === savedDomain ? "domain" : undefined;
}
