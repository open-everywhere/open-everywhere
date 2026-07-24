import { appendAudit } from "../audit/audit.js";
import { bindFrom, type BindableContext } from "../identity/binding.js";
import { resolvePartition } from "../memory/partition.js";
import { getConfig } from "./config.js";
import { governanceChannelFor, governanceDomains, isGovernanceChannel, type Domain } from "../memory/domain.js";
import { attestGovernanceChannel, floorBreachNotice, type FloorAttestation } from "./audience-floor.js";

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
  const domains = getConfig().loadDomains();
  if (governanceDomains(domains).length === 0) {
    return { placement: "inline", via: "requester-dm" };
  }

  const b = bindFrom(ctx);
  const part = resolvePartition(ctx);
  const channelKey = part.surfaceKey;
  const isDm = b.mode === "dm";
  const isGov = isGovernanceChannel(channelKey, domains);

  let attestation: FloorAttestation | undefined;
  if (isGov) {
    attestation = await attestGovernanceChannel(channelKey, domains, {
      org: part.org,
      platform: part.platform,
      workspace: part.workspace,
      surface: part.surface,
      principalId: b.principalId,
    });
  }

  const decision = classifyPaneVenue({
    isRequesterDm: isDm,
    isGovernanceChannel: isGov,
    attestation,
    governanceChannel: governanceChannelFor(domains, adminChannelFallback()),
  });

  if (decision.placement === "inline") return decision;

  await appendAudit({
    org: part.org,
    platform: part.platform,
    workspace: part.workspace,
    surface: part.surface,
    principalId: b.principalId,
    action: "governance.redirected",
    detail: {
      kind: opts.kind,
      from: channelKey,
      to: decision.target,
      ...(decision.channel ? { channel: decision.channel } : {}),
      ...(isGov && attestation?.breach ? { floorBreach: attestation.breach.reason } : {}),
    },
  });

  const notice = isGov && attestation?.breach ? ` (${floorBreachNotice(attestation.breach)})` : "";
  throw new PaneRedirectError(redirectDirective(decision.target, decision.channel, opts.kind) + notice, decision.target, decision.channel);
}

function adminChannelFallback(): string | undefined {
  const load = getConfig().loadAccessRequests;
  return load?.()?.adminChannel ?? undefined;
}

export function governanceRedirectTarget(domains: readonly Domain[]): string | undefined {
  return governanceChannelFor(domains, adminChannelFallback());
}
