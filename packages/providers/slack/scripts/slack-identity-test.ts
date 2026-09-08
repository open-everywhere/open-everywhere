import {
  bindFrom,
  bindBridged,
  registerIdentityMapper,
  resolvePartition,
  bridgedContext,
  registerSurfaces,
  defineSurface,
  type BindableContext,
} from "@open-everywhere/core/agent/adapter-api.js";
import {
  bindSlack,
  slackMode,
  slackVisibility,
  slackTrust,
  buildSlackAuth,
  channelFactsFromInfo,
  channelFactsFromRaw,
  partnerFactsFromInfo,
  appCanReadConversation,
} from "../agent/channels/slack-identity.js";
import { _resetDeploymentIdentityForTest, _setDeploymentIdentityForTest } from "@open-everywhere/core/agent/adapter-api.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

_resetDeploymentIdentityForTest();
for (const k of ["OE_PLATFORM", "OE_MODE", "OE_VISIBILITY", "OE_PRINCIPAL", "OE_TRUST"]) {
  delete process.env[k];
}

registerIdentityMapper("slack", bindSlack);

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
_setDeploymentIdentityForTest({ org: undefined });
ok(resolvePartition(orgCtx).org === "default", "partition.org defaults to 'default' when the deployment declares no org");
_setDeploymentIdentityForTest({ org: "acme-inc" });
const orgPart = resolvePartition(orgCtx);
ok(orgPart.org === "acme-inc", "partition.org threads from the declared org");
ok(orgPart.surfaceKey === "slack/T1/C9", "org is kept out of surfaceKey (org-portable tier keys)");
_setDeploymentIdentityForTest({ org: undefined });

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

ok(slackTrust("true", "true", "channel") === "external", "slackTrust: is_ext_shared=true -> external");
ok(slackTrust("false", "true", "channel") === "internal", "slackTrust: checked + not shared -> internal");
ok(slackTrust(undefined, undefined, "channel") === "external", "slackTrust: FAIL-CLOSED never checked -> external");
ok(slackTrust("false", undefined, "channel") === "external", "slackTrust: FAIL-CLOSED check absent even if flag false -> external");
ok(slackTrust(undefined, undefined, "dm") === "internal", "slackTrust: dm is a personal silo -> internal (gate N/A)");
ok(slackTrust("true", "true", "mpim") === "external", "slackTrust: 🔴 a SLACK CONNECT group DM (is_ext_shared=true) -> external — the platform's positive signal demotes an mpim like a channel");
ok(slackTrust("true", undefined, "mpim") === "external", "slackTrust: …and it demotes on the sharing flag alone, without a trust_checked stamp");
ok(slackTrust("false", "true", "mpim") === "internal", "slackTrust: NEGATIVE CONTROL — an ordinary checked group DM stays internal");
ok(slackTrust(undefined, undefined, "mpim") === "internal", "slackTrust: 🔴 an UNCHECKED group DM stays internal — an mpim is demoted by evidence, never by its absence (a workspace without `mpim:read` resolves neither fact)");

ok(channelFactsFromInfo({ channel: { is_channel: true, is_ext_shared: true } }).isExternal === true, "factsFromInfo: is_ext_shared -> isExternal true");
ok(channelFactsFromInfo({ channel: { is_channel: true, is_org_shared: true } }).isExternal === true, "factsFromInfo: is_org_shared -> isExternal true");
ok(channelFactsFromInfo({ channel: { is_channel: true } }).isExternal === false, "factsFromInfo: no shared flags -> isExternal false");
ok(channelFactsFromInfo({ channel: { is_channel: true } }).trustChecked === true, "factsFromInfo: successful fetch -> trustChecked true");
ok(channelFactsFromInfo(null).trustChecked === undefined, "factsFromInfo: empty info -> trustChecked undefined (fetch failed)");

