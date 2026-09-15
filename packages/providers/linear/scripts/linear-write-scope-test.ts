import assert from "node:assert/strict";
import {
  assertLinearIssueAllowed,
  assertLinearIssueWriteAllowed,
  assertLinearTeamWriteAllowed,
  linearIssueScope,
  linearScopeRefusal,
  linearTeamScope,
} from "../agent/channels/linear-scope.js";
import {
  ChannelScopeError,
  defineDomain,
  registerConfig,
  registerIdentityMapper,
  workGrantCredential,
  type BindableContext,
  type Domain,
} from "@open-everywhere/core/agent/adapter-api.js";
import { linearEntityAdapter } from "../agent/channels/linear-actions.js";
import { linearTicketCreateAdapter } from "../agent/channels/linear-create.js";
import { linearWorkOrg } from "../agent/channels/linear-work.js";
import { registerLinearProvider } from "../agent/register.js";

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

const SLACK_PAY = "slack/T1/CPAY";
const SLACK_ENG = "slack/T1/CENG";

const DOMAINS: readonly Domain[] = [
  defineDomain({ name: "payments", reach: [`linear/${ORG}/${TEAM_PAY}`, SLACK_PAY] }),
  defineDomain({ name: "eng", reach: [`linear/${ORG}/${TEAM_ENG}`, SLACK_ENG] }),
  defineDomain({ name: "wide", reach: [`linear/${ORG2}`] }),
];

const keyFor = (org: string, surface: string): string => `linear/${org}/${surface}`;

const ISSUE_OWN = "11111111-1111-4111-8111-111111111111";
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
  const fromPay = (team: string | undefined) => linearTeamScope(keyFor(ORG, TEAM_PAY), team, DOMAINS);

  ok(fromPay(TEAM_PAY).allowed && fromPay(TEAM_PAY).reason === "roster", "filing onto the caller's OWN team is admitted via the roster");
  ok(!fromPay(TEAM_ENG).allowed && fromPay(TEAM_ENG).reason === "cross-domain", "filing onto ANOTHER domain's team is refused as cross-domain");
  ok(fromPay(TEAM_ENG).targetDomain === "eng" && fromPay(TEAM_ENG).callerDomain === "payments", "the cross-domain verdict names BOTH domains");
  ok(!fromPay(TEAM_LOOSE).allowed && fromPay(TEAM_LOOSE).reason === "target-unassigned", "a real team in NO domain is refused, not assumed");
  ok(!fromPay(undefined).allowed && fromPay(undefined).reason === "target-unresolvable", "a team the lookup could not place is refused (fail closed)");

  const fromWide = linearTeamScope(keyFor(ORG2, TEAM_WIDE), TEAM_WIDE, DOMAINS);
  ok(fromWide.allowed && fromWide.reason === "container", "a whole-org container `reach` entry admits a team it never enumerated");
  ok(!linearTeamScope(keyFor(ORG, TEAM_PAY), TEAM_WIDE, DOMAINS).allowed, "a claim over ANOTHER org does not admit its team to this caller");

  const unassigned = linearTeamScope(keyFor(ORG, "some-issue-uuid-not-a-team"), TEAM_PAY, DOMAINS);
  ok(!unassigned.allowed && unassigned.reason === "caller-unassigned", "an under-identified caller is refused with NO own-team shortcut");
  ok(linearTeamScope("linear/unknown/unknown", TEAM_PAY, DOMAINS).reason === "caller-unassigned", "a caller in no domain has no teams to file onto");
}

const ctxFor = (surface: string, issueId?: string): BindableContext =>
  ({
    channel: { kind: "linear" },
    session: {
      auth: {
        current: {
          attributes: { organization_id: ORG, team_id: surface, ...(issueId ? { issue_id: issueId } : {}) },
          principalId: "U_LINEAR",
          principalType: "linear-user",
        },
      },
    },
  }) as BindableContext;

