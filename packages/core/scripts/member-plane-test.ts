// proves: AP-MOD-core-access-member-plane

import assert from "node:assert/strict";
import {
  memberPlaneRefusalMessage,
  memberPlaneVerdict,
  nonMemberWakeFromAuth,
  personalConnectorWriteVerdict,
  personalWriteRefusalMessage,
  requesterFromAuth,
  roomVouchedInternalFrom,
  type MemberPlaneInput,
  type PersonalConnectorWriteInput,
} from "../agent/access/member-plane.js";
import { expandConnectorGrant, type ConnectorCredentials } from "../agent/access/connector-credentials.js";
import { memberGrantKey } from "../agent/access/member-grant.js";
import { connectorOpApproval, resolveDmPrincipal, unresolvableConnectionRefusalMessage } from "../agent/connections/connector-auth.js";
import { registerSettings, resetSettingsForTest } from "../agent/settings/settings.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

const ASKER = "U_MEMBER";

const admitting: MemberPlaneInput = {
  armed: true,
  opTiered: true,
  granted: true,
  requester: { kind: "requester", principalId: ASKER },
  nonMemberWake: false,
  roomVouchedInternal: true,
};

const base = memberPlaneVerdict(admitting);
ok(base.admit === true, "every gate holding ⇒ the plane admits");
ok(base.admit === true && base.requesterPrincipalId === ASKER, "🔴 the admitting arm carries the REQUESTER's id — the subject the mint must key on");

function refusal(patch: Partial<MemberPlaneInput>): string {
  const v = memberPlaneVerdict({ ...admitting, ...patch });
  return v.admit ? "ADMITTED" : v.reason;
}

ok(refusal({ armed: false }) === "member_plane_disarmed", "🔴 G1a flag off ⇒ refused, and the reason names the flag");
ok(refusal({ opTiered: false }) === "member_plane_untiered", "🔴 G1b per-op tiering OFF ⇒ refused. Tiering is what enforces the read-only rule (G5); without it a member-plane WRITE would ride the blanket once() approval");
ok(refusal({ granted: false }) === "member_plane_ungranted", "🔴 G2 no domain grant ⇒ refused (absence is a refusal, never the org default)");
ok(refusal({ requester: { kind: "unverified" } }) === "member_plane_unverified_requester", "🔴 G3 several people woke this turn ⇒ refused, never a pick from the candidates");
ok(refusal({ requester: { kind: "none" } }) === "member_plane_unverified_requester", "🔴 G3 no evidence of an asker ⇒ refused too — `none` is not a pass");
ok(refusal({ requester: { kind: "requester", principalId: "" } }) === "member_plane_unverified_requester", "🔴 G3 an EMPTY principal id refuses — a blank subject would mint against a vault row nobody owns");
ok(refusal({ nonMemberWake: true }) === "member_plane_nonmember_wake", "🔴 G4a a wake carrying a non-member's bytes ⇒ refused (`member+, never guest`)");

ok(base.admit === true, "🔴 G4b DECLARED INTERNAL + nobody refuted ⇒ ADMITTED (the positive control — without it the two refusals below would pass on a gate that refuses everything)");
ok(refusal({ roomVouchedInternal: false }) === "member_plane_nonmember_wake", "🔴 G4b UNDECLARED room ⇒ refused `member_plane_nonmember_wake` — absence of a declaration infers `nobody here is a member`, it does not read as `not refuted`");
ok(memberPlaneVerdict({ ...admitting, roomVouchedInternal: true, nonMemberWake: true }).admit === false, "🔴 G4b DECLARED INTERNAL + positively refuted (surface or the operator's register) ⇒ still refused — the declaration vouches for the ROOM, it never overrides a named refutation");
ok(refusal({ nonMemberWake: true, roomVouchedInternal: false }) === "member_plane_nonmember_wake", "…and both halves failing names the same one gate");
{
  const msg = memberPlaneRefusalMessage("notion", "member_plane_nonmember_wake");
  ok(msg.includes("declared this room internal") && msg.includes("agent/identity/surfaces.ts") && msg.includes("defineSurface"), "🔴 the refusal names the DECLARATION an operator has to add, and the file to add it in — a deployment that has declared nothing internal has no member plane, so it must read a cause rather than a bare denial");
  ok(msg.includes("the container it sits in") && msg.includes("the whole workspace"), "🔴 …and it says a declaration counts at ANY rung, because the code accepts any rung — a message naming only the room would send an operator to write a line narrower than the gate requires");
}
ok(refusal({ opTier: "write" }) === "member_plane_write", "🔴 G5 a WRITE op ⇒ refused — v1 is reads only");
ok(refusal({ opTier: "destructive" }) === "member_plane_write", "🔴 G5 a DESTRUCTIVE op ⇒ refused, same gate");

