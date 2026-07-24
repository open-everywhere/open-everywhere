import { appendAudit } from "../audit/audit.js";
import { criteriaDomain, domainForChannel, type Domain } from "../memory/domain.js";

export type AudienceFloor = "guest" | "member" | "admin";

export interface RoomRoster {
  readonly humanMemberIds: readonly string[];
  readonly resolved: boolean;
  readonly isPrivate: boolean;
  readonly hasGuest: boolean;
}

export function computeAudienceFloor(roster: RoomRoster, admins: ReadonlySet<string>): AudienceFloor {
  if (!roster.resolved || roster.hasGuest) return "guest";
  const humans = roster.humanMemberIds;
  const allAdmins = humans.length > 0 && humans.every((id) => admins.has(id));
  if (allAdmins && roster.isPrivate) return "admin";
  return "member";
}

export type FloorBreachReason = "members-unresolved" | "public-channel" | "guest-present" | "non-admin-member";

export interface FloorAttestation {
  readonly armed: boolean;
  readonly floor: AudienceFloor;
  readonly breach?: {
    readonly reason: FloorBreachReason;
    readonly missing: readonly string[];
    readonly members: readonly string[];
  };
}

export function attestGovernanceFloor(roster: RoomRoster, admins: ReadonlySet<string>): FloorAttestation {
  const floor = computeAudienceFloor(roster, admins);
  if (floor === "admin") return { armed: true, floor };
  const members = roster.humanMemberIds;
  const missing = members.filter((id) => !admins.has(id));
  const reason: FloorBreachReason = !roster.resolved
    ? "members-unresolved"
    : roster.hasGuest
      ? "guest-present"
      : !roster.isPrivate
        ? "public-channel"
        : "non-admin-member";
  return { armed: false, floor, breach: { reason, missing, members } };
}

export function governanceAdminSet(channelKey: string, domains: readonly Domain[]): ReadonlySet<string> {
  const set = new Set<string>(criteriaDomain("org", domains)?.admins ?? []);
  for (const a of domainForChannel(channelKey, domains)?.admins ?? []) set.add(a);
  return set;
}

export type GovernanceMemberSupplier = (channelKey: string) => Promise<RoomRoster | undefined>;

let supplier: GovernanceMemberSupplier | null = null;

export function registerGovernanceMemberSupplier(fn: GovernanceMemberSupplier): void {
  supplier = fn;
}

export function _resetGovernanceMemberSupplierForTest(): void {
  supplier = null;
}

export function governanceMemberSupplier(): GovernanceMemberSupplier {
  return supplier ?? (async () => undefined);
}

interface CachedAttestation {
  readonly attestation: FloorAttestation;
  readonly at: number;
}
const FLOOR_TTL_MS = Number(process.env.OE_GOVERNANCE_FLOOR_TTL_MS) || 15 * 60_000;
const floorCache = new Map<string, CachedAttestation>();

export function _resetGovernanceFloorCacheForTest(): void {
  floorCache.clear();
}

export interface FloorAttestContext {
  readonly org: string;
  readonly platform: string;
  readonly workspace: string;
  readonly surface: string;
  readonly principalId?: string;
}

export async function attestGovernanceChannel(
  channelKey: string,
  domains: readonly Domain[],
  ctx: FloorAttestContext,
): Promise<FloorAttestation> {
  const cached = floorCache.get(channelKey);
  if (cached && Date.now() - cached.at < FLOOR_TTL_MS) return cached.attestation;

  const roster = (await governanceMemberSupplier()(channelKey)) ?? {
    humanMemberIds: [] as string[],
    resolved: false,
    isPrivate: false,
    hasGuest: false,
  };
  const attestation = attestGovernanceFloor(roster, governanceAdminSet(channelKey, domains));
  floorCache.set(channelKey, { attestation, at: Date.now() });

  if (!attestation.armed && attestation.breach) {
    const domainName = domainForChannel(channelKey, domains)?.name;
    await appendAudit({
      org: ctx.org,
      platform: ctx.platform,
      workspace: ctx.workspace,
      surface: ctx.surface,
      principalId: ctx.principalId,
      action: "governance.floor_breach",
      detail: {
        domain: domainName,
        channelKey,
        reason: attestation.breach.reason,
        missing: attestation.breach.missing,
        members: attestation.breach.members,
      },
    });
  }
  return attestation;
}

export function floorBreachNotice(breach: NonNullable<FloorAttestation["breach"]>): string {
  switch (breach.reason) {
    case "members-unresolved":
      return "governance behaviour is suspended: I couldn't verify this channel's membership (fail-closed).";
    case "public-channel":
      return "governance behaviour is suspended: this channel is public — a governance venue must be private.";
    case "guest-present":
      return "governance behaviour is suspended: a guest/external member is present in this channel.";
    case "non-admin-member": {
      const who = breach.missing.length > 0 ? breach.missing.map((m) => `@${m}`).join(", ") : "someone";
      return `this channel has members without admin standing — governance behaviour is suspended: ${who} isn't on the roster.`;
    }
  }
}
