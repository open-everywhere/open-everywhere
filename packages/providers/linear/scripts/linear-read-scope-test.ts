
import assert from "node:assert/strict";
import {
  assertLinearIssueAllowed,
  currentTurnIssueRefs,
  linearReadScope,
  linearScopeRefusal,
} from "../agent/channels/linear-scope.js";
import { ChannelScopeError, defineDomain, registerConfig, type BindableContext, type Domain } from "@open-everywhere/core/agent/adapter-api.js";
import { registerLinearProvider } from "../agent/register.js";
import { readLinearIssueEntry } from "../agent/tools/read_linear_issue.js";

registerLinearProvider();

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

const ORG = "org-1";
const TEAM_PAY = "team-pay-1111";
const TEAM_ENG = "team-eng-2222";
const TEAM_LOOSE = "team-loose-3333";
const ORG2 = "org-2";
const TEAM_WIDE = "team-wide-4444";

const DOMAINS: readonly Domain[] = [
  defineDomain({ name: "payments", channels: [`linear/${ORG}/${TEAM_PAY}`] }),
  defineDomain({ name: "eng", channels: [`linear/${ORG}/${TEAM_ENG}`] }),
  defineDomain({ name: "wide", containers: [`linear/${ORG2}`] }),
];

const keyFor = (org: string, surface: string): string => `linear/${org}/${surface}`;

const ISSUE_OWN = "11111111-1111-4111-8111-111111111111";
const ISSUE_OWN_IDENT = "PAY-1";
const ISSUE_SIBLING = "22222222-2222-4222-8222-222222222222";
const ISSUE_ENG = "33333333-3333-4333-8333-333333333333";
const ISSUE_LOOSE = "44444444-4444-4444-8444-444444444444";
const ISSUE_GHOST = "55555555-5555-4555-8555-555555555555";

const TEAM_OF: Record<string, string> = {
  [ISSUE_OWN]: TEAM_PAY,
  [ISSUE_SIBLING]: TEAM_PAY,
  [ISSUE_ENG]: TEAM_ENG,
  [ISSUE_LOOSE]: TEAM_LOOSE,
};

{
  const fromPay = (target: string, team = TEAM_OF[target]) =>
    linearReadScope(keyFor(ORG, TEAM_PAY), [ISSUE_OWN, ISSUE_OWN_IDENT], target, team, DOMAINS);

  const own = fromPay(ISSUE_OWN);
  ok(own.allowed && own.reason === "own-issue", "the session's OWN issue is always readable");
  ok(fromPay(ISSUE_OWN_IDENT, undefined).allowed, "…named by its human identifier too, with NO team resolved");
  ok(linearReadScope(keyFor(ORG, TEAM_PAY), [ISSUE_OWN], "pay-1".toUpperCase(), undefined, DOMAINS).reason !== "own-issue", "…and a DIFFERENT ref is not the own issue");

  const sibling = fromPay(ISSUE_SIBLING);
  ok(sibling.allowed && sibling.reason === "roster", "a SIBLING issue on the same rostered team is readable");
  ok(sibling.targetTeam === TEAM_PAY, "…and the verdict names the team it resolved to");

  const cross = fromPay(ISSUE_ENG);
  ok(!cross.allowed && cross.reason === "cross-domain", "an issue on ANOTHER domain's team is REFUSED");
  ok(cross.callerDomain === "payments" && cross.targetDomain === "eng", "…and the verdict names both domains, so the audit row is actionable");

  const ghost = fromPay(ISSUE_GHOST, undefined);
  ok(!ghost.allowed && ghost.reason === "target-unresolvable", "an issue whose TEAM cannot be established is REFUSED ('we can't tell' is never 'yes')");

  const loose = fromPay(ISSUE_LOOSE);
  ok(!loose.allowed && loose.reason === "target-unassigned", "an issue on a team in NO domain is REFUSED");
  ok(loose.targetTeam === TEAM_LOOSE && loose.targetDomain === undefined, "…and the row records the team but no target domain");

  const fromLoose = (target: string) => linearReadScope(keyFor(ORG, TEAM_LOOSE), [ISSUE_LOOSE], target, TEAM_OF[target], DOMAINS);
  ok(fromLoose(ISSUE_LOOSE).allowed, "an unassigned session can still read its own issue");
  ok(!fromLoose(ISSUE_SIBLING).allowed && fromLoose(ISSUE_SIBLING).reason === "caller-unassigned", "an unassigned session cannot reach into a domain");

  ok(!linearReadScope("linear/unknown/unknown", [], ISSUE_SIBLING, TEAM_PAY, DOMAINS).allowed, "an under-identified session is refused");
}