{
  const turn = ctxFor(TEAM_PAY, ISSUE_OWN);
  let lookups = 0;
  const resolver = async (ref: string): Promise<string | undefined> => {
    lookups++;
    return TEAM_OF[ref];
  };
  const rows: Array<{ action: string; platform: string; detail?: Record<string, unknown>; principalId?: string }> = [];
  const audit = async (e: { action: string; platform: string; detail?: Record<string, unknown>; principalId?: string }) => void rows.push(e);

  await assertLinearIssueWriteAllowed(turn, ISSUE_OWN, DOMAINS, resolver, { audit });
  ok(rows.length === 0 && lookups === 0, "mutating THIS turn's own issue costs no lookup and no refusal row");
  await assertLinearIssueWriteAllowed(turn, ISSUE_SIBLING, DOMAINS, resolver, { audit });
  ok(rows.length === 0 && lookups === 1, "a sibling issue in the same domain costs exactly ONE lookup and is admitted");

  await assert.rejects(
    () => assertLinearIssueWriteAllowed(turn, ISSUE_ENG, DOMAINS, resolver, { audit }),
    ChannelScopeError,
    "a cross-domain MUTATION throws the shared fail-closed class",
  );
  ok(rows.length === 1, "the refused write appended exactly one audit row");
  const row = rows[0]!;
  ok(row.action === "write.refused" && row.platform === "linear", "the row is a linear write.refused — NOT read.refused");
  ok(row.detail?.reason === "cross-domain" && row.detail?.callerDomain === "payments" && row.detail?.targetDomain === "eng", "the row records WHY and both domains");
  ok(row.detail?.targetTeam === TEAM_ENG && row.detail?.target === ISSUE_ENG, "the row records the target issue and the team it resolved to");
  ok(row.principalId === "U_LINEAR", "the row records WHO tried to write");

  rows.length = 0;
  await assert.rejects(() => assertLinearIssueWriteAllowed(turn, ISSUE_GHOST, DOMAINS, resolver, { audit }), ChannelScopeError, "unresolvable-team write refused");
  ok(rows[0]!.detail?.reason === "target-unresolvable" && rows[0]!.action === "write.refused", "an unplaceable issue is a write.refused/target-unresolvable");
  rows.length = 0;
  await assert.rejects(() => assertLinearIssueWriteAllowed(turn, ISSUE_LOOSE, DOMAINS, resolver, { audit }), ChannelScopeError, "unassigned-team write refused");
  ok(rows[0]!.detail?.reason === "target-unassigned", "a team in no domain is a write.refused/target-unassigned");

  rows.length = 0;
  const before = lookups;
  const looseTurn = ctxFor("not-a-team-uuid");
  await assert.rejects(() => assertLinearIssueWriteAllowed(looseTurn, ISSUE_SIBLING, DOMAINS, resolver, { audit }), ChannelScopeError, "unassigned caller refused");
  ok(rows[0]!.detail?.reason === "caller-unassigned" && lookups === before, "an unassigned caller is refused WITHOUT a team lookup");

  rows.length = 0;
  let teamLookups = 0;
  const teamResolver = async (t: string): Promise<string | undefined> => {
    teamLookups++;
    return t === "PAY" ? TEAM_PAY : t === "ENG" ? TEAM_ENG : undefined;
  };
  await assertLinearTeamWriteAllowed(turn, "PAY", DOMAINS, teamResolver, { audit });
  ok(rows.length === 0 && teamLookups === 1, "filing onto the caller's own team resolves the KEY and is admitted");
  await assert.rejects(
    () => assertLinearTeamWriteAllowed(turn, "ENG", DOMAINS, teamResolver, { audit }),
    ChannelScopeError,
    "filing into ANOTHER domain's team is refused",
  );
  ok(rows.length === 1 && rows[0]!.action === "write.refused" && rows[0]!.detail?.target === "ENG", "the create refusal is audited as a write, naming the team the CALLER asked for");
  ok(rows[0]!.detail?.targetTeam === TEAM_ENG, "…and the team id it resolved to, so the audit is readable without the workspace");

  rows.length = 0;
  await assert.rejects(() => assertLinearTeamWriteAllowed(turn, "NOPE", DOMAINS, teamResolver, { audit }), ChannelScopeError, "an unknown team refuses");
  ok(rows[0]!.detail?.reason === "target-unresolvable", "an unknown destination is target-unresolvable, never admitted");

  rows.length = 0;
  const beforeTeam = teamLookups;
  await assert.rejects(() => assertLinearTeamWriteAllowed(looseTurn, "PAY", DOMAINS, teamResolver, { audit }), ChannelScopeError, "unassigned caller cannot file anywhere");
  ok(rows[0]!.detail?.reason === "caller-unassigned" && teamLookups === beforeTeam, "…and is refused without resolving the team");

  const copy = linearScopeRefusal(ISSUE_ENG, linearTeamScope(keyFor(ORG, TEAM_PAY), TEAM_ENG, DOMAINS), "write");
  ok(copy.includes("write scope") && !copy.includes("read scope"), "the write refusal says WRITE scope");
  ok(copy.includes("linear/<organization_id>/<team_id>") && copy.includes("linear/<organization_id>"), "…and still tells the operator BOTH ways to grant it");
  ok(copy.includes("`reach`") && !copy.includes("`containers`"), "…in the CURRENT vocabulary");
}

