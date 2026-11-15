// proves: read.refused

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  assertLinearIssueAllowed,
  currentTurnIssueRefs,
  linearIssueScope,
  linearScopeRefusal,
} from "../agent/channels/linear-scope.js";
import { ChannelScopeError, connectorReadsThisTurn, defineDomain, overrideSettingsForTest, registerConfig, registerIdentityMapper, type BindableContext, type Domain } from "@open-everywhere/core/agent/adapter-api.js";
import { registerLinearProvider } from "../agent/register.js";
import { commentAgeAtRead, readLinearIssueEntry } from "../agent/tools/read_linear_issue.js";

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
  defineDomain({ name: "payments", reach: [`linear/${ORG}/${TEAM_PAY}`] }),
  defineDomain({ name: "eng", reach: [`linear/${ORG}/${TEAM_ENG}`] }),
  defineDomain({ name: "wide", reach: [`linear/${ORG2}`] }),
];

const keyFor = (org: string, surface: string): string => `linear/${org}/${surface}`;

const ISSUE_OWN = "11111111-1111-4111-8111-111111111111";
const ISSUE_OWN_IDENT = "PAY-1";
const ISSUE_OWN_URL = "https://linear.app/acme/issue/SOAK-14/implement-throttle-retry-ladder";
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
    linearIssueScope(keyFor(ORG, TEAM_PAY), [ISSUE_OWN, ISSUE_OWN_IDENT], target, team, DOMAINS);

  const own = fromPay(ISSUE_OWN);
  ok(own.allowed && own.reason === "own-issue", "the session's OWN issue is always readable");
  ok(fromPay(ISSUE_OWN_IDENT, undefined).allowed, "…named by its human identifier too, with NO team resolved");
  ok(linearIssueScope(keyFor(ORG, TEAM_PAY), [ISSUE_OWN], "pay-1".toUpperCase(), undefined, DOMAINS).reason !== "own-issue", "…and a DIFFERENT ref is not the own issue");

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

  const fromLoose = (target: string) => linearIssueScope(keyFor(ORG, TEAM_LOOSE), [ISSUE_LOOSE], target, TEAM_OF[target], DOMAINS);
  ok(fromLoose(ISSUE_LOOSE).allowed, "an unassigned session can still read its own issue");
  ok(!fromLoose(ISSUE_SIBLING).allowed && fromLoose(ISSUE_SIBLING).reason === "caller-unassigned", "an unassigned session cannot reach into a domain");

  ok(!linearIssueScope("linear/unknown/unknown", [], ISSUE_SIBLING, TEAM_PAY, DOMAINS).allowed, "an under-identified session is refused");
}

{
  const fromWide = linearIssueScope(keyFor(ORG2, TEAM_WIDE), [], "any-issue", "team-never-listed", DOMAINS);
  ok(fromWide.allowed && fromWide.reason === "container", "a claim-only domain may read an issue on an unenumerated team in its claimed org");

  ok(!linearIssueScope(keyFor(ORG, TEAM_PAY), [], "x", TEAM_WIDE, DOMAINS).allowed, "a claim over one org does not admit a team key from another org");

  const fallbackUnderClaim = linearIssueScope(keyFor(ORG2, "some-issue-uuid"), [], "other", "team-never-listed", DOMAINS);
  ok(fallbackUnderClaim.allowed && fallbackUnderClaim.reason === "container", "a fallback (non-team) surface key still resolves under a workspace claim");
  const fallbackUnderRoster = linearIssueScope(keyFor(ORG, "some-issue-uuid"), [], ISSUE_SIBLING, TEAM_PAY, DOMAINS);
  ok(!fallbackUnderRoster.allowed && fallbackUnderRoster.reason === "caller-unassigned", "…and under a ROSTER it fails CLOSED, never open");

  const overlapping: readonly Domain[] = [
    defineDomain({ name: "payments", reach: [`linear/${ORG}/${TEAM_PAY}`] }),
    defineDomain({ name: "orgwide", reach: [`linear/${ORG}`] }),
  ];
  const annex = linearIssueScope(keyFor(ORG, TEAM_LOOSE), [], ISSUE_SIBLING, TEAM_PAY, overlapping);
  ok(!annex.allowed && annex.reason === "cross-domain", "a claiming domain cannot read an issue on a team another domain listed");
  ok(annex.callerDomain === "orgwide" && annex.targetDomain === "payments", "…and both sides resolved through the SAME core tiering");
}

