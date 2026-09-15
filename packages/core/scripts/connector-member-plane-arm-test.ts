import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { registerSlackFixtureMapper } from "./_slack-test-stubs.js";
import { _setDeploymentIdentityForTest } from "../agent/identity/deployment-identity.js";
registerSlackFixtureMapper();

const tmp = mkdtempSync(join(tmpdir(), "open-everywhere-member-arm-"));
process.env.OE_SQLITE_PATH = join(tmp, "ops.sqlite3");
_setDeploymentIdentityForTest({ org: undefined });
process.env.OE_PLATFORM = "slack";

const { registerConfig } = await import("../agent/access/config.js");
const { defineBundle, defineBinding } = await import("../agent/access/bundle.js");
const { defineConnectorCredentials, vercelConnectorHome } = await import("../agent/access/connector-credentials.js");
const { defineDomain } = await import("../agent/memory/domain.js");

const ROOM = "C_MEMBER_ROOM";
const EXT_ROOM = "C_CONNECT_ROOM";
const TEAM = "T_TEAM";
const ACTING = "U_acting";
const REQUESTER = "U_requester";

const MEMBER_CREDENTIAL = "user-oauth-member";

const notionCatalogue = defineConnectorCredentials({
  connector: "notion",
  allows: ["api-key", "user-oauth"],
  credentials: [
    { id: "user-oauth", type: "user-oauth", home: vercelConnectorHome("oauth/notion-user") },
    { id: MEMBER_CREDENTIAL, type: "user-oauth", home: vercelConnectorHome("oauth/notion-member") },
    { id: "team", type: "api-key", secretRef: "NOTION_TEAM", broker: "env" },
  ],
});

const memberDomain = defineDomain({
  name: "member-fixture",
  reach: [`slack/${TEAM}/${ROOM}`, `slack/${TEAM}/${EXT_ROOM}`],
  credentials: [{ connector: "notion", credential: "user-oauth", use: MEMBER_CREDENTIAL }],
});
const ungrantedDomain = defineDomain({ name: "member-fixture", reach: memberDomain.reach });
let domains: readonly ReturnType<typeof defineDomain>[] = [memberDomain];

const bundles = [
  defineBundle({ name: "member", connectors: [{ name: "notion", credential: MEMBER_CREDENTIAL, contentOrigin: "external" }] }),
  defineBundle({ name: "personal", connectors: [{ name: "notion", credential: "user-oauth", contentOrigin: "external" }] }),
];
const bindings = [
  defineBinding({ bundle: "member", scope: { level: "surface", surface: `slack/${TEAM}/${ROOM}` } }),
  defineBinding({ bundle: "member", scope: { level: "surface", surface: `slack/${TEAM}/${EXT_ROOM}` } }),
  defineBinding({ bundle: "personal", scope: { level: "principal", principal: `slack/${TEAM}/${ACTING}` } }),
];

registerConfig({
  loadConnectorCredentials: () => [notionCatalogue],
  loadBundles: () => bundles,
  loadBindings: () => bindings,
  pluginRegistry: {},
  skillContent: {},
  loadDomains: () => domains,
  loadSilos: () => [],
  domainsForSurface: ({ surface }) => (surface === ROOM || surface === EXT_ROOM ? ["member-fixture"] : []),
});

const { userAwareProviderToken } = await import("../agent/connections/connector-auth.js");
const { registerSettings, resetSettingsForTest, defineSettings } = await import("../agent/settings/settings.js");
const { OE_REQUESTER_ATTR, REQUESTER_UNVERIFIED } = await import("../agent/access/requester-identity.js");
const { OE_CHAT_NONMEMBER_ATTR } = await import("../agent/access/taint-signal.js");
const { registerSurfaces, defineSurface, _resetSurfacesForTest } = await import("../agent/identity/trust.js");
const { bindFrom, deploymentOrg } = await import("../agent/identity/binding.js");
const { rawVaultSubject } = await import("../agent/identity/oauth-vault-share.js");
const { readAudit } = await import("../agent/audit/audit.js");
const { domainCredentialProblems, assertDomainCredentialsResolvable } = await import("../agent/access/domain-credentials.js");
const { assertBundlesValid, assertBindingsValid } = await import("../agent/access/bundle.js");
const { assertDomainsValid } = await import("../agent/memory/domain.js");
const { memberPlaneGrants, memberGrantKey } = await import("../agent/access/member-grant.js");
const { boundConnectorCredential } = await import("../agent/access/connector-scope.js");

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    rmSync(tmp, { recursive: true, force: true });
    process.exit(1);
  }
  passed++;
}