for (const k of ["LINEAR_AGENT_ACCESS_TOKEN", "LINEAR_ACCESS_TOKEN", "LINEAR_API_KEY", "LINEAR_API_TOKEN", "LINEAR_CLIENT_ID", "LINEAR_CLIENT_SECRET"]) {
  delete process.env[k];
}

{
  const turn = ctxFor(TEAM_PAY, ISSUE_OWN);
  const entityFence = (id: string) => linearEntityAdapter.checkAccess!(turn, id, DOMAINS) as Promise<void>;

  await assert.rejects(() => entityFence(ISSUE_ENG), ChannelScopeError, "the entity adapter's fence refuses a cross-domain issue (the FENCE, not a Linear API error)");
  await assert.rejects(
    () => linearTicketCreateAdapter.checkAccess!(turn, "ENG", DOMAINS) as Promise<void>,
    ChannelScopeError,
    "the create adapter's fence refuses a destination team in another domain, before anything is frozen onto a card",
  );

  await entityFence(ISSUE_OWN);
  ok(true, "the caller's OWN issue passes the adapter's fence with no credentials and no lookup");

  ok(typeof linearEntityAdapter.checkAccess === "function", "the entity adapter DECLARES checkAccess (it declared none before OPE-241)");
  ok(typeof linearTicketCreateAdapter.checkAccess === "function", "the create adapter DECLARES checkAccess");
}

const workGranted = (name: string, channels: readonly string[], org: string): Domain =>
  defineDomain({ name, reach: [...channels], credentials: [{ connector: "linear", credential: "workspace", use: org }] });

const GRANTED_DOMAINS: readonly Domain[] = [
  workGranted("payments", [`linear/${ORG}/${TEAM_PAY}`, SLACK_PAY], ORG),
  defineDomain({ name: "eng", reach: [`linear/${ORG}/${TEAM_ENG}`, SLACK_ENG] }),
  defineDomain({ name: "wide", reach: [`linear/${ORG2}`] }),
];