const ctxFor = (surface: string, issueId?: string, issueIdentifier?: string, org = ORG, turnId?: string): BindableContext =>
  ({
    channel: { kind: "linear" },
    session: {
      ...(turnId ? { turn: { id: turnId, sequence: 1 } } : {}),
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

  const copy = linearScopeRefusal(ISSUE_ENG, linearIssueScope(keyFor(ORG, TEAM_PAY), [], ISSUE_ENG, TEAM_ENG, DOMAINS));
  ok(copy.includes("linear/<organization_id>/<team_id>") && copy.includes("linear/<organization_id>"), "the refusal tells the operator BOTH ways to grant it — the exact team, or the whole workspace");
  ok(copy.includes("`reach`") && !copy.includes("`channels`") && !copy.includes("`containers`"), "…in the CURRENT vocabulary; an operator who pastes a removed field hits refuseUnknownFields");
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
  for (const k of ["LINEAR_AGENT_ACCESS_TOKEN", "LINEAR_ACCESS_TOKEN", "LINEAR_API_KEY", "LINEAR_API_TOKEN", "LINEAR_CLIENT_SECRET"]) {
    delete process.env[k];
  }
  overrideSettingsForTest({ linear: { clientId: "" } });
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

{
  const ghostVerdict = linearIssueScope(keyFor(ORG, TEAM_PAY), [], ISSUE_GHOST, undefined, DOMAINS);
  const notFound = linearScopeRefusal(ISSUE_GHOST, ghostVerdict, "read", false, true);
  ok(notFound.includes("could not be resolved in this workspace"), "a target the lookup could not place says the lookup found nothing");
  ok(notFound.includes("visible to the workspace credential"), "…and names the credential, which is the thing that decided");
  ok(!notFound.includes("memory/config/domains.ts"), "…and does NOT blame the memory domain, which decided nothing");
  ok(!notFound.includes("containers"), "…and does NOT offer the domain-grant remedy, which would not work");

  const noWorkspace = linearScopeRefusal("PAY-9", { allowed: false, reason: "target-unresolvable", callerDomain: "payments" }, "read", true);
  ok(noWorkspace.includes("memory/config/domains/<name>.ts") && noWorkspace.includes("linear/<organization_id>"), "a caller with NO workspace still gets the domain remedy");
  ok(noWorkspace.includes('credential: "workspace"'), "…and the work-grant remedy, which for it is real");
  ok(!noWorkspace.includes("could not be resolved in this workspace"), "…and never the not-found copy");

  const crossDomain = linearScopeRefusal(ISSUE_ENG, linearIssueScope(keyFor(ORG, TEAM_PAY), [], ISSUE_ENG, TEAM_ENG, DOMAINS), "read", false, true);
  ok(crossDomain.includes("memory/config/domains/<name>.ts") && !crossDomain.includes("could not be resolved in this workspace"), "a cross-domain refusal keeps its own copy");

  const turn = ctxFor(TEAM_PAY, ISSUE_OWN);
  const resolver = async (ref: string): Promise<string | undefined> => TEAM_OF[ref];
  let wired: unknown;
  try {
    await assertLinearIssueAllowed(turn, ISSUE_GHOST, DOMAINS, resolver, { audit: async () => {} });
  } catch (e) {
    wired = e;
  }
  ok(wired instanceof ChannelScopeError, "the wired fence still refuses an unplaceable issue");
  ok((wired as Error).message.includes("could not be resolved in this workspace"), "…and the message the model reads is the not-found copy");
  ok(!(wired as Error).message.includes("memory/config/domains.ts"), "…with no false domain remedy in it");
}

{
  const READ_AT = "2026-03-16T20:20:54.000Z";
  ok(commentAgeAtRead("2026-03-16T19:53:54.000Z", READ_AT) === "27 minutes", "a 27-minute-old comment is reported as 27 minutes old");
  ok(commentAgeAtRead("2026-03-16T20:20:00.000Z", READ_AT) === "less than a minute", "a fresh comment says so");
  ok(commentAgeAtRead("2026-03-16T20:19:30.000Z", READ_AT) === "1 minute", "one minute is singular");
  ok(commentAgeAtRead("2026-03-16T17:20:54.000Z", READ_AT) === "3 hours", "hours once minutes stop helping");
  ok(commentAgeAtRead("2026-03-14T20:20:54.000Z", READ_AT) === "2 days", "days once hours stop helping");
  ok(commentAgeAtRead("2026-03-16T20:31:00.000Z", READ_AT) === undefined, "a comment stamped AFTER the read gets no age (never guess under clock skew)");
  ok(commentAgeAtRead(undefined, READ_AT) === undefined && commentAgeAtRead("2026-03-16T19:53:54.000Z", undefined) === undefined, "a missing timestamp gets no age");
  ok(commentAgeAtRead("not-a-date", READ_AT) === undefined, "an unparseable timestamp gets no age");

  const render = async (o: Record<string, unknown>): Promise<string> =>
    (await (readLinearIssueEntry as unknown as { toModelOutput: (o: unknown) => Promise<{ value: string }> }).toModelOutput({
      issue: "SOAK-14",
      identifier: "SOAK-14",
      title: "Implement throttle retry ladder",
      state: "Todo",
      comments: 1,
      truncated: false,
      description: "",
      text: "  - openeverywhere at 2026-03-16T19:53:54.000Z (27 minutes before this read): the move is pending human approval.",
      ...o,
    })).value;

  const dated = await render({ readAt: READ_AT });
  ok(dated.includes(`Read live at ${READ_AT}`), "the render dates the read");
  ok(dated.includes("the fields above are the issue's state at that moment"), "…and says the state is what is CURRENT");
  ok(dated.includes("HISTORY"), "…and names the comment block history");
  ok(dated.includes("not the present state"), "…and says plainly that a comment's claim is not the present state");
  ok(dated.includes("[Todo]") && dated.includes("(27 minutes before this read)"), "…so the live state and the comment's age sit in the same render");
  ok(dated.includes("oldest first"), "…and the comment order is stated, not assumed");

  const undatedOut = await render({});
  ok(!undatedOut.includes("Read live at"), "an output with no readAt claims no read time");
  ok(!undatedOut.includes("HISTORY"), "…and makes no claim it cannot date");
  ok(undatedOut.includes("[Todo]"), "…while still rendering the issue");
}

{
  const savedFetch = globalThis.fetch;
  const savedToken = process.env.LINEAR_AGENT_ACCESS_TOKEN;
  process.env.LINEAR_AGENT_ACCESS_TOKEN = "read-scope-test-token";
  const commentAt = new Date(Date.now() - 27 * 60_000).toISOString();
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        data: {
          issue: {
            id: ISSUE_OWN,
            identifier: "SOAK-14",
            title: "Implement throttle retry ladder",
            url: ISSUE_OWN_URL,
            description: "the v1 ladder",
            state: { name: "Todo", type: "unstarted" },
            comments: {
              nodes: [{ id: "c1", body: "the move is pending human approval, so it has not moved yet", createdAt: commentAt, user: { id: "u1", name: "openeverywhere" } }],
              pageInfo: { hasNextPage: false },
            },
          },
        },
      }),
      { status: 200 },
    )) as unknown as typeof fetch;
  try {
    const turn = ctxFor(TEAM_PAY, ISSUE_OWN);
    const entry = readLinearIssueEntry as unknown as {
      execute: (i: unknown, c: unknown) => Promise<{ readAt?: string; text: string; url?: string }>;
      toModelOutput: (o: unknown) => Promise<{ value: string }>;
    };
    const out = await entry.execute({ issue: ISSUE_OWN }, turn);
    ok(typeof out.readAt === "string" && Number.isFinite(Date.parse(out.readAt!)), "execute stamps the read with a parseable time");
    ok(out.url === ISSUE_OWN_URL, `🔴 OPE-1714: execute returns the issue's own Linear URL, as Linear reports it (saw: ${JSON.stringify(out.url)})`);
    ok(out.text.includes("(27 minutes before this read)"), "execute ages every comment against that read time");
    const rendered = (await entry.toModelOutput(out)).value;
    ok(rendered.includes(`Read live at ${out.readAt}`), "…and the model sees the read time on the output it gets");
    ok(rendered.includes(ISSUE_OWN_URL), "🔴 OPE-1714: …and the LINK on the header line too, so the model can hand a human something to click");
    ok(rendered.includes("[Todo]") && rendered.includes("(27 minutes before this read)"), "…beside the live state and the comment's age — the pair soak run 3 could not tell apart");
  } finally {
    globalThis.fetch = savedFetch;
    if (savedToken === undefined) delete process.env.LINEAR_AGENT_ACCESS_TOKEN;
    else process.env.LINEAR_AGENT_ACCESS_TOKEN = savedToken;
  }
}

