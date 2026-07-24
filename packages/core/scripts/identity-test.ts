import { bindFrom, bindBridged, registerIdentityMapper, slackMode, slackVisibility, slackTrust, linearVisibility, linearTrust, type BindableContext, type IdentityMapper } from "../agent/identity/binding.js";
import { normalizePlatform } from "../agent/identity/platform.js";
import { readBindingBridge, stampBindingBridge, bridgedContext } from "../agent/identity/binding-bridge.js";
import { teamsTrust } from "../agent/channels/teams-identity.js";
import { resolvePartition } from "../agent/memory/partition.js";
import {
  buildSlackAuth,
  channelFactsFromInfo,
  channelFactsFromRaw,
  partnerFactsFromInfo,
} from "../agent/channels/slack-identity.js";
import { buildLinearAuth, teamFactsFromTeam, userGuestFromUser } from "../agent/channels/linear-identity.js";
import { enrichTeamPrivacy } from "../agent/channels/linear.js";
import { buildGitHubAuth, githubBotMentioned, githubVisibility, githubTrust } from "../agent/channels/github-identity.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

for (const k of [
  "OE_PLATFORM", "OE_WORKSPACE", "OE_SURFACE", "OE_CHANNEL", "OE_MODE", "OE_VISIBILITY", "OE_PRINCIPAL", "OE_TRUST",
  "LINEAR_AGENT_ACCESS_TOKEN", "LINEAR_ACCESS_TOKEN", "LINEAR_API_KEY", "LINEAR_API_TOKEN",
  "LINEAR_CLIENT_ID", "LINEAR_CLIENT_SECRET",
]) {
  delete process.env[k];
}

function slackCtx(attributes: Record<string, string>, principalId?: string): BindableContext {
  return {
    channel: { kind: "slack" },
    session: { auth: { current: { attributes, principalId: principalId ?? "", principalType: "slack-user" } } },
  };
}

ok(slackMode("im", undefined) === "dm", "channel_type im -> dm");
ok(slackMode("mpim", undefined) === "mpim", "channel_type mpim -> mpim");
ok(slackMode("channel", undefined) === "channel", "channel_type channel -> channel");
ok(slackMode("group", undefined) === "channel", "channel_type group -> channel");
ok(slackMode(undefined, "D0815") === "dm", "id prefix D -> dm when type unknown");
ok(slackMode(undefined, "C0815") === "channel", "id prefix C -> channel when type unknown");

ok(slackVisibility("channel", "false", "channel") === "public", "explicit is_private=false -> public");
ok(slackVisibility("group", "true", "channel") === "private", "explicit is_private=true -> private");
ok(slackVisibility(undefined, undefined, "dm") === "private", "dm is never public");
ok(slackVisibility(undefined, undefined, "mpim") === "private", "mpim is never public");
ok(slackVisibility("channel", undefined, "channel") === "public", "typed public channel -> public");
ok(slackVisibility(undefined, undefined, "channel") === "private", "FAIL-CLOSED: unknown -> private");

const pub = bindFrom(slackCtx({ team_id: "T1", channel_id: "C9", channel_type: "channel", is_private: "false", user_id: "U7" }));
ok(pub.platform === "slack" && pub.workspace === "T1" && pub.surface === "C9", "slack: platform/workspace/surface from attributes");
ok(pub.mode === "channel" && pub.visibility === "public", "slack public channel -> channel/public");
ok(pub.principalId === "U7", "slack: principalId from user_id attribute");
ok(JSON.stringify(pub.target) === JSON.stringify({ channelId: "C9" }), "slack: post-back target is { channelId }");
ok(pub.threadTs === undefined, "slack: no thread_ts attribute -> binding.threadTs undefined");
ok(pub.domainSurface === undefined, "slack: domainSurface never set (thread grain == channel grain on Slack)");

const threaded = bindFrom(slackCtx({ team_id: "T1", channel_id: "C9", channel_type: "channel", is_private: "false", user_id: "U7", thread_ts: "1751.0042" }));
ok(threaded.threadTs === "1751.0042", "slack: thread_ts attribute -> binding.threadTs (unsanitized, dot intact)");
ok(JSON.stringify(threaded.target) === JSON.stringify({ channelId: "C9" }), "slack: threadTs does NOT leak into the post-back target (routines post fresh messages)");