ok(channelFactsFromInfo({ channel: { is_channel: true, is_member: true } }).appInChannel === true, "factsFromInfo: is_member true -> appInChannel true");
ok(channelFactsFromInfo({ channel: { is_channel: true, is_member: false } }).appInChannel === false, "factsFromInfo: 🔴 is_member false -> appInChannel false (a public channel the app never joined)");
ok(channelFactsFromInfo({ channel: { is_channel: true, is_member: false } }).trustChecked === true, "factsFromInfo: 🔴 …on a lookup that SUCCEEDED — trustChecked alone would have admitted it");
ok(channelFactsFromInfo({ channel: { is_im: true } }).appInChannel === undefined, "factsFromInfo: a DM carries no is_member -> appInChannel undefined (never invented as false)");
ok(channelFactsFromInfo({ channel: { is_channel: true, is_member: "yes" } }).appInChannel === undefined, "factsFromInfo: a non-boolean is_member is not read -- Slack's raw JSON is probed, never assumed");

const canRead = (info: unknown) => appCanReadConversation(channelFactsFromInfo(info));
ok(canRead({ channel: { is_channel: true, is_member: true } }) === true, "canRead: a channel the app IS in -> yes");
ok(canRead({ channel: { is_channel: true, is_member: false } }) === false, "canRead: 🔴 a channel the app is NOT in -> NO, on a lookup that succeeded");
ok(canRead({ channel: { is_channel: true } }) === false, "canRead: 🔴 a channel whose response omits is_member -> NO (fail closed, never inferred)");
ok(canRead({ channel: { is_group: true, is_private: true, is_member: false } }) === false, "canRead: a private group the app is not in -> no");
ok(canRead({ channel: { is_im: true } }) === true, "canRead: a DM -> yes; Slack answers conversations.info for a DM only to an app that is in it");
ok(canRead({ channel: { is_mpim: true } }) === true, "canRead: a group DM -> yes, for the same reason");
ok(canRead(null) === false, "canRead: 🔴 a FAILED lookup -> NO — channel_not_found is how an unreadable private room answers");
ok(appCanReadConversation({}) === false, "canRead: 🔴 no facts at all -> NO — negative control on the fail-closed default");
ok(appCanReadConversation({ channelType: "channel", appInChannel: true }) === false, "canRead: 🔴 membership WITHOUT a confirmed probe -> NO — trustChecked is required, not optional");

const trExt = bindFrom(slackCtx({ team_id: "T", channel_id: "CEXT", channel_type: "channel", is_ext_shared: "true", trust_checked: "true" }));
ok(trExt.trust === "external", "bindFrom: slack ext-shared channel binds external");
const trInt = bindFrom(slackCtx({ team_id: "T", channel_id: "CINT", channel_type: "channel", is_ext_shared: "false", trust_checked: "true" }));
ok(trInt.trust === "internal", "bindFrom: slack checked-internal channel binds internal");
const trUnchecked = bindFrom(slackCtx({ team_id: "T", channel_id: "CUNK", channel_type: "channel" }));
ok(trUnchecked.trust === "external", "bindFrom: slack channel with no trust check binds external (fail closed)");

ok(partnerFactsFromInfo({ user: { team_id: "T", is_restricted: false } }, "T").dmPartnerTrust === "internal", "partnerFacts: full member of the workspace -> internal");
ok(partnerFactsFromInfo({ user: { team_id: "T", is_restricted: true } }, "T").dmPartnerTrust === "external", "partnerFacts: multi-channel guest (restricted) -> external");
ok(partnerFactsFromInfo({ user: { team_id: "T", is_ultra_restricted: true } }, "T").dmPartnerTrust === "external", "partnerFacts: single-channel guest (ultra_restricted) -> external");
ok(partnerFactsFromInfo({ user: { team_id: "T", is_stranger: true } }, "T").dmPartnerTrust === "external", "partnerFacts: Connect stranger -> external");
ok(partnerFactsFromInfo({ user: { team_id: "T2" } }, "T").dmPartnerTrust === "external", "partnerFacts: different workspace -> external");
ok(partnerFactsFromInfo({ user: { team_id: "T", deleted: true } }, "T").dmPartnerTrust === "external", "partnerFacts: deleted account -> external");
ok(partnerFactsFromInfo(null, "T").dmPartnerTrust === "external", "partnerFacts: failed/empty lookup -> external (fail closed)");

