import { domainForChannel, type Domain } from "../memory/domain.js";
import { domainKeyOf, type Partition } from "../memory/partition.js";
import type { SurfaceBinding } from "../identity/binding.js";
import { postedToSurfaceKey } from "./flow.js";
import { hasApprovalCardPath } from "../tools/set_spend_limit.js";

export interface ApprovalVenue {
  readonly platform: string;
  readonly channelId: string;
  readonly surfaceKey: string;
  readonly sameRoom: boolean;
}

export interface ApprovalVenueRefusal {
  readonly reason: "no-domain" | "no-card-channel";
  readonly domain?: string;
}

export type ApprovalVenueResult = { readonly venue: ApprovalVenue } | { readonly refusal: ApprovalVenueRefusal };

export function approvalVenueFor(
  binding: SurfaceBinding,
  partition: Partition,
  loadDomains: () => readonly Domain[],
): ApprovalVenueResult {
  const ownChannelId = typeof binding.target?.["channelId"] === "string" ? (binding.target["channelId"] as string) : undefined;
  if (hasApprovalCardPath(binding.platform) && ownChannelId) {
    return { venue: { platform: binding.platform, channelId: ownChannelId, surfaceKey: postedToSurfaceKey(binding, ownChannelId), sameRoom: true } };
  }
  const domain = domainForChannel(domainKeyOf(partition), loadDomains());
  if (!domain) return { refusal: { reason: "no-domain" } };
  for (const ch of domain.channels ?? []) {
    const segs = ch.split("/");
    if (segs.length !== 3) continue;
    const platform = segs[0] as string;
    const channelId = segs[2] as string;
    if (channelId.length === 0 || !hasApprovalCardPath(platform)) continue;
    return { venue: { platform, channelId, surfaceKey: ch, sameRoom: false } };
  }
  return { refusal: { reason: "no-card-channel", domain: domain.name } };
}

export function describeVenueRefusal(refusal: ApprovalVenueRefusal, platform: string): string {
  if (refusal.reason === "no-domain") {
    return (
      `I can't set that up from here: "${platform}" has no approval-card path, and this channel isn't in an explicit domain, so there's nowhere in-domain to put the card a human has to click. ` +
      `Add this channel to a domain (agent/config/domains.ts) that also contains a Slack or Discord channel, or ask me in one of those channels.`
    );
  }
  return (
    `I can't set that up from here: "${platform}" has no approval-card path, and domain "${refusal.domain}" has no Slack or Discord channel to put the card in. ` +
    `Add one to "${refusal.domain}".channels (agent/config/domains.ts), or ask me from a Slack or Discord channel.`
  );
}