ok(memberPlaneVerdict({ ...admitting, opTier: "read" }).admit === true, "a READ op admits (the positive control for G5)");
ok(memberPlaneVerdict({ ...admitting, opTier: undefined }).admit === true, "an UNNAMED op admits — the mint runs before any op is named, and the per-op seam re-asks with the tier");

ok(refusal({ armed: false, opTiered: false, granted: false, requester: { kind: "none" }, nonMemberWake: true, opTier: "write" }) === "member_plane_disarmed", "with every gate failing, the refusal names the flag first");
ok(refusal({ opTiered: false, granted: false, requester: { kind: "none" }, nonMemberWake: true, opTier: "write" }) === "member_plane_untiered", "…then the tiering flag");
ok(refusal({ granted: false, requester: { kind: "none" }, nonMemberWake: true, opTier: "write" }) === "member_plane_ungranted", "…then the domain grant");
ok(refusal({ requester: { kind: "none" }, nonMemberWake: true, opTier: "write" }) === "member_plane_unverified_requester", "…then the requester");
ok(refusal({ nonMemberWake: true, opTier: "write" }) === "member_plane_nonmember_wake", "…then the wake");

for (const reason of ["member_plane_disarmed", "member_plane_untiered", "member_plane_ungranted", "member_plane_unverified_requester", "member_plane_nonmember_wake", "member_plane_write"] as const) {
  const msg = memberPlaneRefusalMessage("notion", reason);
  ok(msg.includes("notion") && msg.length > 40, `the refusal message for ${reason} names the connector and says why`);
  ok(!msg.includes(ASKER), `…and never names the asker (${reason})`);
}

const REQ_ATTR = "oe_requester";
const NONMEMBER_ATTR = "oe_chat_nonmember";
const UNVERIFIED = "oe/unverified";

function auth(attrs: Record<string, unknown>): { current: { attributes: Record<string, unknown> } } {
  return { current: { attributes: attrs } };
}

ok(requesterFromAuth(auth({ [REQ_ATTR]: ASKER }), REQ_ATTR, UNVERIFIED).kind === "requester", "a named stamp reads as a requester");
ok(requesterFromAuth(auth({ [REQ_ATTR]: UNVERIFIED }), REQ_ATTR, UNVERIFIED).kind === "unverified", "🔴 the sentinel reads as unverified — never as a principal called `oe/unverified`");
ok(requesterFromAuth(auth({}), REQ_ATTR, UNVERIFIED).kind === "none", "🔴 no stamp ⇒ `none` (fail closed)");
ok(requesterFromAuth(auth({ [REQ_ATTR]: "" }), REQ_ATTR, UNVERIFIED).kind === "none", "🔴 an EMPTY stamp ⇒ `none`");
ok(requesterFromAuth(auth({ [REQ_ATTR]: 7 }), REQ_ATTR, UNVERIFIED).kind === "none", "🔴 a non-string stamp ⇒ `none`");
ok(requesterFromAuth(undefined, REQ_ATTR, UNVERIFIED).kind === "none", "🔴 no auth bag at all ⇒ `none`");
ok(requesterFromAuth({ current: null }, REQ_ATTR, UNVERIFIED).kind === "none", "🔴 a null `current` ⇒ `none`");

