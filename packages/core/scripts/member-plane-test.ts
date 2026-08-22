import assert from "node:assert/strict";
import {
  memberPlaneRefusalMessage,
  memberPlaneVerdict,
  nonMemberWakeFromAuth,
  requesterFromAuth,
  type MemberPlaneInput,
} from "../agent/access/member-plane.js";
import { expandConnectorGrant, type ConnectorCredentials } from "../agent/access/connector-credentials.js";
import { memberGrantKey } from "../agent/access/member-grant.js";
import { connectorOpApproval } from "../agent/connections/connector-auth.js";
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
ok(refusal({ nonMemberWake: true }) === "member_plane_nonmember_wake", "🔴 G4 a wake carrying a non-member's bytes ⇒ refused (`member+, never guest`)");
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
    { id: "personal", type: "user-oauth", home: { kind: "vercel-connect", config: { connector: "mcp.notion.com/notion-mcp" } } },
    { id: "other-personal", type: "user-oauth", home: { kind: "vercel-connect", config: { connector: "mcp.notion.com/notion-mcp" } } },
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

registerSettings({ connectors: { opTiering: true } });
const ctxFor = (toolName: string) => ({ toolName, approvedTools: new Set<string>(), session: { auth: {} } }) as never;

{
  const policy = connectorOpApproval({ boundCredential: async () => memberBinding });
  const write = await policy(ctxFor("notion__create_page"));
  ok(typeof write === "object" && write !== null && (write as { type?: string }).type === "denied", "🔴 G5 ENFORCED: a WRITE on a member-plane binding is DENIED at the approval seam — not prompted");
  const destructive = await policy(ctxFor("notion__delete_page"));
  ok(typeof destructive === "object" && destructive !== null && (destructive as { type?: string }).type === "denied", "🔴 …and a DESTRUCTIVE op too");
  ok((await policy(ctxFor("notion__search"))) === "not-applicable", "…while a READ on the same binding is still auto-allowed (the positive control)");
}
{
  const policy = connectorOpApproval({ boundCredential: async () => plainBinding });
  ok((await policy(ctxFor("notion__create_page"))) === "user-approval", "🔴 NEGATIVE CONTROL: a non-member binding's WRITE still PROMPTS — the denial is scoped to the member plane");
  ok((await policy(ctxFor("notion__delete_page"))) === "user-approval", "…and a destructive op still prompts per call");
}
{
  const policy = connectorOpApproval({ boundCredential: async () => null });
  ok((await policy(ctxFor("notion__create_page"))) === "user-approval", "🔴 an UNRESOLVABLE binding prompts rather than denying — byte-identical to a tree without the member plane");
}
resetSettingsForTest();

assert.equal(typeof passed, "number");
console.log(`✓ member-plane: ${passed} assertions passed`);