{
  const fromSlack = (team: string | undefined, workOrg?: string) => linearTeamScope(SLACK_PAY, team, DOMAINS, workOrg);

  const ungranted = fromSlack(TEAM_PAY);
  ok(!ungranted.allowed && ungranted.reason === "target-unresolvable", "a Slack caller with NO work grant is still refused target-unresolvable");
  ok(ungranted.callerDomain === "payments", "…and the refusal still names the caller's domain, so the audit row is readable");

  ok(!fromSlack(TEAM_PAY).allowed, "the domain's Linear CHAT-channel entry does NOT confer write capability on its Slack room");

  const chatRoleOnly = defineDomain({
    name: "payments",
    reach: [`linear/${ORG}/${TEAM_PAY}`, SLACK_PAY],
    credentials: [{ connector: "linear", credential: "channel-key", use: ORG }],
  });
  ok(
    workGrantCredential(chatRoleOnly, "linear", "workspace") === undefined,
    "declaring a NON-work linear role resolves no work grant (explicit undefined, not a fallback)",
  );

  const granted = fromSlack(TEAM_PAY, ORG);
  ok(granted.allowed && granted.reason === "work-grant", "the SAME create is admitted once the domain declares a Linear work credential");
  ok(granted.targetTeam === TEAM_PAY && granted.callerDomain === "payments", "…and the admit verdict records the team and the caller's domain");

  ok(fromSlack(TEAM_LOOSE, ORG).allowed, "a team in NO memory domain is admitted on the workspace grant alone — the credential's reach IS the boundary");

  const annexed = fromSlack(TEAM_ENG, ORG);
  ok(!annexed.allowed && annexed.reason === "cross-domain", "even a whole-workspace grant cannot reach a team ANOTHER domain owns");
  ok(annexed.targetDomain === "eng" && annexed.callerDomain === "payments", "…and the refusal names both domains");

  const elsewhere = fromSlack(TEAM_PAY, ORG2);
  ok(!elsewhere.allowed && elsewhere.reason === "cross-domain", "a grant in ANOTHER workspace does not reach this workspace's teams");

  const nomad = linearTeamScope("slack/T1/CNOWHERE", TEAM_PAY, DOMAINS, ORG);
  ok(!nomad.allowed && nomad.reason === "caller-unassigned", "a caller in NO domain is refused even holding a work grant");

  ok(linearTeamScope(keyFor(ORG, TEAM_PAY), TEAM_PAY, DOMAINS, ORG2).reason === "roster", "a Linear caller still resolves through its OWN key, not the grant");
  ok(!linearTeamScope(keyFor(ORG, TEAM_PAY), TEAM_ENG, DOMAINS, ORG).allowed, "a work grant cannot widen a Linear caller past the cross-domain wall");
}

