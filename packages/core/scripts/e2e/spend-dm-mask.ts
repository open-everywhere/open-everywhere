import { adminControlRoles } from "../../agent/access/roles.js";
import { dmBucketKey } from "../../agent/spend/dm-mask.js";
import { renderFriendlyText } from "../../agent/channels/friendly-ids.js";
import type { Domain } from "../../agent/memory/domain.js";
import { loadAppDomains } from "./app-config.js";

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

export async function deployedSpendReportReaderPreflight(input: { readonly reader: SlackFixtureIdentity }): Promise<SpendReportReaderPreflight> {
  return spendReportReaderPreflight({ ...input, domains: await loadAppDomains() });
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

export interface SpendMaskKeys {
  readonly dmChannelId: string;
  readonly dmSurfaceKey: string;
  readonly workspaceNames?: readonly string[];
}

export function spendMaskVerdict(reply: string, input: SpendMaskKeys): SpendMaskVerdict {
  const literal = [input.dmChannelId, input.dmSurfaceKey].filter((needle) => needle.length > 0 && reply.includes(needle));
  const [platform = "", workspace = ""] = input.dmSurfaceKey.split("/");
  const friendlyDm = input.dmSurfaceKey.length > 0 ? renderFriendlyText(input.dmSurfaceKey, { platform }) : "";
  const friendlyLines =
    friendlyDm.length > 0 && friendlyDm !== input.dmSurfaceKey ? reply.split("\n").filter((line) => line.includes(friendlyDm)).map((line) => line.trim()) : [];
  const rawBucket = dmBucketKey(input.dmSurfaceKey);
  const named = (input.workspaceNames ?? []).filter((name) => name.trim().length > 0 && workspace.length > 0);
  const renderings = [
    renderFriendlyText(rawBucket, { platform }),
    ...named.map((name) => renderFriendlyText(rawBucket, { platform, names: new Map([[workspace, { label: name.trim(), kind: "server" as const }]]) })),
  ];
  const bucket = reply.includes(rawBucket) || renderings.some((rendered) => rendered !== rawBucket && reply.includes(rendered));
  return { leaks: [...new Set([...literal, ...friendlyLines])], bucket, bareBucketOnly: !bucket && reply.includes("(dms)") };
}

export function spendMaskVerdictOver(replies: readonly string[], input: SpendMaskKeys): SpendMaskVerdict {
  const each = replies.map((reply) => spendMaskVerdict(reply, input));
  const bucket = each.some((v) => v.bucket);
  return {
    leaks: [...new Set(each.flatMap((v) => v.leaks))],
    bucket,
    bareBucketOnly: !bucket && each.some((v) => v.bareBucketOnly),
  };
}