const nsPub = bindFrom({
  channel: { kind: "channel:slack" },
  session: {
    auth: {
      current: {
        attributes: { team_id: "T1", channel_id: "C9", channel_type: "channel", is_private: "false", is_ext_shared: "false", trust_checked: "true", user_id: "U7" },
        principalId: "",
        principalType: "slack-user",
      },
    },
  },
});
ok(nsPub.platform === "slack" && nsPub.workspace === "T1" && nsPub.surface === "C9", "slack namespaced kind 'channel:slack' -> Slack mapper still runs (platform/workspace/surface, not dev/default)");
ok(nsPub.trust === "internal" && nsPub.visibility === "public", "slack namespaced kind: internal channel -> trust=internal (not fail-closed external)");

const priv = bindFrom(slackCtx({ team_id: "T1", channel_id: "G2", channel_type: "group", is_private: "true", user_id: "U7" }));
ok(priv.mode === "channel" && priv.visibility === "private", "slack private channel -> channel/private");

const dm = bindFrom(slackCtx({ team_id: "T1", channel_id: "D3", channel_type: "im", user_id: "U7" }, "U7"));
ok(dm.mode === "dm" && dm.visibility === "private", "slack im -> dm/private");
ok(dm.principalId === "U7", "slack: principalId prefers auth.principalId");

const dmResume = bindFrom(slackCtx({ team_id: "T1", channel_id: "D3", channel_type: "im", user_id: "U7" }, "slack:T1:U7"));
ok(dmResume.principalId === "U7", "slack: composite auth principalId (slack:T:U) collapses to the raw user id");
const dmResumeNoAttr = bindFrom(slackCtx({ team_id: "T1", channel_id: "D3", channel_type: "im" }, "slack:T1:U7"));
ok(dmResumeNoAttr.principalId === "U7", "slack: composite collapses even with no user_id attribute to fall back on");

const mpim = bindFrom(slackCtx({ team_id: "T1", channel_id: "C4", channel_type: "mpim", user_id: "U7" }));
ok(mpim.mode === "mpim" && mpim.visibility === "private", "slack mpim -> mpim/private");

const unknown = bindFrom(slackCtx({ team_id: "T1", channel_id: "C5", user_id: "U7" }));
ok(unknown.mode === "channel" && unknown.visibility === "private", "slack unknown facts -> channel + FAIL-CLOSED private");

const part = resolvePartition(slackCtx({ team_id: "T1", channel_id: "C9", channel_type: "channel", is_private: "false", user_id: "U7" }));
ok(part.surfaceKey === "slack/T1/C9", "partition surfaceKey derives from slack binding");

const orgCtx = slackCtx({ team_id: "T1", channel_id: "C9", channel_type: "channel", is_private: "false" });
delete process.env.OE_ORG;
ok(resolvePartition(orgCtx).org === "default", "partition.org defaults to 'default' when OE_ORG unset");
process.env.OE_ORG = "acme-inc";
const orgPart = resolvePartition(orgCtx);
ok(orgPart.org === "acme-inc", "partition.org threads from OE_ORG");
ok(orgPart.surfaceKey === "slack/T1/C9", "org is kept out of surfaceKey (org-portable tier keys)");
delete process.env.OE_ORG;

process.env.OE_WORKSPACE = "acme";
process.env.OE_SURFACE = "alpha";
process.env.OE_MODE = "dm";
process.env.OE_VISIBILITY = "private";
const local = bindFrom({});
ok(local.platform === "local" && local.workspace === "acme" && local.surface === "alpha", "local: identity from OE_* env");
ok(local.mode === "dm" && local.visibility === "private", "local: mode/visibility from env");
ok(local.target === undefined, "local: no post-back target");
delete process.env.OE_SURFACE;
delete process.env.OE_CHANNEL;
const defaults = bindFrom({ channel: { kind: "local" } });
ok(defaults.surface === "default", "local: surface defaults when env unset for that field");

