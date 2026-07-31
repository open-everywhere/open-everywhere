import { appendAudit } from "../audit/audit.js";
import { actingPrincipalId, bindFrom, type BindableContext } from "../identity/binding.js";
import { resolvePartition } from "../memory/partition.js";
import { getConfig } from "./config.js";
import { governanceChannelFor, governanceDeliveryMode, governanceDomains, isGovernanceChannel, type Domain } from "../memory/domain.js";
import { attestGovernanceChannel, floorBreachNotice, type FloorAttestation } from "./audience-floor.js";
import { adminControlRoles } from "./roles.js";
import { canDeliverDirectMessage, directMessageCapablePlatforms, dispatchDirectMessage } from "../channels/post-arms.js";

export type PaneVenue =
  | { readonly placement: "inline"; readonly via: "governance-channel" }
  | { readonly placement: "inline"; readonly via: "requester-dm" }
  | {
      readonly placement: "redirect";
      readonly target: "governance-channel" | "requester-dm";
      readonly channel?: string;
    };

export interface PaneVenueInput {
  readonly isRequesterDm: boolean;
  readonly isGovernanceChannel: boolean;
  readonly attestation?: FloorAttestation;
  readonly governanceChannel?: string;
}

export function classifyPaneVenue(input: PaneVenueInput): PaneVenue {
  if (input.isGovernanceChannel && input.attestation?.armed) {
    return { placement: "inline", via: "governance-channel" };
  }
  if (input.isRequesterDm) {
    return { placement: "inline", via: "requester-dm" };
  }
  if (input.governanceChannel) {
    return { placement: "redirect", target: "governance-channel", channel: input.governanceChannel };
  }
  return { placement: "redirect", target: "requester-dm" };
}

export class PaneRedirectError extends Error {
  readonly target: "governance-channel" | "requester-dm";
  readonly channel?: string;
  constructor(message: string, target: "governance-channel" | "requester-dm", channel?: string) {
    super(message);
    this.name = "PaneRedirectError";
    this.target = target;
    this.channel = channel;
  }
}

function redirectDirective(target: "governance-channel" | "requester-dm", channel: string | undefined, kind: string): string {
  if (target === "governance-channel") {
    return (
      `that's admin-pane output (${kind}) — it can't be shown in this room. Deliver the full answer in the governance channel ${channel} (mention the person who asked), ` +
      `and reply here only with a pointer: "that's admin-pane output — I've posted it in ${channel}." Do NOT render any of the substance in this channel (partial disclosure is still disclosure).`
    );
  }
  return (
    `that's admin-pane output (${kind}) — it can't be shown in this room, and no governance channel is configured. Deliver it view-only in the requester's DM instead, ` +
    `and reply here only with a pointer ("I've sent it to you directly"). Do NOT render the substance in this channel. (Configure a governance domain to give the whole admin team a shared venue.)`
  );
}

export async function requirePaneVenue(ctx: BindableContext, opts: { kind: string }): Promise<PaneVenue> {
  const r = await resolvePaneVenue(ctx);
  if (r.decision.placement === "inline") return r.decision;
  await auditRedirect(r, opts.kind);
  throw redirectError(r, opts.kind);
}

interface VenueResolution {
  readonly decision: PaneVenue;
  readonly domains: readonly Domain[];
  readonly channelKey: string;
  readonly principalId?: string;
  readonly isGovernanceChannel: boolean;
  readonly attestation?: FloorAttestation;
  readonly coords: { org: string; platform: string; workspace: string; surface: string };
}

async function resolvePaneVenue(ctx: BindableContext): Promise<VenueResolution> {
  const domains = getConfig().loadDomains();
  const b = bindFrom(ctx);
  const part = resolvePartition(ctx);
  const coords = { org: part.org, platform: part.platform, workspace: part.workspace, surface: part.surface };
  const base = { domains, channelKey: part.surfaceKey, principalId: actingPrincipalId(b), coords };

  const dmFallback = governanceDeliveryMode(domains) === "dm-fallback";
  if (governanceDomains(domains).length === 0 && !dmFallback) {
    return { ...base, decision: { placement: "inline", via: "requester-dm" }, isGovernanceChannel: false };
  }

  const isGov = isGovernanceChannel(part.surfaceKey, domains);
  const attestation = isGov ? await attestGovernanceChannel(part.surfaceKey, domains, { ...coords, principalId: b.principalId }) : undefined;

  const decision = classifyPaneVenue({
    isRequesterDm: b.mode === "dm",
    isGovernanceChannel: isGov,
    attestation,
    governanceChannel: governanceChannelFor(domains, adminChannelFallback()),
  });
  return { ...base, decision, isGovernanceChannel: isGov, attestation };
}