{
  ok(
    partnerFactsFromInfo({ user: { team_id: "T", is_bot: true } }, "T").dmPartnerTrust === "internal",
    "🔴 partnerFacts: the workspace's OWN app (is_bot, same team_id) is a MEMBER — no bot carve-out (OPE-1508)",
  );
  ok(
    partnerFactsFromInfo({ user: { team_id: "T2", is_bot: true } }, "T").dmPartnerTrust === "external",
    "🔴 partnerFacts NEGATIVE CONTROL: a FOREIGN app (is_bot, other team_id, undeclared) is a GUEST — the bot rule is a rung walk, not an admission",
  );
  ok(
    partnerFactsFromInfo({ user: { team_id: "T", is_bot: true, is_restricted: true } }, "T").dmPartnerTrust === "external",
    "partnerFacts: the guest flags still refute an own-workspace bot — dropping `is_bot` widened nothing else",
  );

  const gridUser = { team_id: "T_SIB", enterprise_user: { enterprise_id: "E_GRID" } };
  registerSurfaces([]);
  ok(
    partnerFactsFromInfo({ user: gridUser }, "T_HQ").dmPartnerTrust === "external",
    "🔴 partnerFacts NEGATIVE CONTROL: with NOTHING declared, a Grid sibling workspace's member is a GUEST (absence infers non-member)",
  );
  registerSurfaces([defineSurface({ key: "slack/E_GRID", trust: "internal" })]);
  ok(
    partnerFactsFromInfo({ user: gridUser }, "T_HQ").dmPartnerTrust === "internal",
    "🔴 partnerFacts: ONE `slack/E_GRID` declaration vouches the sibling workspace — the Grid member writing in T_HQ is a MEMBER (OPE-1508)",
  );
  ok(
    partnerFactsFromInfo({ user: { team_id: "T_OTHER", enterprise_user: { enterprise_id: "E_OTHER" } } }, "T_HQ").dmPartnerTrust === "external",
    "partnerFacts: a member of a DIFFERENT, undeclared Grid is still a guest — the walk never reaches across",
  );
  ok(
    partnerFactsFromInfo({ user: { ...gridUser, is_restricted: true } }, "T_HQ").dmPartnerTrust === "external",
    "partnerFacts: a GUEST in a vouched sibling workspace is still a guest — the rung walk admits a workspace, never a person's grade",
  );
  registerSurfaces([defineSurface({ key: "slack/T_SIB", trust: "internal" })]);
  ok(
    partnerFactsFromInfo({ user: { team_id: "T_SIB" } }, "T_HQ").dmPartnerTrust === "internal",
    "partnerFacts: a declared WORKSPACE vouches its own members too — the enterprise entry is one rung, not the only one",
  );
  registerSurfaces([
    defineSurface({ key: "slack/E_GRID", trust: "internal" }),
    defineSurface({ key: "slack/T_SIB", trust: "public" }),
  ]);
  ok(
    partnerFactsFromInfo({ user: gridUser }, "T_HQ").dmPartnerTrust === "external",
    "🔴 partnerFacts: a `public` WORKSPACE carve-out demotes a member of it, though the enterprise above is internal — the narrower line wins",
  );
  registerSurfaces([]);
  ok(
    partnerFactsFromInfo({ user: { team_id: "T_HQ" } }, "T_HQ").dmPartnerTrust === "internal",
    "🔴 partnerFacts: the EVENT's own workspace is a member with NOTHING declared — the walk is only reached when the home workspace differs",
  );

  registerSurfaces([
    defineSurface({ key: "slack/E_GRID", trust: "internal" }),
    defineSurface({ key: "slack/T_SALES", trust: "public" }),
  ]);
  ok(
    partnerFactsFromInfo({ user: { team_id: "T_SALES", enterprise_user: { enterprise_id: "E_GRID" } } }, "T_SALES").dmPartnerTrust === "internal",
    "🔴 partnerFacts: a `public` carve-out on the ARRIVAL workspace does NOT demote its own member — the own-workspace arm answers before the register",
  );
  ok(
    partnerFactsFromInfo({ user: { team_id: "T_SALES", enterprise_user: { enterprise_id: "E_GRID" } } }, "T_HQ").dmPartnerTrust === "external",
    "partnerFacts: the SAME person writing in ANOTHER workspace IS demoted by that carve-out — which is the half the register decides",
  );
  registerSurfaces([]);
}