const auth = buildSlackAuth({ userId: "U7", teamId: "T1", channelId: "C9", threadTs: "169.1", channelType: "channel", isPrivate: false });
ok(auth.authenticator === "slack" && auth.principalId === "U7" && auth.principalType === "slack-user", "buildSlackAuth: principal fields");
ok(auth.attributes.is_private === "false" && auth.attributes.channel_type === "channel", "buildSlackAuth: facts captured as strings");
const sparse = buildSlackAuth({ userId: "U7", channelId: "C9" });
ok(sparse.attributes.is_private === undefined && sparse.attributes.team_id === undefined, "buildSlackAuth: omits unknown facts (no false claims)");

ok(channelFactsFromRaw({ channel_type: "mpim" }).channelType === "mpim", "channelFactsFromRaw reads channel_type");
ok(channelFactsFromRaw({}).channelType === undefined, "channelFactsFromRaw: absent type stays undefined");
ok(channelFactsFromInfo({ channel: { is_private: true, is_group: true } }).isPrivate === true, "channelFactsFromInfo: is_private");
ok(channelFactsFromInfo({ channel: { is_im: true } }).channelType === "im", "channelFactsFromInfo: is_im -> im");
ok(channelFactsFromInfo({ channel: { is_channel: true, is_private: false } }).channelType === "channel", "channelFactsFromInfo: is_channel -> channel");
ok(JSON.stringify(channelFactsFromInfo(null)) === "{}", "channelFactsFromInfo: defensive on junk");

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
ok(JSON.stringify(lin.target) === JSON.stringify({ agentSessionId: "AS1" }), "linear: post-back target is the agent session (NOT the surface key)");

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

function githubCtx(attributes: Record<string, string>, principalId?: string): BindableContext {
  return {
    channel: { kind: "github" },
    session: { auth: { current: { attributes, principalId: principalId ?? "", principalType: "github-user" } } },
  };
}

ok(githubVisibility("false") === "public", "github: repo_private=false -> public");
ok(githubVisibility("true") === "private", "github: repo_private=true -> private");
ok(githubVisibility(undefined) === "private", "github: FAIL-CLOSED unknown privacy -> private");

ok(githubTrust("true", "OWNER") === "internal", "githubTrust: private repo + OWNER -> internal");
ok(githubTrust("true", "MEMBER") === "internal", "githubTrust: private repo + MEMBER -> internal");
ok(githubTrust("true", "COLLABORATOR") === undefined, "githubTrust: private repo + COLLABORATOR (maybe outside) -> no verdict (binds external)");
ok(githubTrust("true", "CONTRIBUTOR") === undefined, "githubTrust: private repo + CONTRIBUTOR -> no verdict");
ok(githubTrust("true", "NONE") === undefined, "githubTrust: private repo + NONE -> no verdict");
ok(githubTrust("true", undefined) === undefined, "githubTrust: FAIL-CLOSED missing association -> no verdict");
ok(githubTrust("false", "OWNER") === undefined, "githubTrust: PUBLIC repo -> no verdict even for OWNER (world-readable, external contributors)");
ok(githubTrust(undefined, "OWNER") === undefined, "githubTrust: FAIL-CLOSED unknown privacy -> no verdict");

ok(githubBotMentioned("hey @my-bot please look", "my-bot", { login: "alice", type: "User" }), "github mention: @bot in body -> wake");
ok(!githubBotMentioned("hey @my-botanist", "my-bot", { login: "alice", type: "User" }), "github mention: @my-botanist is NOT @my-bot (word-boundary)");
ok(!githubBotMentioned("no mention here", "my-bot", { login: "alice", type: "User" }), "github mention: no @bot -> no wake");
ok(!githubBotMentioned("@my-bot help", "my-bot", { login: "someone", type: "Bot" }), "github mention: bot author ignored (loop guard)");
ok(!githubBotMentioned("@my-bot help", "my-bot", { login: "my-bot[bot]", type: "User" }), "github mention: the bot's own comment ignored");
ok(!githubBotMentioned("@my-bot <!-- eve:github: x -->", "my-bot", { login: "alice", type: "User" }), "github mention: eve marker comment ignored");
ok(!githubBotMentioned("@my-bot help", undefined, { login: "alice", type: "User" }), "github mention: no botName -> no wake");
ok(githubBotMentioned("@My-Bot hi", "my-bot", undefined), "github mention: case-insensitive + undefined author tolerated");

