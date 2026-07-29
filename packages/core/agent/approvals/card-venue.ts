import { domainForChannel, type Domain } from "../memory/domain.js";
import { domainKeyOf, type Partition } from "../memory/partition.js";
import type { SurfaceBinding } from "../identity/binding.js";
import { postedToSurfaceKey } from "./flow.js";
import { checkCardDisclosure, type CardDisclosureDeps } from "./card-disclosure.js";
import { hasApprovalCardPath } from "../tools/set_spend_limit.js";

export interface ApprovalVenue {
  readonly platform: string;
  readonly channelId: string;
  readonly surfaceKey: string;
  readonly sameRoom: boolean;
}

export interface ApprovalVenueRefusal {
  readonly reason:
    | "no-domain"
    | "no-card-channel"
    | "no-internal-card-channel";
  readonly domain?: string;
}

export type ApprovalVenueResult = { readonly venue: ApprovalVenue } | { readonly refusal: ApprovalVenueRefusal };

export function approvalVenueFor(
  binding: SurfaceBinding,
  partition: Partition,
  loadDomains: () => readonly Domain[],
): ApprovalVenueResult {
  const own = ownRoomVenue(binding);
  if (own) return { venue: own };
  const candidates = inDomainVenues(partition, loadDomains);
  if ("refusal" in candidates) return candidates;
  const first = candidates.venues[0];
  return first ? { venue: first } : { refusal: { reason: "no-card-channel", domain: candidates.domain } };
}

function ownRoomVenue(binding: SurfaceBinding): ApprovalVenue | undefined {
  const ownChannelId = typeof binding.target?.["channelId"] === "string" ? (binding.target["channelId"] as string) : undefined;
  if (!hasApprovalCardPath(binding.platform) || !ownChannelId) return undefined;
  return { platform: binding.platform, channelId: ownChannelId, surfaceKey: postedToSurfaceKey(binding, ownChannelId), sameRoom: true };
}

function inDomainVenues(
  partition: Partition,
  loadDomains: () => readonly Domain[],
): { readonly venues: readonly ApprovalVenue[]; readonly domain: string } | { readonly refusal: ApprovalVenueRefusal } {
  const domain = domainForChannel(domainKeyOf(partition), loadDomains());
  if (!domain) return { refusal: { reason: "no-domain" } };
  const venues: ApprovalVenue[] = [];
  for (const ch of domain.channels ?? []) {
    const segs = ch.split("/");
    if (segs.length !== 3) continue;
    const platform = segs[0] as string;
    const channelId = segs[2] as string;
    if (channelId.length === 0 || !hasApprovalCardPath(platform)) continue;
    venues.push({ platform, channelId, surfaceKey: ch, sameRoom: false });
  }
  return { venues, domain: domain.name };
}

export async function checkApprovalVenue(
  binding: SurfaceBinding,
  partition: Partition,
  loadDomains: () => readonly Domain[],
  deps: CardDisclosureDeps = {},
): Promise<ApprovalVenueResult> {
  const own = ownRoomVenue(binding);
  if (own) return { venue: own };
  const candidates = inDomainVenues(partition, loadDomains);
  if ("refusal" in candidates) return candidates;
  for (const venue of candidates.venues) {
    if ((await checkCardDisclosure(venue.surfaceKey, deps)).ok) return { venue };
  }
  return {
    refusal: { reason: candidates.venues.length === 0 ? "no-card-channel" : "no-internal-card-channel", domain: candidates.domain },
  };
}

export function describeVenueRefusal(refusal: ApprovalVenueRefusal, platform: string): string {
  if (refusal.reason === "no-domain") {
    return (
      `I can't set that up from here: "${platform}" has no approval-card path, and this channel isn't in an explicit domain, so there's nowhere in-domain to put the card a human has to click. ` +
      `Add this channel to a domain (agent/config/domains.ts) that also contains a Slack or Discord channel, or ask me in one of those channels.`
    );
  }
  if (refusal.reason === "no-internal-card-channel") {
    return (
      `I can't set that up from here: "${platform}" has no approval-card path, so the card has to go to a Slack or Discord channel in domain "${refusal.domain}" — and every one of those is shared outside your org (or has an observed guest), so an approval card there would spell out exactly what would execute to people outside it. ` +
      `Add an internal Slack or Discord channel to "${refusal.domain}".channels (agent/config/domains.ts), or stop sharing the one that's there, and I'll use it.`
    );
  }
  return (
    `I can't set that up from here: "${platform}" has no approval-card path, and domain "${refusal.domain}" has no Slack or Discord channel to put the card in. ` +
    `Add one to "${refusal.domain}".channels (agent/config/domains.ts), or ask me from a Slack or Discord channel.`
  );
}
