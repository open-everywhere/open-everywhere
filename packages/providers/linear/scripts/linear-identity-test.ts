import {
  buildLinearAuth,
  teamFactsFromTeam,
  userGuestFromUser,
  linearAuthorFacts,
  linearVisibility,
  linearTrust,
} from "../agent/channels/linear-identity.js";
import { enrichTeamPrivacy } from "../agent/channels/linear.js";
import { bindFrom, resolvePartition, type BindableContext } from "@open-everywhere/core/agent/adapter-api.js";
import { registerLinearProvider } from "../agent/register.js";
import { _resetDeploymentIdentityForTest } from "@open-everywhere/core/agent/adapter-api.js";

registerLinearProvider();

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

_resetDeploymentIdentityForTest();
for (const k of [
  "OE_PLATFORM", "OE_MODE", "OE_VISIBILITY", "OE_PRINCIPAL", "OE_TRUST",
  "LINEAR_AGENT_ACCESS_TOKEN", "LINEAR_ACCESS_TOKEN", "LINEAR_API_KEY", "LINEAR_API_TOKEN",
  "LINEAR_CLIENT_ID", "LINEAR_CLIENT_SECRET",
]) {
  delete process.env[k];
}

function linearCtx(attributes: Record<string, string>, principalId?: string): BindableContext {
  return {
    channel: { kind: "linear" },
    session: { auth: { current: { attributes, principalId: principalId ?? "", principalType: "linear-user" } } },
  };
}

ok(linearVisibility("false") === "public", "linear: is_private=false -> public");
ok(linearVisibility("true") === "private", "linear: is_private=true -> private");
ok(linearVisibility(undefined) === "private", "linear: FAIL-CLOSED unknown privacy -> private");

const lin = bindFrom(linearCtx({ organization_id: "ORG1", team_id: "TEAM5", issue_id: "ISS9", issue_identifier: "ENG-9", agent_session_id: "AS1", creator_id: "LU3" }));
ok(lin.platform === "linear" && lin.workspace === "ORG1" && lin.surface === "TEAM5", "linear: workspace=org, surface=TEAM (issue is too granular a silo)");
ok(lin.mode === "channel", "linear: agent sessions are channel-mode (no DM analog)");
ok(lin.visibility === "private", "linear: no privacy signal -> fail-closed private");
ok(lin.principalId === "LU3", "linear: principalId from creator_id");
ok(lin.target?.agentSessionId === "AS1", "linear: post-back target carries the agent session (NOT the surface key)");
ok(lin.target?.issueId === "ISS9", "🔴 OPE-811: it ALSO carries the issue anchor — the ambient reply route's target");
ok(lin.target?.organizationId === "ORG1", "🔴 OPE-875: the post-back target carries the WORKSPACE — the arm's credential selector, not an anchor");
{
  const ambient = bindFrom(linearCtx({ organization_id: "ORG1", team_id: "TEAM5", issue_id: "ISS9", comment_id: "C1" }));
  ok(ambient.target?.agentSessionId === undefined, "OPE-811: a supervisor delivery binds NO agent session (there is none)");
  ok(ambient.target?.issueId === "ISS9" && ambient.target?.parentId === "C1", "🔴 OPE-811: …and still binds a postable ambient target — issue + the trigger's own thread root");
  const threaded = bindFrom(linearCtx({ organization_id: "ORG1", team_id: "TEAM5", issue_id: "ISS9", comment_id: "C2", parent_comment_id: "C_ROOT" }));
  ok(threaded.target?.parentId === "C_ROOT", "OPE-811: a THREADED trigger anchors on the SAME thread root, not the reply comment");
  const noOrg = bindFrom(linearCtx({ team_id: "TEAM5", issue_id: "ISS9", comment_id: "C1" }));
  ok(noOrg.target?.organizationId === undefined, "OPE-875 NEGATIVE CONTROL: no organization on the delivery ⇒ NO workspace on the target (the primary chain, unchanged)");
  const orgOnly = bindFrom(linearCtx({ organization_id: "ORG1", team_id: "TEAM5" }));
  ok(orgOnly.target === undefined, "OPE-875 NEGATIVE CONTROL: a workspace with NO session and NO issue binds NO target at all");
  const anchorless = bindFrom(linearCtx({ organization_id: "ORG1", team_id: "TEAM5" }));
  ok(anchorless.target === undefined, "OPE-811 negative control: no session AND no issue ⇒ NO target — `reply` refuses rather than guessing a place");
}