{
  const nodeRequire = createRequire(import.meta.url);
  const eveRoot = dirname(nodeRequire.resolve("eve/package.json"));
  const eveAbs = (rel: string): string => pathToFileURL(join(eveRoot, rel)).href;
  const { ContextContainer, contextStorage } = await import(eveAbs("dist/src/context/container.js"));
  const { SessionKey } = await import(eveAbs("dist/src/context/keys.js"));
  const savedFetch = globalThis.fetch;
  const savedToken = process.env.LINEAR_AGENT_ACCESS_TOKEN;
  process.env.LINEAR_AGENT_ACCESS_TOKEN = "read-scope-test-token";
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        data: {
          issue: {
            id: ISSUE_OWN,
            identifier: "SOAK-14",
            title: "Implement throttle retry ladder",
            url: ISSUE_OWN_URL,
            description: "the v1 ladder",
            state: { name: "Todo", type: "unstarted" },
            comments: { nodes: [], pageInfo: { hasNextPage: false } },
          },
        },
      }),
      { status: 200 },
    )) as unknown as typeof fetch;
  try {
    const TURN = "turn-provenance-door";
    const container = new ContextContainer();
    container.set(SessionKey, { sessionId: "linear-read-scope-test", auth: null, turn: 1, parent: undefined });
    const reads = await contextStorage.run(container, async () => {
      await (readLinearIssueEntry as unknown as { execute: (i: unknown, c: unknown) => Promise<unknown> }).execute(
        { issue: ISSUE_OWN },
        ctxFor(TEAM_PAY, ISSUE_OWN, undefined, ORG, TURN),
      );
      return connectorReadsThisTurn(TURN);
    });
    ok(reads.length === 1, `🔴 the tool writes exactly ONE reply-provenance entry for the read it made (saw ${reads.length})`);
    ok(
      reads[0]?.connection === "linear" && reads[0]?.op === "read_linear_issue",
      `🔴 …under the connection and op CORE picks for this kind, never a label the provider chose (saw: ${JSON.stringify({ connection: reads[0]?.connection, op: reads[0]?.op })})`,
    );
    ok(
      reads[0]?.record?.kind === "linear-issue" && reads[0]?.record?.id === "SOAK-14",
      `🔴 …carrying the RECORD, because the turn was woken on this very issue — the door matched the wake's UUID stamp against the identifier the fetch resolved (saw: ${JSON.stringify(reads[0]?.record)})`,
    );
  } finally {
    globalThis.fetch = savedFetch;
    if (savedToken === undefined) delete process.env.LINEAR_AGENT_ACCESS_TOKEN;
    else process.env.LINEAR_AGENT_ACCESS_TOKEN = savedToken;
  }
}