ok(nonMemberWakeFromAuth(auth({ [NONMEMBER_ATTR]: "true" }), NONMEMBER_ATTR) === true, "the literal \"true\" reads as a non-member wake");
ok(nonMemberWakeFromAuth(auth({}), NONMEMBER_ATTR) === false, "absent ⇒ false (=== false; the producer is positive-only, so absence means `not refuted`)");
ok(nonMemberWakeFromAuth(auth({ [NONMEMBER_ATTR]: "false" }), NONMEMBER_ATTR) === false, "the string \"false\" ⇒ false");
ok(nonMemberWakeFromAuth(undefined, NONMEMBER_ATTR) === false, "no auth bag ⇒ false");

ok(
  memberPlaneVerdict({
    armed: true,
    opTiered: true,
    granted: true,
    requester: requesterFromAuth(auth({ [REQ_ATTR]: ASKER }), REQ_ATTR, UNVERIFIED),
    nonMemberWake: nonMemberWakeFromAuth(auth({ [REQ_ATTR]: ASKER }), NONMEMBER_ATTR),
    roomVouchedInternal: true,
  }).admit === true,
  "the readers compose into an admitting verdict",
);
ok(
  refusal({ requester: requesterFromAuth(auth({ [REQ_ATTR]: UNVERIFIED }), REQ_ATTR, UNVERIFIED) }) === "member_plane_unverified_requester",
  "🔴 …and a coalesced multi-asker turn refuses through the same composition",
);

const CAT: ConnectorCredentials = {
  connector: "notion",
  allows: ["api-key", "user-oauth"],
  credentials: [
    { id: "personal", type: "user-oauth", home: { kind: "oauth", config: { connector: "mcp.notion.com/notion-mcp" } } },
    { id: "other-personal", type: "user-oauth", home: { kind: "oauth", config: { connector: "mcp.notion.com/notion-mcp" } } },
    { id: "team-key", type: "api-key", secretRef: "db:notion:team-key", broker: "db" },
  ],
};

const GRANT = { name: "notion", credential: "personal" };
const KEY = memberGrantKey("notion", "personal");

const noPlane = expandConnectorGrant(GRANT, CAT, { dm: false });
ok(noPlane.resolved === null, "🔴 BASELINE: with no member-plane set, a user-oauth credential does NOT resolve on a channel");
ok(noPlane.warnings.length === 1, "…and it warns rather than throwing");

const emptyPlane = expandConnectorGrant(GRANT, CAT, { dm: false, memberPlane: new Set<string>() });
ok(emptyPlane.resolved === null, "🔴 an EMPTY member-plane set is the same as none — fail closed");

const admitted = expandConnectorGrant(GRANT, CAT, { dm: false, memberPlane: new Set([KEY]) });
ok(admitted.resolved !== null, "the NAMED pair resolves on a channel through the member plane");
ok(admitted.resolved?.memberPlane === true, "🔴 …and the binding carries the provenance stamp, so the mint knows which plane admitted it");
ok(admitted.resolved?.principal === "user", "…while still resolving as user-principal — the plane changes the universe, not the identity");
ok(admitted.warnings.length === 0, "an admitted grant warns about nothing");

const sibling = expandConnectorGrant({ name: "notion", credential: "other-personal" }, CAT, { dm: false, memberPlane: new Set([KEY]) });
ok(sibling.resolved === null, "🔴 a DIFFERENT credential on the same connector is NOT admitted — the set names PAIRS, not connectors");

const wrongConnector = expandConnectorGrant(GRANT, CAT, { dm: false, memberPlane: new Set(["linear/personal"]) });
ok(wrongConnector.resolved === null, "🔴 a grant key for another connector admits nothing here");

const inDm = expandConnectorGrant(GRANT, CAT, { dm: true });
ok(inDm.resolved !== null, "a DM resolves the personal credential exactly as before");
ok(inDm.resolved?.memberPlane === undefined, "🔴 …and carries NO member-plane stamp (=== undefined) — a DM mint's provenance is unchanged");

const dmWithPlane = expandConnectorGrant(GRANT, CAT, { dm: true, memberPlane: new Set([KEY]) });
ok(dmWithPlane.resolved?.memberPlane === undefined, "🔴 a DM never reads as member-plane even when the domain declared the grant — the stamp means `admitted outside a DM`");

const appCred = expandConnectorGrant({ name: "notion", credential: "team-key" }, CAT, { dm: false, memberPlane: new Set([KEY]) });
ok(appCred.resolved !== null && appCred.resolved.memberPlane === undefined, "an app-principal credential resolves on a channel as always, with no member stamp");

