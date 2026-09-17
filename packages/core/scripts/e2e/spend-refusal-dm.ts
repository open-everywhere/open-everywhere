import { adminControlRoles } from "../../agent/access/roles.js";
import { domainForChannel, type Domain } from "../../agent/memory/domain.js";
import { rosterStanding } from "../../agent/spend/bypass.js";
import { loadDomains } from "../../../../agent/memory/config/domains.js";

export interface SlackFixtureIdentity {
  readonly userId: string;
  readonly teamId: string;
}

export type SpendRefusalDmPreflight =
  | { readonly ok: true; readonly surfaceKey: string }
  | { readonly ok: false; readonly reason: string };

export function spendRefusalDmPreflight(input: {
  readonly primary: SlackFixtureIdentity;
  readonly secondary: SlackFixtureIdentity;
  readonly expectedSecondaryUserId: string;
  readonly dmChannelId: string;
  readonly domains: readonly Domain[];
}): SpendRefusalDmPreflight {
  if (!input.primary.userId.trim() || !input.primary.teamId.trim()) {
    return { ok: false, reason: "the primary Slack token did not resolve a complete user/workspace identity" };
  }
  if (!input.secondary.userId.trim() || !input.secondary.teamId.trim()) {
    return { ok: false, reason: "the secondary Slack token did not resolve a complete user/workspace identity" };
  }
  const expected = input.expectedSecondaryUserId.trim();
  if (!expected || input.secondary.userId !== expected) {
    return {
      ok: false,
      reason: `the secondary token resolved to ${input.secondary.userId || "(no user)"}, not the declared secondary user ${expected || "(missing)"}`,
    };
  }
  if (input.secondary.userId === input.primary.userId) {
    return { ok: false, reason: "the secondary token resolves to the primary driver user, so it is not a second identity" };
  }
  if (input.secondary.teamId !== input.primary.teamId) {
    return {
      ok: false,
      reason: `the secondary token belongs to Slack workspace ${input.secondary.teamId}, not the primary fixture workspace ${input.primary.teamId}`,
    };
  }
  if (!/^D[A-Z0-9]+$/u.test(input.dmChannelId)) {
    return { ok: false, reason: `conversations.open returned ${input.dmChannelId || "(no channel)"}, which is not a Slack DM id` };
  }
  const surfaceKey = `slack/${input.secondary.teamId}/${input.dmChannelId}`;
  const roles = adminControlRoles(input.secondary.userId, input.domains, "slack", input.secondary.teamId);
  const coveringDomain = domainForChannel(surfaceKey, input.domains)?.name ?? null;
  if (rosterStanding(roles, coveringDomain)) {
    return {
      ok: false,
      reason: `the secondary user has tracked admin standing over ${surfaceKey}; an admin bypasses spend caps`,
    };
  }
  return { ok: true, surfaceKey };
}

export function deployedSpendRefusalDmPreflight(input: Omit<Parameters<typeof spendRefusalDmPreflight>[0], "domains">): SpendRefusalDmPreflight {
  return spendRefusalDmPreflight({
    ...input,
    domains: loadDomains(),
  });
}