{
  const fromWide = linearReadScope(keyFor(ORG2, TEAM_WIDE), [], "any-issue", "team-never-listed", DOMAINS);
  ok(fromWide.allowed && fromWide.reason === "container", "a claim-only domain may read an issue on an unenumerated team in its claimed org");

  ok(!linearReadScope(keyFor(ORG, TEAM_PAY), [], "x", TEAM_WIDE, DOMAINS).allowed, "a claim over one org does not admit a team key from another org");

  const fallbackUnderClaim = linearReadScope(keyFor(ORG2, "some-issue-uuid"), [], "other", "team-never-listed", DOMAINS);
  ok(fallbackUnderClaim.allowed && fallbackUnderClaim.reason === "container", "a fallback (non-team) surface key still resolves under a workspace claim");
  const fallbackUnderRoster = linearReadScope(keyFor(ORG, "some-issue-uuid"), [], ISSUE_SIBLING, TEAM_PAY, DOMAINS);
  ok(!fallbackUnderRoster.allowed && fallbackUnderRoster.reason === "caller-unassigned", "…and under a ROSTER it fails CLOSED, never open");

  const overlapping: readonly Domain[] = [
    defineDomain({ name: "payments", channels: [`linear/${ORG}/${TEAM_PAY}`] }),
    defineDomain({ name: "orgwide", containers: [`linear/${ORG}`] }),
  ];
  const annex = linearReadScope(keyFor(ORG, TEAM_LOOSE), [], ISSUE_SIBLING, TEAM_PAY, overlapping);
  ok(!annex.allowed && annex.reason === "cross-domain", "a claiming domain cannot read an issue on a team another domain listed");
  ok(annex.callerDomain === "orgwide" && annex.targetDomain === "payments", "…and both sides resolved through the SAME core tiering");
}

const ctxFor = (surface: string, issueId?: string, issueIdentifier?: string, org = ORG): BindableContext =>
  ({
    channel: { kind: "linear" },
    session: {
      auth: {
        current: {
          attributes: {
            organization_id: org,
            team_id: surface,
            ...(issueId ? { issue_id: issueId } : {}),
            ...(issueIdentifier ? { issue_identifier: issueIdentifier } : {}),
          },
          principalId: "U_LINEAR",
          principalType: "linear-user",
        },
      },
    },
  }) as BindableContext;