function slackAuth(attrs: Record<string, string>) {
  const p = {
    principalType: "service",
    principalId: attrs.user_id,
    authenticator: "slack",
    attributes: { team_id: TEAM, is_private: "false", ...attrs },
  };
  return { current: p, initiator: p };
}

function roomAuth(opts: { room?: string; requester?: string; nonMember?: boolean; extShared?: boolean } = {}) {
  return slackAuth({
    channel_id: opts.room ?? ROOM,
    channel_type: "channel",
    user_id: ACTING,
    trust_checked: "true",
    is_ext_shared: opts.extShared === true ? "true" : "false",
    ...(opts.requester === undefined ? {} : { [OE_REQUESTER_ATTR]: opts.requester }),
    ...(opts.nonMember === true ? { [OE_CHAT_NONMEMBER_ATTR]: "true" } : {}),
  });
}

interface MintCall { connector: string; id: string }
function makeMinter() {
  const calls: MintCall[] = [];
  const mint = async (connector: string, params: { subject: { id: string } }) => {
    calls.push({ connector, id: params.subject.id });
    return { token: `USER-TOKEN-${params.subject.id}` };
  };
  return { calls, mint };
}
const notInjectedStarter = { start: async () => { throw new Error("startAuthorization not-injected"); } };

async function getToken(auth: unknown, minter: ReturnType<typeof makeMinter>): Promise<{ token?: string; err?: string }> {
  const resolver = userAwareProviderToken(
    { connector: "notion", fallbackSecretRef: "NOTION_API_KEY", fallbackBroker: "env" },
    { mintUser: minter.mint, startAuth: notInjectedStarter.start as never },
  );
  const provider = await resolver({ session: { auth } } as never);
  try {
    const call = provider.getToken as (o: unknown) => Promise<{ token: string }>;
    return { token: (await call(undefined)).token };
  } catch (e) {
    return { err: e instanceof Error ? e.message : String(e) };
  }
}

function armMemberPlane(on: boolean): void {
  resetSettingsForTest();
  registerSettings({ connectors: { userPrincipal: true, opTiering: true, memberPlane: on } });
}

async function latestMintDetail(): Promise<Record<string, unknown>> {
  const rows = (await readAudit({ org: deploymentOrg(), action: "connector.mint" })) as readonly { detail?: Record<string, unknown> }[];
  return rows[0]?.detail ?? {};
}