{
  const slackCtx = (channelId: string): BindableContext =>
    ({
      channel: { kind: "slack" },
      session: {
        auth: {
          current: { attributes: { team_id: "T1", channel_id: channelId, channel_type: "channel" }, principalId: "U_SLACK", principalType: "slack-user" },
        },
      },
    }) as BindableContext;

  registerIdentityMapper("slack", (ctx) => {
    const a = (ctx as BindableContext).session?.auth?.current?.attributes as Record<string, string> | undefined;
    return { workspace: a?.["team_id"], surface: a?.["channel_id"], mode: "channel", visibility: "public", trust: "internal", principalId: a?.["user_id"] };
  });

  const rows: Array<{ action: string; platform: string; detail?: Record<string, unknown> }> = [];
  const audit = async (e: { action: string; platform: string; detail?: Record<string, unknown> }) => void rows.push(e);
  let lookups = 0;
  let sawOrg: string | undefined;
  const teamResolver = async (t: string, organizationId: string | undefined): Promise<string | undefined> => {
    lookups++;
    sawOrg = organizationId;
    return t === "PAY" ? TEAM_PAY : t === "ENG" ? TEAM_ENG : undefined;
  };

  const slackPay = slackCtx("CPAY");

  await assert.rejects(() => assertLinearTeamWriteAllowed(slackPay, "PAY", DOMAINS, teamResolver, { audit }), ChannelScopeError, "an ungranted cross-surface create is refused");
  ok(rows.length === 1 && rows[0]!.action === "write.refused" && rows[0]!.detail?.reason === "target-unresolvable", "…audited write.refused/target-unresolvable — the row the live soak run produced");
  ok(lookups === 0, "…and refused BEFORE any team lookup");

  rows.length = 0;
  await assertLinearTeamWriteAllowed(slackPay, "PAY", DOMAINS, teamResolver, { audit, workOrg: ORG });
  ok(rows.length === 0 && lookups === 1, "a granted cross-surface create is admitted, costing exactly one lookup");
  ok(sawOrg === ORG, "…and the team lookup ran under the GRANTED workspace, which is also the credential selector");

  const copy = linearScopeRefusal("PAY", linearTeamScope(SLACK_PAY, TEAM_PAY, DOMAINS), "write", true);
  ok(copy.includes('credential: "workspace"'), "the write refusal names the domain's Linear WORK credential declaration as the remedy");
  ok(
    !linearScopeRefusal("PAY", linearTeamScope(SLACK_PAY, TEAM_PAY, DOMAINS), "read").includes('credential: "workspace"'),
    "…and the READ copy does not, since a work grant is not a read grant",
  );
  ok(
    !linearScopeRefusal("PAY", linearTeamScope(SLACK_PAY, TEAM_PAY, DOMAINS), "write").includes('credential: "workspace"'),
    "the DEFAULT write copy (no grantCapable arg) names no grant remedy",
  );

  sawOrg = undefined;
  await assertLinearTeamWriteAllowed(ctxFor(TEAM_PAY, ISSUE_OWN), "PAY", DOMAINS, teamResolver, { audit, workOrg: ORG2 });
  ok(sawOrg === ORG, "a Linear caller's lookup still runs under the workspace it was woken in, never the grant's");

  rows.length = 0;
  let issueLookups = 0;
  const issueResolver = async (ref: string): Promise<string | undefined> => {
    issueLookups++;
    return TEAM_OF[ref];
  };

  await assertLinearIssueWriteAllowed(slackPay, ISSUE_SIBLING, GRANTED_DOMAINS, issueResolver, { audit, workOrg: ORG });
  ok(rows.length === 0 && issueLookups === 1, "🔴 THE FIX: a Slack-woken set_state/assign/add_label caller is ADMITTED under the domain's Linear work grant");

  rows.length = 0;
  const beforeUngranted = issueLookups;
  await assert.rejects(
    () => assertLinearIssueWriteAllowed(slackPay, ISSUE_SIBLING, DOMAINS, issueResolver, { audit }),
    ChannelScopeError,
    "NEGATIVE CONTROL: the same caller with NO work grant is still refused",
  );
  ok(rows[0]?.detail?.reason === "target-unresolvable" && rows[0]?.action === "write.refused", "…audited write.refused/target-unresolvable, unchanged");
  ok(issueLookups === beforeUngranted, "…and refused BEFORE any team lookup");
  ok(
    (rows[0]?.detail?.callerDomain ?? "") === "payments",
    "…naming the caller's domain, so the row is readable",
  );

  rows.length = 0;
  await assert.rejects(
    () => assertLinearIssueWriteAllowed(slackPay, ISSUE_ENG, GRANTED_DOMAINS, issueResolver, { audit, workOrg: ORG }),
    ChannelScopeError,
    "even a granted cross-surface caller cannot mutate an issue on ANOTHER domain's team",
  );
  ok(rows[0]?.detail?.reason === "cross-domain" && rows[0]?.detail?.targetDomain === "eng", "…refused cross-domain, naming the domain that owns it");

  rows.length = 0;
  await assertLinearIssueWriteAllowed(slackPay, ISSUE_LOOSE, GRANTED_DOMAINS, issueResolver, { audit, workOrg: ORG });
  ok(rows.length === 0, "an issue on a team in NO memory domain is admitted on the workspace grant alone");

  rows.length = 0;
  let ungrantedErr: unknown;
  try {
    await assertLinearIssueWriteAllowed(slackPay, ISSUE_SIBLING, DOMAINS, issueResolver, { audit });
  } catch (e) {
    ungrantedErr = e;
  }
  ok((ungrantedErr as Error).message.includes('credential: "workspace"'), "🔴 the ungranted set_state refusal NAMES the work credential — the remedy the code now keeps");
  rows.length = 0;
  let walledErr: unknown;
  try {
    await assertLinearIssueWriteAllowed(slackPay, ISSUE_ENG, GRANTED_DOMAINS, issueResolver, { audit, workOrg: ORG });
  } catch (e) {
    walledErr = e;
  }
  ok(!(walledErr as Error).message.includes('credential: "workspace"'), "NEGATIVE CONTROL: a caller that already holds the grant is NOT told to add one — it would fix nothing");

  rows.length = 0;
  await assert.rejects(
    () => assertLinearIssueWriteAllowed(ctxFor(TEAM_PAY, ISSUE_OWN), ISSUE_ENG, GRANTED_DOMAINS, issueResolver, { audit, workOrg: ORG2 }),
    ChannelScopeError,
    "a Linear caller still hits the cross-domain wall, grant or no grant",
  );
  ok(rows[0]?.detail?.reason === "cross-domain", "…for the same reason as before");

  rows.length = 0;
  await assertLinearIssueAllowed(slackPay, ISSUE_SIBLING, GRANTED_DOMAINS, issueResolver, { audit, workOrg: ORG });
  ok(rows.length === 0, "🔴 THE FIX: a Slack-woken read_linear_issue caller is ADMITTED under the domain's Linear work grant");

  rows.length = 0;
  await assert.rejects(
    () => assertLinearIssueAllowed(slackPay, ISSUE_SIBLING, GRANTED_DOMAINS, issueResolver, { audit }),
    ChannelScopeError,
    "NEGATIVE CONTROL: a cross-surface READ with no grant threaded in is still refused",
  );
  ok(rows[0]?.action === "read.refused", "…and it is audited as a read, not a write");

  let readErr: unknown;
  try {
    await assertLinearIssueAllowed(slackPay, ISSUE_SIBLING, GRANTED_DOMAINS, issueResolver, { audit });
  } catch (e) {
    readErr = e;
  }
  ok((readErr as Error).message.includes('credential: "workspace"'), "🔴 the READ refusal NOW names the work credential remedy — the read tool can honour one");

  rows.length = 0;
  let walledReadErr: unknown;
  try {
    await assertLinearIssueAllowed(slackPay, ISSUE_ENG, GRANTED_DOMAINS, issueResolver, { audit, workOrg: ORG });
  } catch (e) {
    walledReadErr = e;
  }
  ok(rows[0]?.detail?.reason === "cross-domain", "even a granted READ caller cannot cross into another domain's issue");
  ok(!(walledReadErr as Error).message.includes('credential: "workspace"'), "NEGATIVE CONTROL: a granted READ caller is NOT told to add a grant it already holds");
}

