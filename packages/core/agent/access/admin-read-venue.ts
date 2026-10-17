import { appendAudit } from "../audit/audit.js";
import { auditSurfaceModeStamp, bindFrom, type BindableContext } from "../identity/binding.js";
import type { SessionMode } from "./resolver.js";
import { domainKeyOf, resolvePartition } from "../memory/partition.js";
import { getConfig } from "./config.js";
import { domainForChannel, isGovernanceChannel } from "../memory/domain.js";
import { attestGovernanceChannel, type FloorAttestation } from "./audience-floor.js";
import { governanceRedirectTarget, PaneRedirectError } from "./pane-venue.js";

const ORG_ROLE = "admin";
const DOMAIN_ROLE_PREFIX = "domain:";

export type AdminReadVenue =
  | { readonly placement: "org-wide"; readonly via: "governance-channel" | "requester-dm"; readonly roles: readonly string[] }
  | { readonly placement: "domain-scoped"; readonly domain: string; readonly roles: readonly string[] }
  | { readonly placement: "redirect"; readonly target: "governance-channel" | "requester-dm"; readonly channel?: string };

export interface AdminReadVenueInput {
  readonly roles: readonly string[];
  readonly isRequesterDm: boolean;
  readonly isGovernanceChannel: boolean;
  readonly attestation?: FloorAttestation;
  readonly roomDomain?: string;
  readonly governanceChannel?: string;
}

export function classifyAdminReadVenue(input: AdminReadVenueInput): AdminReadVenue {
  if (input.isGovernanceChannel && input.attestation?.armed) {
    return { placement: "org-wide", via: "governance-channel", roles: input.roles };
  }
  if (input.isRequesterDm) {
    return { placement: "org-wide", via: "requester-dm", roles: input.roles };
  }
  const room = input.roomDomain;
  if (room !== undefined && room.length > 0) {
    const covers = input.roles.includes(ORG_ROLE) || input.roles.includes(`${DOMAIN_ROLE_PREFIX}${room}`);
    if (covers) return { placement: "domain-scoped", domain: room, roles: [`${DOMAIN_ROLE_PREFIX}${room}`] };
  }
  if (input.governanceChannel) return { placement: "redirect", target: "governance-channel", channel: input.governanceChannel };
  return { placement: "redirect", target: "requester-dm" };
}

function adminReadRedirectDirective(target: "governance-channel" | "requester-dm", channel: string | undefined, kind: string): string {
  const where =
    target === "governance-channel"
      ? `Ask again in the governance channel ${channel}, or in a DM with me`
      : "Ask again in a DM with me (or configure a governance domain to give the whole admin team a shared venue)";
  return (
    `that's org-wide admin memory output (${kind}) — a map of memory beyond this room's own domain — so it can't be answered here, ` +
    `whatever standing you hold. ${where}. Reply here only with that pointer, and render NONE of the substance in this channel ` +
    `(partial disclosure is still disclosure).`
  );
}

function adminReadNarrowedNote(domain: string, target: "governance-channel" | "requester-dm", channel: string | undefined): string {
  const where = target === "governance-channel" ? `the governance channel ${channel}` : "a DM with me";
  return (
    `Narrowed to this room's own domain ("${domain}") — this is NOT the org-wide view, and other domains' silos are omitted. ` +
    `Say so when you answer, and point at ${where} for the org-wide map.`
  );
}

interface AdminReadVenueResolution {
  readonly decision: AdminReadVenue;
  readonly channelKey: string;
  readonly principalId?: string;
  readonly coords: { org: string; platform: string; workspace: string; surface: string; surfaceMode?: SessionMode };
  readonly governanceChannel?: string;
}

async function resolveAdminReadVenue(
  ctx: BindableContext,
  input: { readonly roles: readonly string[]; readonly principalId?: string },
): Promise<AdminReadVenueResolution> {
  const domains = getConfig().loadDomains();
  const b = bindFrom(ctx);
  const part = resolvePartition(ctx);
  const coords = { org: part.org, platform: part.platform, workspace: part.workspace, surface: part.surface, ...auditSurfaceModeStamp(b) };

  const isGov = isGovernanceChannel(part.surfaceKey, domains);
  const attestation = isGov ? await attestGovernanceChannel(part.surfaceKey, domains, { ...coords, principalId: b.principalId }) : undefined;
  const roomDomain = domainForChannel(domainKeyOf(part), domains)?.name;
  const governanceChannel = governanceRedirectTarget(domains);

  const decision = classifyAdminReadVenue({
    roles: input.roles,
    isRequesterDm: b.mode === "dm",
    isGovernanceChannel: isGov,
    attestation,
    roomDomain,
    governanceChannel,
  });
  return { decision, channelKey: part.surfaceKey, principalId: input.principalId, coords, governanceChannel };
}

export async function requireAdminReadVenue(
  ctx: BindableContext,
  input: { readonly roles: readonly string[]; readonly principalId?: string; readonly kind: string },
): Promise<{ readonly roles: readonly string[]; readonly decision: AdminReadVenue; readonly note?: string }> {
  const r = await resolveAdminReadVenue(ctx, input);
  const decision = r.decision;
  if (decision.placement === "redirect") {
    await auditAdminReadVenue(r, input.kind);
    throw new PaneRedirectError(adminReadRedirectDirective(decision.target, decision.channel, input.kind), decision.target, decision.channel);
  }
  if (decision.placement === "domain-scoped") {
    await auditAdminReadVenue(r, input.kind);
    const target: "governance-channel" | "requester-dm" = r.governanceChannel ? "governance-channel" : "requester-dm";
    return { roles: decision.roles, decision, note: adminReadNarrowedNote(decision.domain, target, r.governanceChannel) };
  }
  return { roles: decision.roles, decision };
}

async function auditAdminReadVenue(r: AdminReadVenueResolution, kind: string): Promise<void> {
  const decision = r.decision;
  if (decision.placement === "domain-scoped") {
    await appendAudit({
      ...r.coords,
      principalId: r.principalId,
      action: "governance.narrowed",
      detail: { kind, from: r.channelKey, domain: decision.domain, roles: decision.roles },
    });
    return;
  }
  if (decision.placement !== "redirect") return;
  await appendAudit({
    ...r.coords,
    principalId: r.principalId,
    action: "governance.redirected",
    detail: { kind, from: r.channelKey, to: decision.target, ...(decision.channel ? { channel: decision.channel } : {}) },
  });
}