const NARROW: ConnectorCredentials = { ...CAT, allows: ["api-key"] };
const notAllowed = expandConnectorGrant(GRANT, NARROW, { dm: false, memberPlane: new Set([KEY]) });
ok(notAllowed.resolved === null, "🔴 the member plane does not bypass the connection's credential allowlist");

const memberBinding = { connector: "notion", credential: "personal", type: "user-oauth", grantFamily: "install", principal: "user", memberPlane: true } as never;
const plainBinding = { connector: "notion", credential: "team-key", type: "api-key", grantFamily: "install", principal: "app", broker: "db", secretRef: "db:notion:team-key" } as never;
const dmPersonalBinding = { connector: "notion", credential: "personal", type: "user-oauth", grantFamily: "install", principal: "user" } as never;

const surfaceIs = (mode?: string, principalId?: string) => async () => ({
  ...(mode === undefined ? {} : { mode }),
  ...(principalId === undefined ? {} : { principalId }),
});
const IN_DM = surfaceIs("dm", ASKER);
const IN_CHANNEL = surfaceIs("channel", ASKER);
const UNRESOLVABLE_SURFACE = surfaceIs(undefined, undefined);

registerSettings({ connectors: { opTiering: true } });
const ctxFor = (toolName: string, attrs: Record<string, unknown> = {}) =>
  ({ toolName, session: { auth: auth(attrs) } }) as never;

{
  const policy = connectorOpApproval({ boundCredential: async () => memberBinding, dmPrincipal: IN_CHANNEL });
  const write = await policy(ctxFor("notion__create_page"));
  ok(typeof write === "object" && write !== null && (write as { type?: string }).type === "denied", "🔴 G5 ENFORCED: a WRITE on a member-plane binding is DENIED at the approval seam — not prompted");
  ok(
    (write as { reason?: string }).reason === memberPlaneRefusalMessage("notion", "member_plane_write"),
    "🔴 …and the denial carries the MEMBER-PLANE sentence verbatim — the shared-room refusal must not drift into a different reason",
  );
  const destructive = await policy(ctxFor("notion__delete_page"));
  ok(typeof destructive === "object" && destructive !== null && (destructive as { type?: string }).type === "denied", "🔴 …and a DESTRUCTIVE op too");
  ok((await policy(ctxFor("notion__search"))) === "not-applicable", "…while a READ on the same binding is still auto-allowed (the positive control)");
}
{
  const policy = connectorOpApproval({ boundCredential: async () => plainBinding, dmPrincipal: IN_CHANNEL });
  ok((await policy(ctxFor("notion__create_page"))) === "user-approval", "🔴 NEGATIVE CONTROL: a non-member binding's WRITE still PROMPTS — the denial is scoped to the member plane");
  ok((await policy(ctxFor("notion__delete_page"))) === "user-approval", "…and a destructive op still prompts per call");
}
{
  const policy = connectorOpApproval({ boundCredential: async () => null, dmPrincipal: UNRESOLVABLE_SURFACE });
  ok((await policy(ctxFor("notion__create_page"))) === "user-approval", "🔴 an UNRESOLVABLE binding prompts rather than denying — byte-identical to a tree without the member plane");
}

const PLUGIN_CONNECTION = "acme__notes";
const PLUGIN_WRITE = `${PLUGIN_CONNECTION}__create_page`;
const recordingCredential = (bindings: Record<string, unknown>) => {
  const asked: string[] = [];
  const read = async (connection: string) => {
    asked.push(connection);
    return (bindings[connection] ?? null) as never;
  };
  return { asked, read: read as never };
};