{
  registerSurfaces([]);
  ok(
    partnerFactsFromInfo({ user: { team_id: "T_FOREIGN", is_bot: true } }).dmPartnerTrust === "external",
    "🔴 partnerFacts NEGATIVE CONTROL: a FOREIGN app with NO expected team id and no guest flag is a GUEST — absence never admits (OPE-1508 review fix)",
  );
  ok(
    partnerFactsFromInfo({ user: { team_id: "T_FOREIGN" } }).dmPartnerTrust === "external",
    "partnerFacts: the same holds for a PERSON — the fix is about the absent workspace, not about bots",
  );
  registerSurfaces([defineSurface({ key: "slack/T_OWN", trust: "internal" })]);
  ok(
    partnerFactsFromInfo({ user: { team_id: "T_OWN", is_bot: true } }).dmPartnerTrust === "internal",
    "🔴 partnerFacts: the deployment's OWN app is a MEMBER with no expected team id, because the operator DECLARED `slack/T_OWN` — the walk answers where the envelope cannot",
  );
  registerSurfaces([defineSurface({ key: "slack/E_GRID", trust: "internal" })]);
  ok(
    partnerFactsFromInfo({ user: { team_id: "T_SIB", enterprise_user: { enterprise_id: "E_GRID" } } }).dmPartnerTrust === "internal",
    "partnerFacts: a declared GRID vouches a member whose envelope named no workspace — the org-wide install shape the fix exists for",
  );
  ok(
    partnerFactsFromInfo({ user: { team_id: "T_SIB", enterprise_user: { enterprise_id: "E_OTHER" } } }).dmPartnerTrust === "external",
    "partnerFacts NEGATIVE CONTROL: a DIFFERENT Grid with no expected team id is still a guest",
  );
  ok(
    partnerFactsFromInfo({ user: { team_id: "" } }, "").dmPartnerTrust === "external",
    "partnerFacts: an EMPTY expected team id never matches an empty home team id — a blank is an absence, not an identity",
  );
  registerSurfaces([]);
}

ok(
  buildSlackAuth({ userId: "U", teamId: "T", channelId: "C", enterpriseId: "E_GRID" }).attributes.enterprise_id === "E_GRID",
  "buildSlackAuth: enterprise_id stowed when the envelope named one",
);
ok(
  !("enterprise_id" in buildSlackAuth({ userId: "U", teamId: "T", channelId: "C" }).attributes),
  "buildSlackAuth NEGATIVE CONTROL: a non-Grid event stamps NO enterprise_id attribute (an absent rung, not an empty one)",
);
ok(
  bindSlack(slackCtx({ team_id: "T", channel_id: "C", channel_type: "channel", enterprise_id: "E_GRID" })).trustEnterprise === "E_GRID",
  "bindSlack: the enterprise_id attribute becomes RawIdentity.trustEnterprise — the rung core walks",
);
ok(
  bindSlack(slackCtx({ team_id: "T", channel_id: "C", channel_type: "channel" })).trustEnterprise === undefined,
  "bindSlack NEGATIVE CONTROL: no attribute ⇒ no enterprise rung contributed",
);
{
  registerSurfaces([defineSurface({ key: "slack/E_GRID", trust: "internal" })]);
  const gridCtx = { team_id: "T_SIB", channel_id: "C_GRID", channel_type: "channel", is_private: "false", trust_checked: "true", is_ext_shared: "false" };
  ok(
    bindFrom(slackCtx({ ...gridCtx, enterprise_id: "E_GRID" })).declaredTrust === "internal",
    "🔴 bindFrom: a room in an UNDECLARED Grid workspace resolves declaredTrust `internal` from the enterprise line (OPE-1508)",
  );
  ok(
    bindFrom(slackCtx(gridCtx)).declaredTrust === undefined,
    "🔴 bindFrom NEGATIVE CONTROL: the SAME room with no enterprise_id stamped declares nothing — the stamp is what carries the rung",
  );
  registerSurfaces([]);
}

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