{
  const PROBE = "ope1940-foreign-probe";
  registerIdentityMapper(PROBE, () => ({ workspace: "W1", surface: "S1", mode: "dm", visibility: "private", trust: "internal", principalId: "U_FOREIGN" }));
  const foreign = { channel: { kind: PROBE } } as unknown as BindableContext;
  const rows: Array<{ platform?: string; surfaceMode?: string }> = [];
  const audit = async (e: { platform?: string; surfaceMode?: string }) => void rows.push(e);
  const resolver = async (): Promise<string | undefined> => TEAM_ENG;

  await assert.rejects(() => assertLinearIssueAllowed(foreign, ISSUE_ENG, DOMAINS, resolver, { audit }), ChannelScopeError, "a foreign caller is refused");
  ok(rows.length === 1 && rows[0]!.platform === "linear", "OPE-1940: the foreign caller's refusal is filed under linear");
  ok(rows[0]!.surfaceMode === undefined, "🔴 OPE-1940: …and carries NO mode — the caller's DM mode never rides a linear row");

  rows.length = 0;
  await assert.rejects(() => assertLinearIssueAllowed(ctxFor(TEAM_LOOSE, ISSUE_LOOSE), ISSUE_SIBLING, DOMAINS, resolver, { audit }), ChannelScopeError, "a linear caller is refused");
  ok(rows.length === 1 && rows[0]!.surfaceMode === "channel", "OPE-1940 control: a LINEAR caller's refusal carries its resolved mode, so the guard does not mask everything");
}

console.log(`✓ ${passed} linear read-scope assertions passed`);

// proves: TOOL-read_linear_issue