{
  const cred = recordingCredential({});
  await connectorOpApproval({ boundCredential: cred.read, dmPrincipal: IN_CHANNEL })(ctxFor(PLUGIN_WRITE));
  ok(cred.asked.join() === PLUGIN_CONNECTION, `🔴 the credential is looked up under the WHOLE slug "${PLUGIN_CONNECTION}" — asked for [${cred.asked.join(", ")}]`);
  ok(!cred.asked.includes("acme"), "🔴 …and never under its head segment, which is the cross-contamination this parse exists to stop");
}
{
  const cred = recordingCredential({ [PLUGIN_CONNECTION]: memberBinding });
  const denied = await connectorOpApproval({ boundCredential: cred.read, dmPrincipal: IN_CHANNEL })(ctxFor(PLUGIN_WRITE));
  ok(typeof denied === "object" && denied !== null && (denied as { type?: string }).type === "denied", "🔴 a plugin connection's member-plane write is DENIED — the verdict reads its OWN binding");
  ok((denied as { reason?: string }).reason === memberPlaneRefusalMessage(PLUGIN_CONNECTION, "member_plane_write"), "…and the sentence names the whole slug, so the row a human reads names the connection that was actually consulted");
}
{
  const cred = recordingCredential({ acme: memberBinding });
  const decision = await connectorOpApproval({ boundCredential: cred.read, dmPrincipal: IN_CHANNEL })(ctxFor(PLUGIN_WRITE));
  ok(decision === "user-approval", "🔴 a member-plane binding on the HEAD SEGMENT `acme` no longer decides `acme__notes` — the head's posture cannot reach its sibling's write");
  const other = recordingCredential({ "notion__notes": memberBinding });
  ok((await connectorOpApproval({ boundCredential: other.read, dmPrincipal: IN_CHANNEL })(ctxFor("notion__create_page"))) === "user-approval", "…and a single-segment connection is untouched by a plugin connection that shares its head");
}
{
  const cred = recordingCredential({ grant: memberBinding });
  const denied = await connectorOpApproval({ boundCredential: cred.read, dmPrincipal: IN_CHANNEL })(ctxFor("grant__U0OWNER__create_page"));
  ok(typeof denied === "object" && denied !== null && (denied as { type?: string }).type === "denied", "🔴 a RESERVED `grant__` name is REFUSED here — fail-closed, exactly as consequence.ts classifies an unparseable name");
  ok((denied as { reason?: string }).reason === unresolvableConnectionRefusalMessage("grant__U0OWNER__create_page"), "…with the sentence that says which plane owns the name, so the model reports routing rather than an outage");
  ok(cred.asked.length === 0, "🔴 …and NO credential lookup was attempted — there is no connection to look one up for, and asking for `grant` is the bug");
}

{
  const policy = connectorOpApproval({ boundCredential: async () => dmPersonalBinding, dmPrincipal: IN_DM });
  ok((await policy(ctxFor("notion__create_page", { [REQ_ATTR]: ASKER }))) === "user-approval", "🔴 OPE-1002: a personal-credential WRITE in a DM PROMPTS — the normal approval card, not a denial");
  ok((await policy(ctxFor("notion__delete_page", { [REQ_ATTR]: ASKER }))) === "user-approval", "…and a DESTRUCTIVE personal op in a DM prompts per call rather than denying");
  ok((await policy(ctxFor("notion__search", { [REQ_ATTR]: ASKER }))) === "not-applicable", "…while a READ still never prompts (the positive control)");
  ok((await policy(ctxFor("notion__create_page"))) === "user-approval", "🔴 a DM turn that stamped NO requester still prompts — a DM carries one human, so absence is not a mismatch");
  ok((await policy(ctxFor("notion__create_page", { [REQ_ATTR]: UNVERIFIED }))) === "user-approval", "🔴 …and an `unverified` stamp is not a mismatch either");
}
{
  const onChannel = connectorOpApproval({ boundCredential: async () => dmPersonalBinding, dmPrincipal: IN_CHANNEL });
  const denied = await onChannel(ctxFor("notion__create_page", { [REQ_ATTR]: ASKER }));
  ok(typeof denied === "object" && denied !== null && (denied as { type?: string }).type === "denied", "🔴 an UNSTAMPED personal credential on a CHANNEL is DENIED — the seam proves the DM, it does not infer it");
  const unresolved = connectorOpApproval({ boundCredential: async () => dmPersonalBinding, dmPrincipal: UNRESOLVABLE_SURFACE });
  const deniedToo = await unresolved(ctxFor("notion__create_page", { [REQ_ATTR]: ASKER }));
  ok(typeof deniedToo === "object" && deniedToo !== null && (deniedToo as { type?: string }).type === "denied", "🔴 an UNRESOLVABLE surface is DENIED too — an unproven DM is not a DM");
  const throwing = connectorOpApproval({
    boundCredential: async () => dmPersonalBinding,
    dmPrincipal: async () => {
      throw new Error("surface read exploded");
    },
  });
  const deniedOnThrow = await throwing(ctxFor("notion__create_page", { [REQ_ATTR]: ASKER }));
  ok(typeof deniedOnThrow === "object" && deniedOnThrow !== null && (deniedOnThrow as { type?: string }).type === "denied", "🔴 a THROWING surface read is DENIED rather than rejected — the seam always returns an answer");
}
{
  const policy = connectorOpApproval({ boundCredential: async () => dmPersonalBinding, dmPrincipal: surfaceIs("dm", "U_OWNER") });
  const mismatch = await policy(ctxFor("notion__create_page", { [REQ_ATTR]: "U_SOMEBODY_ELSE" }));
  ok(typeof mismatch === "object" && mismatch !== null && (mismatch as { type?: string }).type === "denied", "🔴 a DM whose REQUESTER is not the DM's own person is DENIED — one person's name must never ride another person's approval");
  ok((await policy(ctxFor("notion__create_page", { [REQ_ATTR]: "U_OWNER" }))) === "user-approval", "…and the same surface with the matching requester prompts (the positive control for the mismatch check)");
}