const bridged = bindFrom(
  bridgedContext({
    platform: "slack",
    principalId: "U1",
    principalType: "slack-user",
    attributes: { team_id: "T9", channel_id: "C9", channel_type: "channel", is_ext_shared: "false", trust_checked: "true" },
  }),
);
ok(bridged.workspace === "T9" && bridged.surface === "C9" && bridged.trust === "internal" && bridged.principalId === "U1",
  "binding-bridge: a stamped slack identity reconstitutes the full binding (ids + trust + principal)");

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

{
  const slackDm = buildSlackAuth({ userId: "U1", teamId: "T1", channelId: "D0001", channelType: "im", dmPartnerTrust: "internal" });
  const slackChan = buildSlackAuth({ userId: "U1", teamId: "T1", channelId: "C0001", channelType: "channel", isPrivate: false });
  const slackMpim = buildSlackAuth({ userId: "U1", teamId: "T1", channelId: "G0001", channelType: "mpim" });
  ok(slackDm.attributes["oe_grain"] === "standing", "buildSlackAuth(im) stamps oe_grain=standing");
  ok(slackDm.attributes.channel_id === "D0001", "buildSlackAuth(im) still captures the raw DM channel id (identity/memory unchanged)");
  ok(!("oe_grain" in slackChan.attributes), "buildSlackAuth(channel) does NOT stamp a grain (native/full preserved)");
  ok(slackMpim.attributes["oe_grain"] === "standing", "buildSlackAuth(mpim/group-DM) stamps oe_grain=standing (widened: group DMs narrow too)");
}

{
  registerSurfaces([defineSurface({ key: "slack/TVOUCH", trust: "internal" })]);
  const mpimBind = bindFrom(slackCtx({ team_id: "TVOUCH", channel_id: "G_GROUP", channel_type: "mpim", is_ext_shared: "false", trust_checked: "true", user_id: "U7" }));
  const chanBind = bindFrom(slackCtx({ team_id: "TVOUCH", channel_id: "C_ROOM", channel_type: "channel", is_ext_shared: "false", trust_checked: "true", user_id: "U7" }));
  ok(mpimBind.mode === "mpim", "G4b precondition: the group-DM context really does bind mode `mpim` (so the rows below are not a channel in disguise)");
  ok(
    mpimBind.declaredTrust === "internal" && mpimBind.trust === "internal",
    "🔴 G4b: a GROUP DM under a WORKSPACE-level `internal` declaration reaches the mint site with BOTH conjuncts satisfied — a declaration counts at any rung the operator wrote it on, and an mpim has no key of its own to declare",
  );
  ok(
    chanBind.declaredTrust === mpimBind.declaredTrust && chanBind.trust === mpimBind.trust,
    "G4b: …and a CHANNEL in the same workspace resolves the SAME pair — the point of the ruling is that a group DM and a channel are one rule here",
  );

  const connectBind = bindFrom(slackCtx({ team_id: "TVOUCH", channel_id: "G_CONNECT", channel_type: "mpim", is_ext_shared: "true", trust_checked: "true", user_id: "U7" }));
  ok(
    connectBind.declaredTrust === "internal",
    "…the Slack Connect group DM is covered by the SAME declaration (so the demotion below must come from the platform leg, not from a missing vouch)",
  );
  ok(
    connectBind.trust === "external",
    "🔴 G4b: a SLACK CONNECT group DM (is_ext_shared=true) binds `trust: external`, so the second conjunct FAILS and the room is not vouched — a coarse workspace declaration can never re-promote a room the platform positively reported as spanning another organisation. Before OPE-1486 `slackTrust` graded every mpim `internal` and this demotion was unreachable.",
  );

  const undeclared = bindFrom(slackCtx({ team_id: "TOTHER", channel_id: "G_GROUP", channel_type: "mpim", is_ext_shared: "false", trust_checked: "true", user_id: "U7" }));
  ok(
    undeclared.declaredTrust === undefined && undeclared.trust === "internal",
    "G4b NEGATIVE CONTROL: an UNDECLARED group DM binds `internal` on the JOIN while carrying no declaration at all — the pair a gate reading `trust` alone would admit, and the reason G4b reads the first conjunct too",
  );
  registerSurfaces([]);
}

console.log(`✓ slack-identity: ${passed} assertions passed`);