const ghPriv = bindFrom(githubCtx({ owner: "acme", repo: "widgets", repo_private: "true", conversation_kind: "issue", issue_number: "7", author_association: "OWNER", user_login: "octo", user_id: "42" }, "octo"));
ok(ghPriv.platform === "github" && ghPriv.workspace === "acme" && ghPriv.surface === "widgets", "github: workspace=owner, surface=repo (issue is the anchor, not the silo)");
ok(ghPriv.mode === "channel", "github: sessions are channel-mode (no DM analog)");
ok(ghPriv.visibility === "private" && ghPriv.trust === "internal", "github: private repo + OWNER -> private/internal");
ok(ghPriv.principalId === "octo", "github: principalId from auth principal / user_login");
ok(JSON.stringify(ghPriv.target) === JSON.stringify({ owner: "acme", repo: "widgets", issueNumber: 7 }), "github: issue post-back target = { owner, repo, issueNumber }");

const ghPub = bindFrom(githubCtx({ owner: "acme", repo: "oss", repo_private: "false", conversation_kind: "pull_request", pull_request_number: "12", author_association: "OWNER", user_login: "octo" }));
ok(ghPub.visibility === "public", "github: public repo -> visibility public");
ok(ghPub.trust === "external", "github: public repo -> trust fails closed to external (world-readable)");
ok(JSON.stringify(ghPub.target) === JSON.stringify({ owner: "acme", repo: "oss", pullRequestNumber: 12 }), "github: PR post-back target = { owner, repo, pullRequestNumber }");

const ghReview = bindFrom(githubCtx({ owner: "acme", repo: "widgets", repo_private: "true", conversation_kind: "review_thread", pull_request_number: "9", issue_number: "9", author_association: "MEMBER", user_login: "rev" }));
ok(JSON.stringify(ghReview.target) === JSON.stringify({ owner: "acme", repo: "widgets", pullRequestNumber: 9 }), "github: review_thread anchors to pullRequestNumber (not issueNumber)");

const ghA = bindFrom(githubCtx({ owner: "acme", repo: "widgets", issue_number: "1", user_login: "u" }));
const ghB = bindFrom(githubCtx({ owner: "acme", repo: "widgets", issue_number: "2", user_login: "u" }));
ok(ghA.surface === ghB.surface && ghA.surface === "widgets", "github: distinct issues in one repo share the repo surface silo");

const ghUnknown = bindFrom(githubCtx({ owner: "acme", repo: "widgets", conversation_kind: "issue", issue_number: "3", user_login: "stranger", author_association: "NONE" }));
ok(ghUnknown.visibility === "private" && ghUnknown.trust === "external", "github: unknown repo privacy -> FAIL-CLOSED private/external");

const ghPart = resolvePartition(githubCtx({ owner: "acme", repo: "widgets", issue_number: "7", user_login: "u" }));
ok(ghPart.surfaceKey === "github/acme/widgets", "github: partition surfaceKey = platform/owner/repo");

const ga = buildGitHubAuth({ owner: "acme", repo: "widgets", repositoryFullName: "acme/widgets", repositoryId: 5, isPrivate: true, conversationKind: "issue", issueNumber: 7, installationId: 99, actorLogin: "octo", actorId: 42, actorType: "User", authorAssociation: "OWNER" });
ok(ga.authenticator === "github" && ga.principalId === "octo" && ga.principalType === "github-user", "buildGitHubAuth: principal fields");
ok(ga.attributes.owner === "acme" && ga.attributes.repo === "widgets" && ga.attributes.repo_private === "true" && ga.attributes.author_association === "OWNER" && ga.attributes.issue_number === "7", "buildGitHubAuth: facts captured as strings");
const gaBot = buildGitHubAuth({ owner: "acme", repo: "widgets", actorLogin: "dependabot[bot]", actorType: "Bot" });
ok(gaBot.principalType === "service", "buildGitHubAuth: Bot actor -> service principal");
const gaSparse = buildGitHubAuth({ owner: "acme", repo: "widgets", actorLogin: "u" });
ok(gaSparse.attributes.repo_private === undefined && gaSparse.attributes.issue_number === undefined && gaSparse.attributes.author_association === undefined, "buildGitHubAuth: omits unknown facts (no false claims)");
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