const linIssA = bindFrom(linearCtx({ organization_id: "ORG1", team_id: "TEAM5", issue_id: "ISS_A", agent_session_id: "AS_A" }));
const linIssB = bindFrom(linearCtx({ organization_id: "ORG1", team_id: "TEAM5", issue_id: "ISS_B", agent_session_id: "AS_B" }));
ok(linIssA.surface === linIssB.surface && linIssA.surface === "TEAM5", "linear: distinct issues in one team share the team surface silo");

const linNoTeam = bindFrom(linearCtx({ organization_id: "ORG1", issue_id: "ISS9", agent_session_id: "AS2" }));
ok(linNoTeam.surface === "ISS9", "linear: surface falls back to issue when team_id absent");
const linNoIssue = bindFrom(linearCtx({ organization_id: "ORG1", agent_session_id: "AS3" }));
ok(linNoIssue.surface === "AS3", "linear: surface falls back to agent session id when neither team nor issue");

const linPub = bindFrom(linearCtx({ organization_id: "ORG1", issue_id: "ISS9", is_private: "false", agent_session_id: "AS1" }));
ok(linPub.visibility === "public", "linear: explicit team-visible issue -> public");

ok(userGuestFromUser({ guest: true }).guest === true, "userGuestFromUser: guest true");
ok(userGuestFromUser({ guest: false }).guest === false, "userGuestFromUser: guest false (a member)");
ok(userGuestFromUser({}).guest === undefined, "userGuestFromUser: absent guest -> undefined");
ok(userGuestFromUser(null).guest === undefined, "userGuestFromUser: defensive on null (lookup failed)");
ok(linearTrust("true") === "external", "linearTrust: guest -> external (demote, wins over vouch)");
ok(linearTrust("false") === undefined, "linearTrust: member -> no verdict (membership alone isn't internal)");
ok(linearTrust(undefined) === undefined, "linearTrust: unknown -> no verdict (fail toward existing tier)");
process.env.OE_TRUST = "internal";
const linGuest = bindFrom(linearCtx({ organization_id: "ORG1", team_id: "TEAM5", issue_id: "ISS9", guest: "true", agent_session_id: "AS1", creator_id: "LU3" }));
ok(linGuest.trust === "external", "linear: GUEST creator -> demoted to external (overrides OE_TRUST=internal vouch)");
const linMember = bindFrom(linearCtx({ organization_id: "ORG1", team_id: "TEAM5", issue_id: "ISS9", guest: "false", agent_session_id: "AS1", creator_id: "LU3" }));
ok(linMember.trust === "internal", "linear: MEMBER creator -> internal (rides the vouch, unchanged)");
const linUnknownGuest = bindFrom(linearCtx({ organization_id: "ORG1", team_id: "TEAM5", issue_id: "ISS9", agent_session_id: "AS1", creator_id: "LU3" }));
ok(linUnknownGuest.trust === "internal", "linear: UNAVAILABLE guest signal -> vouch stands (fail toward existing tier)");
delete process.env.OE_TRUST;
ok(buildLinearAuth({ agentSessionId: "AS1", principalId: "LU3", guest: true }).attributes.guest === "true", "buildLinearAuth: guest captured as string");
ok(buildLinearAuth({ agentSessionId: "AS1", principalId: "LU3" }).attributes.guest === undefined, "buildLinearAuth: omits guest when unknown");

const linPart = resolvePartition(linearCtx({ organization_id: "ORG1", issue_id: "ISS9", agent_session_id: "AS1" }));
ok(linPart.surfaceKey === "linear/ORG1/ISS9", "linear: partition surfaceKey = platform/org/issue");

const la = buildLinearAuth({ agentSessionId: "AS1", organizationId: "ORG1", teamId: "TEAM5", issueId: "ISS9", issueIdentifier: "ENG-9", principalId: "LU3", isPrivate: false });
ok(la.authenticator === "linear" && la.principalId === "LU3" && la.principalType === "linear-user", "buildLinearAuth: principal fields");
ok(la.attributes.organization_id === "ORG1" && la.attributes.team_id === "TEAM5" && la.attributes.issue_id === "ISS9" && la.attributes.is_private === "false", "buildLinearAuth: facts captured as strings (incl. team_id)");
const laSparse = buildLinearAuth({ agentSessionId: "AS2" });
ok(laSparse.attributes.organization_id === undefined && laSparse.attributes.team_id === undefined && laSparse.attributes.is_private === undefined && laSparse.principalId === "", "buildLinearAuth: omits unknown facts (no false claims)");