{
  const fromSlack = (issue: string, team: string | undefined, workOrg?: string) => linearIssueScope(SLACK_PAY, [], issue, team, DOMAINS, workOrg);

  ok(!fromSlack(ISSUE_SIBLING, TEAM_PAY).allowed, "no grant ⇒ a Slack caller reaches no Linear issue");
  ok(fromSlack(ISSUE_SIBLING, TEAM_PAY).reason === "target-unresolvable", "…with the unchanged reason");

  const granted = fromSlack(ISSUE_SIBLING, TEAM_PAY, ORG);
  ok(granted.allowed && granted.reason === "work-grant", "the grant admits it, and the verdict SAYS which authority let it through");
  ok(granted.targetTeam === TEAM_PAY && granted.callerDomain === "payments", "…recording the team and the caller's domain for the audit row");

  ok(fromSlack(ISSUE_LOOSE, TEAM_LOOSE, ORG).allowed, "a team in NO domain is reached by the grant — the credential's reach IS the boundary");
  ok(!fromSlack(ISSUE_ENG, TEAM_ENG, ORG).allowed && fromSlack(ISSUE_ENG, TEAM_ENG, ORG).reason === "cross-domain", "a team ANOTHER domain owns is refused, grant or no grant");
  ok(!fromSlack(ISSUE_GHOST, undefined, ORG).allowed, "an issue whose team could not be established is refused even under a grant (fail closed)");
  ok(!linearIssueScope("slack/T1/CNOWHERE", [], ISSUE_SIBLING, TEAM_PAY, DOMAINS, ORG).allowed, "a caller in NO domain is refused first, grant or no grant");

  ok(linearIssueScope(keyFor(ORG, TEAM_PAY), [], ISSUE_SIBLING, TEAM_PAY, DOMAINS, ORG2).reason === "roster", "a Linear caller still resolves through its OWN key, not the grant");
  ok(!linearIssueScope(keyFor(ORG, TEAM_PAY), [], ISSUE_ENG, TEAM_ENG, DOMAINS, ORG).allowed, "…and a grant cannot widen it past the cross-domain wall");
}