ok(slackTrust("true", "true", "channel") === "external", "slackTrust: is_ext_shared=true -> external");
ok(slackTrust("false", "true", "channel") === "internal", "slackTrust: checked + not shared -> internal");
ok(slackTrust(undefined, undefined, "channel") === "external", "slackTrust: FAIL-CLOSED never checked -> external");
ok(slackTrust("false", undefined, "channel") === "external", "slackTrust: FAIL-CLOSED check absent even if flag false -> external");
ok(slackTrust(undefined, undefined, "dm") === "internal", "slackTrust: dm is a personal silo -> internal (gate N/A)");
ok(slackTrust("true", "true", "mpim") === "internal", "slackTrust: mpim is a personal silo -> internal (gate N/A)");

ok(channelFactsFromInfo({ channel: { is_channel: true, is_ext_shared: true } }).isExternal === true, "factsFromInfo: is_ext_shared -> isExternal true");
ok(channelFactsFromInfo({ channel: { is_channel: true, is_org_shared: true } }).isExternal === true, "factsFromInfo: is_org_shared -> isExternal true");
ok(channelFactsFromInfo({ channel: { is_channel: true } }).isExternal === false, "factsFromInfo: no shared flags -> isExternal false");
ok(channelFactsFromInfo({ channel: { is_channel: true } }).trustChecked === true, "factsFromInfo: successful fetch -> trustChecked true");
ok(channelFactsFromInfo(null).trustChecked === undefined, "factsFromInfo: empty info -> trustChecked undefined (fetch failed)");

ok(teamsTrust("channel", "shared", "channel", "TEN") === "external", "teamsTrust: shared channel -> external");
ok(teamsTrust("channel", "standard", "channel", "TEN") === "internal", "teamsTrust: standard channel + tenant -> internal");
ok(teamsTrust("channel", "private", "channel", "TEN") === "internal", "teamsTrust: private channel + tenant -> internal");
ok(teamsTrust("channel", undefined, "channel", "TEN") === undefined, "teamsTrust: FAIL-CLOSED unknown membership -> no verdict (binds external)");
ok(teamsTrust("channel", "standard", "channel", undefined) === undefined, "teamsTrust: FAIL-CLOSED missing tenant -> no verdict (binds external)");
ok(teamsTrust("personal", undefined, "dm", "TEN") === "internal", "teamsTrust: personal chat -> internal (gate N/A; bindFrom's DM-partner gate still applies)");

const trExt = bindFrom(slackCtx({ team_id: "T", channel_id: "CEXT", channel_type: "channel", is_ext_shared: "true", trust_checked: "true" }));
ok(trExt.trust === "external", "bindFrom: slack ext-shared channel binds external");
const trInt = bindFrom(slackCtx({ team_id: "T", channel_id: "CINT", channel_type: "channel", is_ext_shared: "false", trust_checked: "true" }));
ok(trInt.trust === "internal", "bindFrom: slack checked-internal channel binds internal");
const trUnchecked = bindFrom(slackCtx({ team_id: "T", channel_id: "CUNK", channel_type: "channel" }));
ok(trUnchecked.trust === "external", "bindFrom: slack channel with no trust check binds external (fail closed)");

ok(bindFrom({}).trust === "internal", "bindFrom: local/dev defaults internal");
process.env.OE_TRUST = "external";
ok(bindFrom({}).trust === "external", "bindFrom: OE_TRUST=external forces external (gate testing)");
delete process.env.OE_TRUST;
ok(bindFrom({ channel: { kind: "myspace" } }).trust === "external", "bindFrom: unknown platform fails closed to external");