async function auditRedirect(r: VenueResolution, kind: string, refused?: string): Promise<void> {
  const decision = r.decision;
  await appendAudit({
    ...r.coords,
    principalId: r.principalId,
    action: "governance.redirected",
    detail: {
      kind,
      from: r.channelKey,
      to: decision.placement === "redirect" ? decision.target : "inline",
      ...(decision.placement === "redirect" && decision.channel ? { channel: decision.channel } : {}),
      ...(r.isGovernanceChannel && r.attestation?.breach ? { floorBreach: r.attestation.breach.reason } : {}),
      ...(refused ? { refused } : {}),
    },
  });
}

function redirectError(r: VenueResolution, kind: string, refused?: string): PaneRedirectError {
  const decision = r.decision;
  if (decision.placement !== "redirect") throw new Error("redirectError called on a non-redirect venue");
  const notice = r.isGovernanceChannel && r.attestation?.breach ? ` (${floorBreachNotice(r.attestation.breach)})` : "";
  const why = refused ? ` I couldn't deliver it to your DM either: ${refused}` : "";
  return new PaneRedirectError(redirectDirective(decision.target, decision.channel, kind) + notice + why, decision.target, decision.channel);
}

export class PaneDmDeliveredError extends Error {
  readonly dmSurfaceId: string;
  constructor(message: string, dmSurfaceId: string) {
    super(message);
    this.name = "PaneDmDeliveredError";
    this.dmSurfaceId = dmSurfaceId;
  }
}

export async function fulfilPaneRead<T>(
  ctx: BindableContext,
  opts: { kind: string; render: (value: T) => string },
  compute: () => Promise<T>,
): Promise<T> {
  const r = await resolvePaneVenue(ctx);
  const decision = r.decision;
  if (decision.placement === "inline") return await compute();

  if (decision.target === "governance-channel") {
    await auditRedirect(r, opts.kind);
    throw redirectError(r, opts.kind);
  }

  const roles = adminControlRoles(r.principalId, r.domains);
  if (roles.length === 0) {
    const why = r.principalId
      ? `your id ("${r.principalId}") holds no admin standing in any configured domain`
      : "this turn carries no verified sender id";
    await auditRedirect(r, opts.kind, "role-unverified");
    throw redirectError(r, opts.kind, why);
  }
  if (!canDeliverDirectMessage(r.coords.platform)) {
    const capable = directMessageCapablePlatforms();
    await auditRedirect(r, opts.kind, "no-dm-arm");
    throw redirectError(r, opts.kind, `this deployment can't DM on "${r.coords.platform}" (DM delivery is implemented by: ${capable.length ? capable.join(", ") : "no provider"})`);
  }

  const value = await compute();
  let delivery: { surfaceId: string; messageId: string };
  try {
    delivery = await dispatchDirectMessage(r.coords.platform, {
      principalId: r.principalId!,
      text: dmEnvelope(opts.kind, r.channelKey, opts.render(value)),
    });
  } catch (err) {
    await auditRedirect(r, opts.kind, "dm-delivery-failed");
    throw redirectError(r, opts.kind, String(err instanceof Error ? err.message : err));
  }

  await appendAudit({
    ...r.coords,
    principalId: r.principalId,
    action: "governance.dm_delivered",
    detail: { kind: opts.kind, from: r.channelKey, to: "requester-dm", dmSurface: delivery.surfaceId, roles },
  });

  throw new PaneDmDeliveredError(
    `that's admin-pane output (${opts.kind}) — it can't be shown in this room, so I've DELIVERED IT to the person who asked, in their DM with me. ` +
      `Reply here with ONLY a short pointer ("I've sent you a DM") — you do not have the content and must not restate, summarise, estimate or hint at any of it. ` +
      `(Configure a governance domain to give the whole admin team a shared venue instead.)`,
    delivery.surfaceId,
  );
}

function dmEnvelope(kind: string, askedIn: string, body: string): string {
  return `Admin-pane output (${kind}) — you asked in ${askedIn}, which isn't a venue that may hear org-scope output, so here it is view-only.\n\n${body}`;
}

function adminChannelFallback(): string | undefined {
  const load = getConfig().loadAccessRequests;
  return load?.()?.adminChannel ?? undefined;
}

export function governanceRedirectTarget(domains: readonly Domain[]): string | undefined {
  return governanceChannelFor(domains, adminChannelFallback());
}
