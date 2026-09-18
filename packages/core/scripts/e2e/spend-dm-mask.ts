import { adminControlRoles } from "../../agent/access/roles.js";
import { dmBucketKey } from "../../agent/spend/dm-mask.js";
import type { Domain } from "../../agent/memory/domain.js";
import { loadDomains } from "../../../../agent/memory/config/domains.js";

export interface SlackFixtureIdentity {
  readonly userId: string;
  readonly teamId: string;
}

export type SpendReportReaderPreflight =
  | { readonly ok: true; readonly principalKey: string }
  | { readonly ok: false; readonly reason: string };

export function spendReportReaderPreflight(input: {
  readonly reader: SlackFixtureIdentity;
  readonly domains: readonly Domain[];
}): SpendReportReaderPreflight {
  const { userId, teamId } = input.reader;
  if (!userId.trim() || !teamId.trim()) {
    return { ok: false, reason: "the Slack driver token did not resolve a complete user/workspace identity, so no roster can admit it" };
  }
  const principalKey = `slack/${teamId}/${userId}`;
  const roles = adminControlRoles(userId, input.domains, "slack", teamId);
  if (!roles.includes("admin")) {
    return {
      ok: false,
      reason:
        `the Slack driver identity ${principalKey} holds no ORG-admin standing (roles: ${roles.length ? roles.join(", ") : "none"}), and only ` +
        `scope:"org" renders DM spend — spend_report's domain arm drops every kind:"dm" row. Add that qualified principal key to the "org" ` +
        'pseudo-domain\'s `admins` (agent/memory/config/domains/org.ts) to make this leg assert the masked bucket.',
    };
  }
  return { ok: true, principalKey };
}

export function deployedSpendReportReaderPreflight(input: { readonly reader: SlackFixtureIdentity }): SpendReportReaderPreflight {
  return spendReportReaderPreflight({ ...input, domains: loadDomains() });
}

export interface UsageRowLike {
  readonly surfaceKey: string;
  readonly calls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface DmSpendPresence {
  readonly present: boolean;
  readonly calls: number;
  readonly tokens: number;
}

export function dmSpendPresence(rows: readonly UsageRowLike[], dmSurfaceKey: string): DmSpendPresence {
  const mine = rows.filter((r) => r.surfaceKey === dmSurfaceKey);
  const calls = mine.reduce((sum, r) => sum + r.calls, 0);
  const tokens = mine.reduce((sum, r) => sum + r.inputTokens + r.outputTokens, 0);
  return { present: mine.length > 0 && calls > 0, calls, tokens };
}

export interface SpendMaskVerdict {
  readonly leaks: readonly string[];
  readonly bucket: boolean;
  readonly bareBucketOnly: boolean;
}

export function spendMaskVerdict(reply: string, input: { readonly dmChannelId: string; readonly dmSurfaceKey: string }): SpendMaskVerdict {
  const leaks = [input.dmChannelId, input.dmSurfaceKey].filter((needle) => needle.length > 0 && reply.includes(needle));
  const bucket = reply.includes(dmBucketKey(input.dmSurfaceKey));
  return { leaks: [...new Set(leaks)], bucket, bareBucketOnly: !bucket && reply.includes("(dms)") };
}

export function spendMaskVerdictOver(replies: readonly string[], input: { readonly dmChannelId: string; readonly dmSurfaceKey: string }): SpendMaskVerdict {
  const each = replies.map((reply) => spendMaskVerdict(reply, input));
  const bucket = each.some((v) => v.bucket);
  return {
    leaks: [...new Set(each.flatMap((v) => v.leaks))],
    bucket,
    bareBucketOnly: !bucket && each.some((v) => v.bareBucketOnly),
  };
}
