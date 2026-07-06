import { bindFrom, slackMode, slackVisibility, slackTrust, linearVisibility, type BindableContext } from "../agent/identity/binding.js";
import { readBindingBridge, stampBindingBridge, bridgedContext } from "../agent/identity/binding-bridge.js";
import { teamsTrust } from "../agent/channels/teams-identity.js";
import { resolvePartition } from "../agent/memory/partition.js";
import {
  buildSlackAuth,
  channelFactsFromInfo,
  channelFactsFromRaw,
  partnerFactsFromInfo,
} from "../agent/channels/slack-identity.js";
import { buildLinearAuth } from "../agent/channels/linear-identity.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

for (const k of ["OE_PLATFORM", "OE_WORKSPACE", "OE_SURFACE", "OE_CHANNEL", "OE_MODE", "OE_VISIBILITY", "OE_PRINCIPAL", "OE_TRUST"]) {
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

const linPart = resolvePartition(linearCtx({ organization_id: "ORG1", issue_id: "ISS9", agent_session_id: "AS1" }));
ok(linPart.surfaceKey === "linear/ORG1/ISS9", "linear: partition surfaceKey = platform/org/issue");

const la = buildLinearAuth({ agentSessionId: "AS1", organizationId: "ORG1", teamId: "TEAM5", issueId: "ISS9", issueIdentifier: "ENG-9", principalId: "LU3", isPrivate: false });
ok(la.authenticator === "linear" && la.principalId === "LU3" && la.principalType === "linear-user", "buildLinearAuth: principal fields");
ok(la.attributes.organization_id === "ORG1" && la.attributes.team_id === "TEAM5" && la.attributes.issue_id === "ISS9" && la.attributes.is_private === "false", "buildLinearAuth: facts captured as strings (incl. team_id)");
const laSparse = buildLinearAuth({ agentSessionId: "AS2" });
ok(laSparse.attributes.organization_id === undefined && laSparse.attributes.team_id === undefined && laSparse.attributes.is_private === undefined && laSparse.principalId === "", "buildLinearAuth: omits unknown facts (no false claims)");

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

console.log(`✓ identity: ${passed} assertions passed`);