ok(teamFactsFromTeam({ team: { private: true } }).isPrivate === true, "teamFactsFromTeam: private team -> true");
ok(teamFactsFromTeam({ team: { private: false } }).isPrivate === false, "teamFactsFromTeam: public team -> false");
ok(teamFactsFromTeam({ team: null }).isPrivate === undefined, "teamFactsFromTeam: null team (unknown/no access) -> undefined");
ok(teamFactsFromTeam({}).isPrivate === undefined, "teamFactsFromTeam: absent team -> undefined");
ok(teamFactsFromTeam(null).isPrivate === undefined, "teamFactsFromTeam: null data -> undefined");
ok(teamFactsFromTeam({ team: { private: "true" } }).isPrivate === undefined, "teamFactsFromTeam: non-boolean private -> undefined (fail closed)");

const laPriv = buildLinearAuth({ agentSessionId: "AS1", organizationId: "ORG1", teamId: "TEAM5", isPrivate: true });
ok(bindFrom(linearCtx(laPriv.attributes)).visibility === "private", "enrich: private team -> visibility private (surface-tier)");
const laPub = buildLinearAuth({ agentSessionId: "AS1", organizationId: "ORG1", teamId: "TEAM5", isPrivate: false });
ok(bindFrom(linearCtx(laPub.attributes)).visibility === "public", "enrich: public team -> visibility public (feeds workspace brain)");

const CREDS = { accessToken: "test-token" } as const;
function fakeFetch(body: unknown, status = 200): typeof fetch {
  return (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
}
const explodingFetch = (async () => {
  throw new Error("network must not be reached when the token is missing");
}) as unknown as typeof fetch;

await (async () => {
  ok(
    (await enrichTeamPrivacy("TEAM5", { api: { fetch: fakeFetch({ data: { team: { private: true } } }) }, credentials: CREDS })) === true,
    "enrichTeamPrivacy: private team -> true",
  );
  ok(
    (await enrichTeamPrivacy("TEAM5", { api: { fetch: fakeFetch({ data: { team: { private: false } } }) }, credentials: CREDS })) === false,
    "enrichTeamPrivacy: public team -> false",
  );
  ok((await enrichTeamPrivacy(undefined, { api: { fetch: explodingFetch }, credentials: CREDS })) === undefined, "enrichTeamPrivacy: no teamId -> undefined (no call)");
  ok(
    (await enrichTeamPrivacy("TEAM5", { api: { fetch: fakeFetch({ data: null }, 500) }, credentials: CREDS })) === undefined,
    "enrichTeamPrivacy: HTTP error -> undefined (fail closed)",
  );
  ok(
    (await enrichTeamPrivacy("TEAM5", { api: { fetch: fakeFetch({ errors: [{ message: "no access" }] }) }, credentials: CREDS })) === undefined,
    "enrichTeamPrivacy: GraphQL errors -> undefined (fail closed)",
  );
  ok(
    (await enrichTeamPrivacy("TEAM5", { api: { fetch: fakeFetch({ data: { team: null } }) }, credentials: CREDS })) === undefined,
    "enrichTeamPrivacy: null team in 200 body -> undefined (fail closed)",
  );
  ok((await enrichTeamPrivacy("TEAM5", { api: { fetch: explodingFetch } })) === undefined, "enrichTeamPrivacy: missing token -> undefined (fail closed, no network)");
})();

ok(linearAuthorFacts(true).refuted === true, "author grain: a workspace GUEST is REFUTED (excluded)");
ok(linearAuthorFacts(false).refuted === undefined, "author grain: a FULL MEMBER is not refuted (internal)");
ok(linearAuthorFacts(undefined).refuted === undefined, "author grain: an UNRESOLVED guest flag does NOT refute (fail open)");
ok(Object.keys(linearAuthorFacts(false)).length === 0, "author grain: a full member carries NO fabricated refutation field");
ok(Object.keys(linearAuthorFacts(undefined)).length === 0, "author grain: an unresolved probe carries NO fabricated refutation field");
ok(
  linearAuthorFacts(userGuestFromUser({ guest: true }).guest).refuted === true &&
    linearTrust(String(userGuestFromUser({ guest: true }).guest)) === "external",
  "author grain: the guest flag drives BOTH the author grain and the OPE-60 memory demotion",
);

console.log(`\n✓ linear-identity: ${passed} assertions passed`);
