import { placeWords } from "../channels/friendly-ids.js";
import { domainForChannel, domainRoster, type Domain } from "../memory/domain.js";
import { domainKeyOf, type Partition } from "../memory/partition.js";
import type { SurfaceBinding } from "../identity/binding.js";
import { postedToSurfaceKey, type PriorRejection } from "./flow.js";
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
  for (const ch of domainRoster(domain)) {
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

export function describeVenueRefusal(refusal: ApprovalVenueRefusal, platform: string, action = "set that up"): string {
  if (refusal.reason === "no-domain") {
    return (
      `I can't ${action} from here: "${platform}" has no approval-card path, and this channel isn't in an explicit domain, so there's nowhere in-domain to put the card a human has to click. ` +
      `Add this channel to a domain (agent/memory/config/domains/<name>.ts) that also contains a Slack, Discord or Teams channel, or ask me in one of those channels.`
    );
  }
  if (refusal.reason === "no-internal-card-channel") {
    return (
      `I can't ${action} from here: "${platform}" has no approval-card path, so the card has to go to a Slack, Discord or Teams channel in domain "${refusal.domain}" — and every one of those is shared outside your org (or has an observed guest), so an approval card there would spell out exactly what would execute to people outside it. ` +
      `Add an internal Slack, Discord or Teams channel to "${refusal.domain}".reach (agent/memory/config/domains/<name>.ts), or stop sharing the one that's there, and I'll use it.`
    );
  }
  return (
    `I can't ${action} from here: "${platform}" has no approval-card path, and domain "${refusal.domain}" has no Slack, Discord or Teams channel to put the card in. ` +
    `Add one to "${refusal.domain}".reach (agent/memory/config/domains/<name>.ts), or ask me from a Slack, Discord or Teams channel.`
  );
}

export function cardPostedPrefix(venue: ApprovalVenue): string {
  return venue.sameRoom ? "card posted" : `card posted in ${placeWords({ key: venue.surfaceKey })}`;
}

export function describeVenueRedirect(venue: ApprovalVenue, whatNext: string): string {
  if (venue.sameRoom) return "";
  return ` This surface can't host an approval card, so it went to the card-capable channel in this domain — tell the user where it is, by name, and that someone there has to ${whatNext}.`;
}

export const PROPOSER_DECISION_NOTE =
  " The card is with the approvers. Their decision goes to the owning conversation session, not to this call. " +
  "Do not call again for the same change: a repeat while the card is undecided returns this same pending id. Report the pending id and finish.";

export function describePriorRejection(prior: PriorRejection): string {
  return (
    ` The same proposal was REJECTED by ${prior.decidedBy} at ${prior.decidedAt}. This card stands only if a person asked again. ` +
    `If you are retrying on your own, stop and report the rejection.`
  );
}

export function proposerTail(posted: { readonly priorRejection?: PriorRejection }): string {
  return PROPOSER_DECISION_NOTE + (posted.priorRejection !== undefined ? describePriorRejection(posted.priorRejection) : "");
}

export function cardPostedTail(venue: ApprovalVenue, whatNext: string, posted: { readonly priorRejection?: PriorRejection }): string {
  return describeVenueRedirect(venue, whatNext) + proposerTail(posted);
}