{
  const slackPay = {
    channel: { kind: "slack" },
    session: { auth: { current: { attributes: { team_id: "T1", channel_id: "CPAY", channel_type: "channel" }, principalId: "U_SLACK", principalType: "slack-user" } } },
  } as BindableContext;

  const withDomains = (domains: readonly Domain[]): void =>
    registerConfig({
      loadBundles: () => [],
      loadBindings: () => [],
      pluginRegistry: {},
      skillContent: {},
      loadDomains: () => domains,
      loadSilos: () => [],
      domainsForSurface: ({ workspaceKey, surface }) => {
        const key = `${workspaceKey}/${surface}`;
        return domains.filter((d) => (d.reach ?? []).includes(key)).map((d) => d.name);
      },
    });

  withDomains(DOMAINS);
  await assert.rejects(
    () => linearEntityAdapter.checkAccess!(slackPay, ISSUE_SIBLING, DOMAINS) as Promise<void>,
    ChannelScopeError,
    "the entity adapter refuses a cross-surface mutation when the domain declares no Linear work credential",
  );
  ok(linearEntityAdapter.workspaceFor?.(slackPay) === undefined, "…and names no workspace, so nothing downstream picks a credential");

  withDomains(GRANTED_DOMAINS);
  ok(linearEntityAdapter.workspaceFor?.(slackPay) === ORG, "🔴 THE FIX: with the grant the entity adapter names the workspace the mutation runs under");
}

{
  const slackPay = {
    channel: { kind: "slack" },
    session: { auth: { current: { attributes: { team_id: "T1", channel_id: "CPAY", channel_type: "channel" }, principalId: "U_SLACK", principalType: "slack-user" } } },
  } as BindableContext;

  const withDomains = (domains: readonly Domain[]): void =>
    registerConfig({
      loadBundles: () => [],
      loadBindings: () => [],
      pluginRegistry: {},
      skillContent: {},
      loadDomains: () => domains,
      loadSilos: () => [],
      domainsForSurface: ({ workspaceKey, surface }) => {
        const key = `${workspaceKey}/${surface}`;
        return domains.filter((d) => (d.reach ?? []).includes(key)).map((d) => d.name);
      },
    });

  const TEAM_UUID = "aaaaaaaa-1111-4111-8111-111111111111";

  withDomains(DOMAINS);
  await assert.rejects(
    () => linearTicketCreateAdapter.checkAccess!(slackPay, TEAM_UUID, DOMAINS) as Promise<void>,
    ChannelScopeError,
    "the create adapter refuses a cross-surface filing when the domain declares no Linear work credential",
  );
  ok(linearTicketCreateAdapter.workspaceFor?.(slackPay) === undefined, "…and names no workspace, so nothing downstream picks a credential");

  withDomains(GRANTED_DOMAINS);
  ok(linearWorkOrg(slackPay) === ORG, "the adapter resolves the caller's domain and reads its declared Linear work credential");
  ok(linearTicketCreateAdapter.workspaceFor?.(slackPay) === ORG, "with the grant the adapter names the destination workspace — the frozen credential selector");
  const admitted = await Promise.resolve(linearTicketCreateAdapter.checkAccess!(slackPay, TEAM_UUID, GRANTED_DOMAINS)).then(
    () => true,
    () => false,
  );
  ok(admitted, "the ADAPTER admits the granted cross-surface filing — the grant really is fed to the fence");

  await assert.rejects(
    () => linearTicketCreateAdapter.checkAccess!(slackPay, TEAM_ENG, GRANTED_DOMAINS) as Promise<void>,
    ChannelScopeError,
    "…and a team another domain owns is still refused, grant or no grant",
  );
}

console.log(`✓ ${passed} linear write-scope assertions passed`);