ok(partnerFactsFromInfo({ user: { team_id: "T", is_restricted: false } }, "T").dmPartnerTrust === "internal", "partnerFacts: full member of the workspace -> internal");
ok(partnerFactsFromInfo({ user: { team_id: "T", is_restricted: true } }, "T").dmPartnerTrust === "external", "partnerFacts: multi-channel guest (restricted) -> external");
ok(partnerFactsFromInfo({ user: { team_id: "T", is_ultra_restricted: true } }, "T").dmPartnerTrust === "external", "partnerFacts: single-channel guest (ultra_restricted) -> external");
ok(partnerFactsFromInfo({ user: { team_id: "T", is_stranger: true } }, "T").dmPartnerTrust === "external", "partnerFacts: Connect stranger -> external");
ok(partnerFactsFromInfo({ user: { team_id: "T2" } }, "T").dmPartnerTrust === "external", "partnerFacts: different workspace -> external");
ok(partnerFactsFromInfo({ user: { team_id: "T", is_bot: true } }, "T").dmPartnerTrust === "external", "partnerFacts: bot account -> external");
ok(partnerFactsFromInfo(null, "T").dmPartnerTrust === "external", "partnerFacts: failed/empty lookup -> external (fail closed)");

ok(buildSlackAuth({ userId: "U", channelId: "D", channelType: "im", dmPartnerTrust: "internal" }).attributes.dm_partner_trust === "internal", "buildSlackAuth: dm_partner_trust stowed");
ok(buildSlackAuth({ userId: "U", channelId: "D", channelType: "im" }).attributes.dm_partner_trust === undefined, "buildSlackAuth: no dm_partner_trust attribute when unverified");

const dmVerifiedInt = slackCtx({ team_id: "T", channel_id: "Duser", channel_type: "im", dm_partner_trust: "internal" });
ok(bindFrom(dmVerifiedInt).trust === "internal", "bindFrom: VERIFIED-internal Slack DM partner → internal (dm shared layer lit up)");
const dmVerifiedExt = slackCtx({ team_id: "T", channel_id: "Duser", channel_type: "im", dm_partner_trust: "external" });
ok(bindFrom(dmVerifiedExt).trust === "external", "bindFrom: VERIFIED-external Slack DM partner → external (routes to public)");
const dmUnverified = slackCtx({ team_id: "T", channel_id: "Duser", channel_type: "im", is_ext_shared: "false", trust_checked: "true" });
ok(bindFrom(dmUnverified).trust === "external", "bindFrom: UNVERIFIED Slack DM partner fails closed to external");
process.env.OE_TRUST = "internal";
ok(bindFrom(dmUnverified).trust === "internal", "bindFrom: OE_TRUST=internal vouches for an unverified DM partner (dev/test)");
delete process.env.OE_TRUST;
process.env.OE_MODE = "dm";
ok(bindFrom({}).trust === "internal", "bindFrom: local/dev DM stays internal (platform-exempt)");
delete process.env.OE_MODE;

ok(readBindingBridge() === null, "binding-bridge: read outside a session context → null (fail-soft)");
stampBindingBridge(slackCtx({ team_id: "T", channel_id: "C" }));
ok(readBindingBridge() === null, "binding-bridge: stamp outside a session context is a no-op");
const bridged = bindFrom(
  bridgedContext({
    platform: "slack",
    principalId: "U1",
    principalType: "slack-user",
    attributes: { team_id: "T9", channel_id: "C9", channel_type: "channel", is_ext_shared: "false", trust_checked: "true" },
  }),
);
ok(bridged.workspace === "T9" && bridged.surface === "C9" && bridged.trust === "internal" && bridged.principalId === "U1",
  "binding-bridge: a stamped identity reconstitutes the full binding (ids + trust + principal)");
const bridgedSlug = bindFrom(
  bridgedContext({
    platform: "discord-gateway",
    principalId: "U_dg",
    principalType: "discord-user",
    attributes: { guild_id: "G7", channel_id: "C7", channel_type: "0", user_id: "U_dg" },
  }),
);
ok(bridgedSlug.platform === "discord" && bridgedSlug.workspace === "G7" && bridgedSlug.surface === "C7",
  "binding-bridge: a channel-slug platform stamp ('discord-gateway') normalizes to the discord mapper");