{
  const turn = ctxFor(TEAM_PAY, ISSUE_OWN, ISSUE_OWN_IDENT);
  ok(currentTurnIssueRefs(turn).length === 2, "BOTH of this turn's issue refs are read (uuid AND identifier)");

  let lookups = 0;
  const resolver = async (ref: string): Promise<string | undefined> => {
    lookups++;
    return TEAM_OF[ref];
  };

  const quiet: unknown[] = [];
  await assertLinearIssueAllowed(turn, ISSUE_OWN, DOMAINS, resolver, { audit: async (e) => void quiet.push(e) });
  ok(quiet.length === 0 && lookups === 0, "the OWN issue is admitted with no audit row and NO team lookup");
  await assertLinearIssueAllowed(turn, ISSUE_OWN_IDENT, DOMAINS, resolver, { audit: async (e) => void quiet.push(e) });
  ok(quiet.length === 0 && lookups === 0, "…the identifier spelling too");

  await assertLinearIssueAllowed(turn, ISSUE_SIBLING, DOMAINS, resolver, { audit: async (e) => void quiet.push(e) });
  ok(quiet.length === 0 && lookups === 1, "a sibling issue costs exactly ONE team lookup and is admitted");

  const rows: Array<{ action: string; platform: string; detail?: Record<string, unknown>; principalId?: string }> = [];
  const audit = async (e: { action: string; platform: string; detail?: Record<string, unknown>; principalId?: string }) => void rows.push(e);
  await assert.rejects(() => assertLinearIssueAllowed(turn, ISSUE_ENG, DOMAINS, resolver, { audit }), ChannelScopeError, "a cross-domain issue read throws ChannelScopeError");
  ok(true, "cross-domain read refused (ChannelScopeError)");

  ok(rows.length === 1, "the refusal appended exactly one audit row");
  const row = rows[0]!;
  ok(row.action === "read.refused" && row.platform === "linear", "the row is a linear read.refused");
  ok(row.detail?.reason === "cross-domain", "the row records WHY");
  ok(row.detail?.target === ISSUE_ENG && row.detail?.callerDomain === "payments" && row.detail?.targetDomain === "eng", "the row records the target and BOTH domains");
  ok(row.detail?.targetTeam === TEAM_ENG, "the row records the team the issue resolved to");
  ok(row.principalId === "U_LINEAR", "the row records WHO asked");
  ok(!Object.prototype.hasOwnProperty.call(row.detail ?? {}, "description"), "the row carries no issue content (the fence is PRE-fetch — nothing was fetched)");

  rows.length = 0;
  await assert.rejects(() => assertLinearIssueAllowed(turn, ISSUE_GHOST, DOMAINS, resolver, { audit }), ChannelScopeError, "unresolvable-team issue refused");
  ok(rows.length === 1 && rows[0]!.detail?.reason === "target-unresolvable", "an issue whose team the lookup cannot place is audited as target-unresolvable");

  rows.length = 0;
  await assert.rejects(() => assertLinearIssueAllowed(turn, ISSUE_LOOSE, DOMAINS, resolver, { audit }), ChannelScopeError, "unassigned-team issue refused");
  ok(rows.length === 1 && rows[0]!.detail?.reason === "target-unassigned", "an issue on an unassigned team is audited as target-unassigned");

  rows.length = 0;
  const before = lookups;
  const looseTurn = ctxFor(TEAM_LOOSE, ISSUE_LOOSE);
  await assert.rejects(() => assertLinearIssueAllowed(looseTurn, ISSUE_SIBLING, DOMAINS, resolver, { audit }), ChannelScopeError, "unassigned caller refused");
  ok(rows.length === 1 && rows[0]!.detail?.reason === "caller-unassigned", "an unassigned CALLER is audited as caller-unassigned");
  ok(lookups === before, "…and refused WITHOUT a team lookup (the caller arm gates the I/O)");
  ok(rows[0]!.detail?.callerSurfaceKey === keyFor(ORG, TEAM_LOOSE), "the row records the caller's surface key, so the fix is obvious from the audit alone");

  const copy = linearScopeRefusal(ISSUE_ENG, linearReadScope(keyFor(ORG, TEAM_PAY), [], ISSUE_ENG, TEAM_ENG, DOMAINS));
  ok(copy.includes("linear/<organization_id>/<team_id>") && copy.includes("containers"), "the refusal tells the operator BOTH ways to grant it");
}

{
  registerConfig({
    loadBundles: () => [],
    loadBindings: () => [],
    pluginRegistry: {},
    skillContent: {},
    loadDomains: () => DOMAINS,
    loadSilos: () => [],
    domainsForSurface: () => [],
  });
  for (const k of ["LINEAR_AGENT_ACCESS_TOKEN", "LINEAR_ACCESS_TOKEN", "LINEAR_API_KEY", "LINEAR_API_TOKEN", "LINEAR_CLIENT_ID", "LINEAR_CLIENT_SECRET"]) {
    delete process.env[k];
  }
  const turn = ctxFor(TEAM_PAY, ISSUE_OWN);
  let err: unknown;
  try {
    await (readLinearIssueEntry as unknown as { execute: (i: unknown, c: unknown) => Promise<unknown> }).execute({ issue: ISSUE_ENG }, turn);
  } catch (e) {
    err = e;
  }
  if (!(err instanceof ChannelScopeError)) console.error("  [debug] read_linear_issue threw:", err);
  ok(err instanceof ChannelScopeError, "read_linear_issue refuses an out-of-domain issue through the FENCE (not the missing-credential error)");
}

console.log(`✓ ${passed} linear read-scope assertions passed`);