const dmWrite: PersonalConnectorWriteInput = {
  memberPlaneBinding: false,
  personalCredential: true,
  surfaceMode: "dm",
  actingPrincipalId: ASKER,
  requester: { kind: "requester", principalId: ASKER },
};

function writeRefusal(patch: Partial<PersonalConnectorWriteInput>): string {
  const v = personalConnectorWriteVerdict({ ...dmWrite, ...patch });
  return v.prompt ? "PROMPTED" : v.reason;
}

ok(personalConnectorWriteVerdict(dmWrite).prompt === true, "the DM write prompts (the one admitting input)");
ok(writeRefusal({ memberPlaneBinding: true }) === "member_plane_write", "🔴 the SHARED-ROOM denial is unchanged and reads FIRST — it never depends on the surface or the requester");
ok(writeRefusal({ memberPlaneBinding: true, surfaceMode: "dm" }) === "member_plane_write", "🔴 …and a stamped binding claiming a DM surface is still denied — the stamp means `resolved outside a DM`");
ok(writeRefusal({ surfaceMode: "channel" }) === "personal_write_unproven_dm", "🔴 a channel refuses");
ok(writeRefusal({ surfaceMode: "mpim" }) === "personal_write_unproven_dm", "🔴 a group DM (mpim) refuses — only the literal `dm` admits");
ok(writeRefusal({ surfaceMode: undefined }) === "personal_write_unproven_dm", "🔴 an unreadable surface mode refuses");
ok(writeRefusal({ actingPrincipalId: undefined }) === "personal_write_unproven_dm", "🔴 a DM with no resolvable actor refuses");
ok(writeRefusal({ actingPrincipalId: "" }) === "personal_write_unproven_dm", "🔴 an EMPTY actor id refuses too");
ok(writeRefusal({ requester: { kind: "requester", principalId: "U_OTHER" } }) === "personal_write_requester_mismatch", "🔴 a NAMED requester who is not the DM's person refuses");
ok(writeRefusal({ requester: { kind: "unverified" } }) === "PROMPTED", "an `unverified` requester is not a mismatch — a DM has one human, so there is no second ask to confuse it with");
ok(writeRefusal({ requester: { kind: "none" } }) === "PROMPTED", "…and `none` is not a mismatch either");
ok(writeRefusal({ personalCredential: false, surfaceMode: "channel" }) === "PROMPTED", "🔴 an APP-principal write on a CHANNEL is untouched — the ordinary work-surface write still prompts");
ok(writeRefusal({ personalCredential: false, surfaceMode: undefined, actingPrincipalId: undefined }) === "PROMPTED", "…and it does not acquire a new way to fail on an unreadable surface");