const uniHop = bindBridged({
  platform: "unified",
  principalId: "U1",
  principalType: "slack-user",
  attributes: { oe_platform: "slack", team_id: "T9", channel_id: "C9", channel_type: "channel", is_ext_shared: "false", trust_checked: "true" },
});
ok(uniHop.platform === "slack" && uniHop.raw.workspace === "T9" && uniHop.raw.surface === "C9" && uniHop.raw.trust === "internal",
  "binding-bridge: a unified stamp WITH oe_platform hops to the ORIGIN (slack) mapper → real partition + internal trust (memory WRITE no longer fails closed)");
const uniBind = bindFrom(bridgedContext({
  platform: "unified",
  principalId: "U1",
  principalType: "slack-user",
  attributes: { oe_platform: "slack", team_id: "T9", channel_id: "C9", channel_type: "channel", is_ext_shared: "false", trust_checked: "true" },
}));
ok(uniBind.platform === "slack" && uniBind.workspace === "T9" && uniBind.surface === "C9" && uniBind.trust === "internal",
  "binding-bridge: bindFrom on a unified+oe_platform stamp resolves the real Slack partition, internal trust");
const uniNoStamp = bindBridged({
  platform: "unified",
  principalId: "U1",
  principalType: "slack-user",
  attributes: { team_id: "T9", channel_id: "C9", channel_type: "channel", is_ext_shared: "false", trust_checked: "true" },
});
ok(uniNoStamp.platform === "unified",
  "binding-bridge: a unified stamp WITHOUT oe_platform stays 'unified' — no origin to hop to, so no surface mapper resolves (falls to the env stand-in → bindFrom fails it closed to external, asserted below)");
ok(bindFrom(bridgedContext({
  platform: "unified",
  principalId: "U1",
  principalType: "slack-user",
  attributes: { team_id: "T9", channel_id: "C9", channel_type: "channel", is_ext_shared: "false", trust_checked: "true" },
})).trust === "external",
  "binding-bridge: bindFrom on a unified stamp WITHOUT oe_platform fails closed to external (no origin recovered)");

ok(normalizePlatform("slack-qabot") === "slack", "platform: slack-* slug collapses via the prefix rule");
ok(normalizePlatform("discord-databot") === "discord", "platform: discord-* slug collapses via the prefix rule");
ok(normalizePlatform("teams-support") === "teams", "platform: teams-* slug collapses via the prefix rule");
ok(normalizePlatform("discord-gateway") === "discord", "platform: the explicit alias still wins (map before prefix)");
ok(normalizePlatform("slack") === "slack", "platform: a bare platform passes through unchanged");
ok(normalizePlatform("slackish") === "slackish", "platform: prefix rule needs the hyphen — no substring false-positives");
ok(normalizePlatform("linear-bot") === "linear", "platform: linear-* slug collapses via the prefix rule");

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

const fakeMapper: IdentityMapper = (ctx) => {
  const a = ctx.session?.auth?.current?.attributes;
  const ws = a?.["ws"];
  const sfc = a?.["sfc"];
  return {
    workspace: typeof ws === "string" ? ws : "WSX",
    surface: typeof sfc === "string" ? sfc : "SFX",
    mode: "channel",
    trust: "internal",
  };
};
registerIdentityMapper("regtest", fakeMapper);
const reg = bindFrom({ channel: { kind: "regtest" }, session: { auth: { current: { attributes: { ws: "WSX", sfc: "SFX" } } } } });
ok(
  reg.platform === "regtest" && reg.workspace === "WSX" && reg.surface === "SFX" && reg.trust === "internal",
  "register seam: a mapper registered via registerIdentityMapper is resolvable by bindFrom",
);
ok(
  bindFrom({ channel: { kind: "neverregistered" } }).trust === "external",
  "register seam: an unregistered platform still falls through to bindLocal + fail-closed external",
);

console.log(`✓ identity: ${passed} assertions passed`);