ok(domainCredentialProblems(memberDomain).length === 0, "⓪ the member-role declaration passes `domainCredentialProblems` (this is the shape a deployment would write)");
function bootRefusal(check: () => void): string {
  try {
    check();
    return "";
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}
ok(bootRefusal(() => assertDomainCredentialsResolvable([memberDomain], [notionCatalogue])) === "", "⓪ …and `assertDomainCredentialsResolvable` accepts it against the fixture catalogue");
ok(bootRefusal(() => assertBundlesValid(bundles)) === "", "⓪ the fixture BUNDLES pass `assertBundlesValid` — a user-oauth grant is a legal bundle shape");
ok(bootRefusal(() => assertBindingsValid(bindings, bundles)) === "", "⓪ the fixture BINDINGS pass `assertBindingsValid` — including the surface-scoped grant that widens the universe gate");
ok(bootRefusal(() => assertDomainsValid([memberDomain])) === "", "⓪ the fixture DOMAIN passes `assertDomainsValid`, which is where `domainCredentialProblems` is wired at boot");
ok(bootRefusal(() => assertBindingsValid([defineBinding({ bundle: "no-such-bundle", scope: { level: "org" } })], bundles)) !== "", "⓪ …and those checks can fail: a binding naming an unknown bundle is refused");
ok(
  domainCredentialProblems(defineDomain({ name: "x", reach: [], credentials: [{ connector: "notion", credential: "user-oauth", use: "user-oauth" }] })).length === 1,
  "🔴 ⓪ a self-naming override is REFUSED — arming the member plane always costs a second per-user credential id",
);
ok(
  memberPlaneGrants([memberDomain]).join() === memberGrantKey("notion", MEMBER_CREDENTIAL),
  "⓪ the domain's declaration produces exactly the one grant key the resolver reads",
);
ok(memberPlaneGrants([ungrantedDomain]).length === 0, "⓪ …and the same domain without the declaration holds none (absence is a refusal, never a default)");

_resetSurfacesForTest();
registerSurfaces([defineSurface({ key: `slack/${TEAM}/${ROOM}`, trust: "internal" })]);
armMemberPlane(true);
{
  const cred = await boundConnectorCredential("notion", roomAuth({ requester: REQUESTER }) as never);
  ok(cred?.credential === MEMBER_CREDENTIAL && cred?.type === "user-oauth", "① a per-user credential resolves on a CHANNEL — the member plane widened the universe gate");
  ok(cred?.memberPlane === true, "① …and it carries the member-plane stamp (the binding the arm reads)");

  const m = makeMinter();
  const r = await getToken(roomAuth({ requester: REQUESTER }), m);
  const requesterSubject = rawVaultSubject(deploymentOrg(), "slack", TEAM, REQUESTER);
  const actingSubject = rawVaultSubject(deploymentOrg(), "slack", TEAM, ACTING);
  ok(r.token === `USER-TOKEN-${requesterSubject}` && r.err === undefined, "🔴 ① THE MEMBER ARM IS REACHED — a CHANNEL turn mints a personal token (no test reached this before)");
  ok(m.calls.length === 1 && m.calls[0].connector === "oauth/notion-member", "① the mint used the MEMBER credential's own vercel-connect home, not the role id's");
  ok(m.calls[0].id === requesterSubject, "🔴 ① the token is minted for the VERIFIED REQUESTER's vault subject");
  ok(requesterSubject !== actingSubject, "① precondition: the requester and the acting principal have DIFFERENT vault subjects on this turn");
  ok(m.calls[0].id !== actingSubject, "🔴 ① …and NOT for the acting principal — `actorId` reads the verdict's requester, never the last delivery's author");

  const last = await latestMintDetail();
  ok(last.outcome === "ok" && last.plane === "member" && last.requester === REQUESTER, "① the mint row stamps the MEMBER plane and names the requester it minted for");
  ok(last.subject === "user", "① …and records the subject kind the DM path already records");
}

_resetSurfacesForTest();
{
  const b = bindFrom({ session: { auth: roomAuth({ requester: REQUESTER }) } } as never);
  ok(b.trust === "internal", "🔴 ② the UNDECLARED room's JOINED trust reads `internal` — the mapper said so, and nobody declared anything");
  ok(b.declaredTrust === undefined, "🔴 ② …while its DECLARED trust is undefined. A call site reading the join would ADMIT this room");
  ok(b.mode === "channel", "② precondition: it binds as a CHANNEL, so the member arm is the arm under test");

  const m = makeMinter();
  const r = await getToken(roomAuth({ requester: REQUESTER }), m);
  ok(r.token === undefined && (r.err ?? "").includes("not vouched as a members-only room"), "🔴 ② G4b: the undeclared room is REFUSED at the real call site");
  ok(m.calls.length === 0, "② …and no personal token was minted");
  const last = await latestMintDetail();
  ok(last.outcome === "refused" && last.reason === "member_plane_nonmember_wake" && last.plane === "member", "② the refusal is audited against the gate that produced it");
}

_resetSurfacesForTest();
registerSurfaces([defineSurface({ key: `slack/${TEAM}`, trust: "internal" })]);
{
  const m = makeMinter();
  const r = await getToken(roomAuth({ requester: REQUESTER }), m);
  ok(r.token !== undefined && m.calls.length === 1, "③ a TENANT-grain declaration reaches the mint site and admits the ordinary room");

  const ext = bindFrom({ session: { auth: roomAuth({ room: EXT_ROOM, requester: REQUESTER, extShared: true }) } } as never);
  ok(ext.declaredTrust === "internal" && ext.trust === "external", "🔴 ③ precondition: the SAME declaration covers a positively-external room, and the join demotes it");

  const m2 = makeMinter();
  const r2 = await getToken(roomAuth({ room: EXT_ROOM, requester: REQUESTER, extShared: true }), m2);
  ok(r2.token === undefined && (r2.err ?? "").includes("not vouched as a members-only room"), "🔴 ③ …and the arm REFUSES it — reading `declaredTrust` alone would re-promote a Slack Connect room");
  ok(m2.calls.length === 0, "③ …with no mint");
}

_resetSurfacesForTest();
registerSurfaces([defineSurface({ key: `slack/${TEAM}/${ROOM}`, trust: "internal" })]);
for (const [label, auth] of [
  ["no stamp at all", roomAuth()],
  ["the `oe/unverified` sentinel", roomAuth({ requester: REQUESTER_UNVERIFIED })],
  ["an EMPTY stamp", roomAuth({ requester: "" })],
] as const) {
  const m = makeMinter();
  const r = await getToken(auth, m);
  ok(r.token === undefined && (r.err ?? "").includes("could not be attributed to exactly one person"), `🔴 ④ G3: ${label} → refused, and the sentence names the attribution gate`);
  ok(m.calls.length === 0, `④ …and ${label} minted nothing`);
  ok((auth as { current: { principalId: string } }).current.principalId === ACTING, `④ …while the ACTING principal WAS present (${label}) — the field a wrong call site would have used`);
}

{
  const v = bindFrom({ session: { auth: roomAuth({ requester: REQUESTER }) } } as never);
  ok(v.declaredTrust === "internal" && v.trust === "internal", "⑤ precondition: this room IS vouched on both fields, so only the non-member wake can produce the refusal below");

  const m = makeMinter();
  const r = await getToken(roomAuth({ requester: REQUESTER, nonMember: true }), m);
  ok(r.token === undefined && (r.err ?? "").includes("not vouched as a members-only room"), "🔴 ⑤ G4a: a non-member wake is refused even in a DECLARED room — the vouch is not an override");
  ok(m.calls.length === 0, "⑤ …and no personal token was minted");
}

{
  armMemberPlane(false);
  const m = makeMinter();
  const r = await getToken(roomAuth({ requester: REQUESTER }), m);
  ok(r.token === undefined && (r.err ?? "").includes("member plane is disarmed"), "🔴 ⑥ G1a: with `connectors.memberPlane` off the SAME admitting turn is refused");
  ok(m.calls.length === 0, "⑥ …and mints nothing");
}
{
  armMemberPlane(true);
  domains = [ungrantedDomain];
  const m = makeMinter();
  const r = await getToken(roomAuth({ requester: REQUESTER }), m);
  ok(r.token === undefined && m.calls.length === 0, "🔴 ⑥ G2: a domain that declares no member role admits no personal credential in its rooms");
  const cred = await boundConnectorCredential("notion", roomAuth({ requester: REQUESTER }) as never);
  ok(cred === null || cred.memberPlane !== true, "⑥ …and the credential no longer resolves with the member stamp");
  domains = [memberDomain];
}
{
  resetSettingsForTest();
  const untiered = { connectors: { userPrincipal: true, opTiering: false, memberPlane: true } };
  const armed = { connectors: { userPrincipal: true, opTiering: true, memberPlane: true } };
  let refused = "";
  try {
    defineSettings(untiered);
  } catch (e) {
    refused = e instanceof Error ? e.message : String(e);
  }
  ok(refused.includes("armed without connectors.opTiering"), "🔴 ⑥ G1b: a deployment declaring `userPrincipal` without `opTiering` is REFUSED — `member_plane_untiered` is unreachable from a real posture");
  ok(bootRefusal(() => defineSettings(armed)) === "", "⑥ …while the armed posture this file drives IS a declarable one");
  ok(defineSettings(armed).connectors?.memberPlane === true, "⑥ …and the declaration keeps the flag this file arms");
  resetSettingsForTest();
}

{
  armMemberPlane(true);
  const dmAuth = slackAuth({ channel_id: "D_DM", channel_type: "im", user_id: ACTING, dm_partner_trust: "internal", [OE_REQUESTER_ATTR]: REQUESTER });
  const m = makeMinter();
  const r = await getToken(dmAuth, m);
  ok(r.token === `USER-TOKEN-${rawVaultSubject(deploymentOrg(), "slack", TEAM, ACTING)}`, "🔴 ⑦ a DM still mints for the ACTING principal, even with a requester stamp present");
  ok(m.calls.length === 1 && m.calls[0].id !== rawVaultSubject(deploymentOrg(), "slack", TEAM, REQUESTER), "⑦ …never for the requester — the member arm's read did not leak into the DM path");
  const last = await latestMintDetail();
  ok(last.plane === undefined && last.requester === undefined, "⑦ …and the DM mint row carries NO member-plane stamp (positive-only provenance)");
}

resetSettingsForTest();
_resetSurfacesForTest();
rmSync(tmp, { recursive: true, force: true });
console.log(`✓ connector-member-plane-arm: ${passed} assertions passed`);