for (const reason of ["member_plane_write", "personal_write_unproven_dm", "personal_write_requester_mismatch"] as const) {
  const msg = personalWriteRefusalMessage("notion", reason);
  ok(msg.includes("notion") && msg.length > 40, `the personal-write refusal message for ${reason} names the connector and says why`);
  ok(!msg.includes(ASKER) && !msg.includes("U_OWNER"), `…and never names a person (${reason})`);
}
ok(personalWriteRefusalMessage("notion", "member_plane_write") === memberPlaneRefusalMessage("notion", "member_plane_write"), "🔴 the shared-room sentence has ONE home — the personal-write message delegates to it verbatim");

resetSettingsForTest();

const { registerSurfaces, defineSurface, _resetSurfacesForTest } = await import("../agent/identity/trust.js");
const { bindFrom } = await import("../agent/identity/binding.js");

const roomAuth = (() => {
  const p = { principalType: "service", principalId: ASKER, authenticator: "local", attributes: { channel_type: "channel" } };
  return { current: p, initiator: p } as never;
})();

const ROOM_KEY = "local/dev/default";

_resetSurfacesForTest();

const undeclaredBinding = bindFrom({ auth: roomAuth } as never);
ok(`${undeclaredBinding.platform}/${undeclaredBinding.workspace}/${undeclaredBinding.surface}` === ROOM_KEY, "§6 precondition: the room binds to the key the declaration below is written on");

ok(undeclaredBinding.trust === "internal", "🔴 an UNDECLARED room's JOINED trust reads `internal` — the mapper/default said so, and nobody declared anything");
ok(undeclaredBinding.declaredTrust === undefined, "🔴 …while its DECLARED trust is undefined. The two fields disagree in exactly this room, which is the whole reason G4b reads the second one");

const undeclaredRoom = await resolveDmPrincipal(roomAuth);
ok(undeclaredRoom.mode === "channel", "§6 precondition: the room resolves as a CHANNEL — the surface the member plane exists for (a DM never reaches this verdict)");
ok(undeclaredRoom.declaredTrust === undefined, "🔴 G4b CARRIAGE: an undeclared room reaches the MINT SITE carrying no declaration");
ok(
  (() => {
    const v = memberPlaneVerdict({ ...admitting, roomVouchedInternal: undeclaredRoom.declaredTrust === "internal" });
    return !v.admit && v.reason === "member_plane_nonmember_wake";
  })(),
  "🔴 …and that absence REFUSES through the real verdict, naming the wake gate — absence infers non-member",
);

registerSurfaces([defineSurface({ key: ROOM_KEY, trust: "internal" })]);
const declaredRoom = await resolveDmPrincipal(roomAuth);
ok(declaredRoom.declaredTrust === "internal", "🔴 the SAME room, once the operator declares it, reaches the mint site as `declaredTrust: \"internal\"` (the positive control — nothing else about the wake moved)");
ok(memberPlaneVerdict({ ...admitting, roomVouchedInternal: declaredRoom.declaredTrust === "internal" }).admit === true, "🔴 …and the declaration ADMITS through the real verdict");

ok(roomVouchedInternalFrom("internal", "internal") === true, "🔴 declared internal AND not contradicted ⇒ vouched (the positive control)");
ok(roomVouchedInternalFrom(undefined, "internal") === false, "🔴 UNDECLARED but the join says internal ⇒ NOT vouched. This is the community-workspace room: reading the join alone would admit it");
ok(roomVouchedInternalFrom("internal", "external") === false, "🔴 DECLARED internal but the platform positively says external ⇒ NOT vouched. This is a tenant-grain declaration over a Slack Connect channel: reading the declaration alone would re-promote a room that spans another org, which identity/binding.ts forbids");
ok(roomVouchedInternalFrom("public", "external") === false, "🔴 a `public` declaration is not a vouch");
ok(roomVouchedInternalFrom("public", "internal") === false, "…and it is not one when the join disagrees either");
ok(roomVouchedInternalFrom(undefined, undefined) === false, "🔴 an unresolvable binding ⇒ NOT vouched — absence infers non-member, on both fields at once");

_resetSurfacesForTest();

assert.equal(typeof passed, "number");
console.log(`✓ member-plane: ${passed} assertions passed`);

// proves: AP-MOD-core-identity-trust
