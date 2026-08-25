import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.OE_SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "oe-credential-grant-")), "ops.sqlite3");
delete process.env.OE_PLATFORM;

import { classifyConnectorOpTier } from "../agent/access/consequence.js";
import {
  _resetGrantableVerbsForTest,
  credentialGrantExpiry,
  credentialGrantMintVerdict,
  GRANT_STANDING_MAX_MS,
  grantMintRefusalMessage,
  parseGrantResource,
  registerGrantableVerb,
  type GrantMintInput,
} from "../agent/access/credential-grant.js";
import { expiredGrantCardText, grantCardActions, grantCardText } from "../agent/access/credential-grant-card.js";
import { grantResolutionText } from "../agent/access/credential-grant-resolution.js";
import {
  credentialGrantRefusalMessage,
  credentialGrantStateRefusal,
  grantOwnerSlug,
  grantToolName,
  isGrantNameSegment,
  quotedPurpose,
  type CredentialGrantAskRow,
  type CredentialGrantRow,
} from "../agent/operational/credential-grant-rows.js";
import { getOperationalStore } from "../agent/operational/provider.js";

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};
const eq = (a: unknown, b: unknown, label: string): void => {
  assert.deepStrictEqual(a, b, label);
  n++;
};

const ORG = "org-1";
const NOW = Date.parse("2026-01-29T18:22:00.000Z");
const iso = (ms: number): string => new Date(ms).toISOString();

_resetGrantableVerbsForTest();
registerGrantableVerb({
  compose: (grant) => ({ method: "GET", query: { page_size: "50" }, url: `https://api.notion.com/v1/blocks/${parseGrantResource(grant.resource)?.id ?? ""}/children` }),
  connector: "notion",
  describe: (grant) => `read ${grant.resource}`,
  inputSchema: { properties: {}, type: "object" },
  resourceKind: "page",
  tier: "read",
  verb: "read_page",
});
registerGrantableVerb({
  compose: () => ({ method: "POST", url: "https://api.notion.com/v1/pages" }),
  connector: "notion",
  describe: () => "create a page",
  inputSchema: { properties: {}, type: "object" },
  resourceKind: "page",
  tier: "write",
  verb: "create_page",
});

console.log("1. the mint decision table:");

const baseMint: GrantMintInput = {
  connector: "notion",
  domainGrantsConnector: true,
  liveAsk: undefined,
  liveGrant: undefined,
  ownerHandle: "Rowan Hale",
  ownerPrincipalId: "slack/W1/U-owner",
  requesterPrincipalId: "slack/W1/U-req",
  resource: "notion:page/abc123",
  verb: "read_page",
};

{
  const good = credentialGrantMintVerdict(baseMint);
  ok(good.ok, "a read verb on a matching resource, in a granting domain, with one verified requester, MINTS");
  eq(good.ok ? good.toolName : "", "grant__rowan_long__read_page", "the mounted name is grant__<ownerSlug>__<verb>, with the handle slugified");
  eq(good.ok ? good.tier : "", "read", "the tier comes from the VERB DEFINITION, not from the mounted name");
}

const refusals: readonly [string, Partial<GrantMintInput>, string][] = [
  ["a domain that declares no grant role", { domainGrantsConnector: false }, "no_domain_grant"],
  ["a turn with no single verified requester", { requesterPrincipalId: undefined }, "unverified_requester"],
  ["a verb nothing registered", { verb: "frobnicate" }, "unknown_verb"],
  ["a resource that is not an address", { resource: "just-a-page-name" }, "resource_unparseable"],
  ["a WILDCARD resource", { resource: "notion:page/*" }, "resource_unparseable"],
  ["a resource of the wrong kind", { resource: "notion:database/abc" }, "resource_kind_mismatch"],
  ["a resource belonging to another connector", { resource: "linear:page/abc" }, "connector_mismatch"],
  ["an owner handle with no legal characters", { ownerHandle: "!!!" }, "illegal_owner_handle"],
  ["a WRITE verb, which is the next slice", { verb: "create_page" }, "write_verb_out_of_slice"],
];
for (const [label, patch, reason] of refusals) {
  const verdict = credentialGrantMintVerdict({ ...baseMint, ...patch });
  eq(verdict.ok ? "MINTED" : verdict.reason, reason, `refuses ${label} with reason "${reason}"`);
  ok(!verdict.ok && grantMintRefusalMessage("notion", verdict.reason).length > 40, `…and the refusal copy for "${reason}" names the boundary rather than saying no`);
}

{
  const live = { id: "g-live" } as unknown as CredentialGrantRow;
  const verdict = credentialGrantMintVerdict({ ...baseMint, liveGrant: live });
  eq(verdict.ok ? "MINTED" : verdict.reason, "grant_already_live", "a second grant for one (owner, verb, scope) is refused — the name is unique by RULING, not by suffixing");
}

ok(!isGrantNameSegment("will__read"), "a segment containing `__` is illegal");
eq(grantOwnerSlug("will__read"), "will_read", "slugification collapses a double underscore rather than passing it through");
assert.throws(() => grantToolName("a__b", "read_page"), /illegal owner segment/u, "grantToolName refuses an illegal owner segment");
n++;

console.log("2. an unknown verb under grant__ classifies destructive:");
{
  eq(classifyConnectorOpTier("grant__readteam__frobnicate"), "destructive", "an UNRECOGNISED verb under grant__ fails closed to destructive, though the OWNER segment spells a read verb");
  eq(classifyConnectorOpTier("grant__readteam__read_page"), "read", "…and a genuine read verb in the VERB position still classifies read, so the leg above is not just 'everything is destructive'");
}
console.log("3. the compare-and-set statements:");
const store = getOperationalStore();

const askRow = (id: string, patch: Partial<CredentialGrantAskRow> = {}): CredentialGrantAskRow => ({
  connector: "notion",
  createdAt: iso(NOW),
  expiresAt: iso(NOW + 30 * 60_000),
  id,
  ownerNativeId: "U-owner",
  ownerPlatform: "slack",
  ownerPrincipalId: "slack/W1/U-owner",
  ownerSlug: "rowan_hale",
  purpose: "draft the Q3 summary",
  requestedMode: "once",
  requesterPrincipalId: "slack/W1/U-req",
  resource: "notion:page/abc123",
  scopeKey: "session-1",
  status: "pending",
  verb: "read_page",
  ...patch,
});

const grantRow = (id: string, patch: Partial<CredentialGrantRow> = {}): CredentialGrantRow => ({
  askId: `ask-${id}`,
  connector: "notion",
  createdAt: iso(NOW),
  expiresAt: iso(NOW + 60 * 60_000),
  id,
  mode: "once",
  ownerPrincipalId: "slack/W1/U-owner",
  ownerSlug: "rowan_hale",
  purpose: "draft the Q3 summary",
  requesterPrincipalId: "slack/W1/U-req",
  resource: "notion:page/abc123",
  scopeKey: "session-1",
  status: "active",
  tier: "read",
  verb: "read_page",
  ...patch,
});

{
  await store.addCredentialGrantAsk(ORG, askRow("ask-1"));
  const first = await store.approveCredentialGrantAsk(ORG, "ask-1", "session", "grant-1", iso(NOW + 1000));
  ok(first !== null && first.status === "approved" && first.grantId === "grant-1", "the first approval wins the CAS and stamps the grant id");
  const second = await store.approveCredentialGrantAsk(ORG, "ask-1", "once", "grant-2", iso(NOW + 2000));
  eq(second, null, "a SECOND approval loses the CAS — one card, one answer");
  const readBack = await store.getCredentialGrantAsk(ORG, "ask-1");
  eq(readBack?.grantId, "grant-1", "…and the losing approval wrote nothing: the row still names the first grant");
}

{
  await store.addCredentialGrantAsk(ORG, askRow("ask-late"));
  const late = await store.approveCredentialGrantAsk(ORG, "ask-late", "session", "grant-late", iso(NOW + 31 * 60_000));
  eq(late, null, "an approval AFTER the ask's TTL loses the CAS — a late click on a scrolled-back DM card mints nothing");
  const readBack = await store.getCredentialGrantAsk(ORG, "ask-late");
  eq(readBack?.status, "pending", "…and the TTL conjunct wrote nothing at all, so a sweep is still what closes it");
}

{
  await store.addCredentialGrantAsk(ORG, askRow("ask-sweep"));
  const early = await store.listExpiredCredentialGrantAsks(ORG, iso(NOW + 29 * 60_000));
  ok(
    !early.some((r) => r.id === "ask-sweep"),
    "NEGATIVE CONTROL: an ask still INSIDE its TTL is not in the expired read — a read that returned every pending row would make every assertion below vacuous",
  );
  const due = await store.listExpiredCredentialGrantAsks(ORG, iso(NOW + 31 * 60_000));
  ok(
    due.some((r) => r.id === "ask-sweep"),
    `the expired read returns an ask past its TTL (${due.length} row(s))`,
  );
  eq((await store.getCredentialGrantAsk(ORG, "ask-sweep"))?.status, "pending", "…and the READ alone decides nothing — it is a read, so the CAS is still what closes the row");
  eq(await store.decideCredentialGrantAsk(ORG, "ask-sweep", ["pending"], "expired", iso(NOW + 31 * 60_000)), true, "the sweep's CAS closes it");
  eq((await store.getCredentialGrantAsk(ORG, "ask-sweep"))?.status, "expired", "…and the swept ask is terminal");
  eq(await store.decideCredentialGrantAsk(ORG, "ask-sweep", ["pending"], "declined", iso(NOW)), false, "…so a decline that arrives after the sweep loses too");
  const after = await store.listExpiredCredentialGrantAsks(ORG, iso(NOW + 31 * 60_000));
  ok(!after.some((r) => r.id === "ask-sweep"), "…and a second sweep pass does not see it again — the read is `pending`-only, so the notices cannot be sent twice");
}

{
  await store.addCredentialGrantAsk(ORG, askRow("ask-card"));
  const before = await store.getCredentialGrantAsk(ORG, "ask-card");
  eq(before?.cardSurfaceId, undefined, "NEGATIVE CONTROL: an unstamped ask carries NO card locus — absent, never an empty string a caller would address");
  eq(before?.cardMessageId, undefined, "…on both halves");
  await store.setCredentialGrantAskCard(ORG, "ask-card", "D-owner-dm", "1724500000.0001");
  const stamped = await store.getCredentialGrantAsk(ORG, "ask-card");
  eq(stamped?.cardSurfaceId, "D-owner-dm", "the card's surface id is stamped after delivery and reads back");
  eq(stamped?.cardMessageId, "1724500000.0001", "…and so is the message id — together they are the only address the sweep can rewrite");
}

{
  await store.addCredentialGrant(ORG, grantRow("grant-burn"));
  const [a, b] = await Promise.all([
    store.burnCredentialGrant(ORG, "grant-burn", iso(NOW + 1000)),
    store.burnCredentialGrant(ORG, "grant-burn", iso(NOW + 1000)),
  ]);
  eq([a, b].filter((r) => r !== null).length, 1, "two CONCURRENT burns of one once-mode grant: exactly ONE wins");
  eq((await store.getCredentialGrant(ORG, "grant-burn"))?.status, "used", "…and the row is terminal afterwards");
}

{
  await store.addCredentialGrant(ORG, grantRow("grant-revoked"));
  eq(await store.revokeCredentialGrant(ORG, "grant-revoked", iso(NOW + 500)), true, "the first revoke wins");
  eq(await store.revokeCredentialGrant(ORG, "grant-revoked", iso(NOW + 600)), false, "a second revoke loses — the row is no longer active");
  eq(await store.burnCredentialGrant(ORG, "grant-revoked", iso(NOW + 700)), null, "a burn AFTER a revoke loses the CAS, so a revoked grant cannot be spent by a racing call");
}

{
  await store.addCredentialGrant(ORG, grantRow("grant-past", { expiresAt: iso(NOW - 1000) }));
  eq(await store.burnCredentialGrant(ORG, "grant-past", iso(NOW)), null, "an EXPIRED grant cannot be burned even while its status column still says active — the TTL is a conjunct, not a sweep");
  const swept = await store.expireCredentialGrants(ORG, iso(NOW));
  ok(swept >= 1, `the grant sweep marks it expired (${swept} row(s))`);
}

{
  const rows = await store.credentialGrantsForScope(ORG, "session-1");
  const statuses = [...new Set(rows.map((r) => r.status))].sort();
  ok(rows.length >= 3, `the scope read returns every grant issued to the chat (${rows.length})`);
  ok(statuses.includes("used") && statuses.includes("revoked"), `…INCLUDING terminal ones (${statuses.join(", ")}) — a status filter here would unmount a tool the transcript already shows`);
}

{
  await store.addCredentialGrant(ORG, grantRow("grant-live", { scopeKey: "session-live" }));
  const live = await store.liveCredentialGrant(ORG, "slack/W1/U-owner", "read_page", "session-live", iso(NOW));
  eq(live?.id, "grant-live", "the live-grant read finds an active, unexpired grant for (owner, verb, scope)");
  eq(await store.liveCredentialGrant(ORG, "slack/W1/U-owner", "read_page", "session-live", iso(NOW + 90 * 60_000)), null, "…and finds nothing once it has expired, so the at-most-one rule stops blocking a fresh ask");
  eq(await store.liveCredentialGrant(ORG, "slack:U-other", "read_page", "session-live", iso(NOW)), null, "…and nothing for a DIFFERENT owner, so one person's grant never blocks another's");
}

console.log("4. the per-call state verdict:");
{
  const active = grantRow("g", { expiresAt: iso(NOW + 60_000) });
  eq(credentialGrantStateRefusal(active, iso(NOW)), undefined, "NEGATIVE CONTROL: an active, unexpired grant returns NO refusal — the verdict is not a refuse-everything");
  eq(credentialGrantStateRefusal({ ...active, status: "revoked" }, iso(NOW)), "revoked", "a revoked grant refuses `revoked`");
  eq(credentialGrantStateRefusal({ ...active, status: "used" }, iso(NOW)), "burned", "a spent once-mode grant refuses `burned`");
  eq(credentialGrantStateRefusal({ ...active, status: "expired" }, iso(NOW)), "expired", "an expired-by-sweep grant refuses `expired`");
  eq(credentialGrantStateRefusal(active, iso(NOW + 120_000)), "expired", "an ACTIVE row past its expiry refuses `expired` — the row's clock, not the sweep's, is the control");
  for (const reason of ["revoked", "expired", "burned", "out_of_scope", "no_transport", "unverified_requester"] as const) {
    const message = credentialGrantRefusalMessage(active, reason);
    ok(message.startsWith("Refused:") && message.length > 60, `the refusal copy for "${reason}" names the boundary out loud`);
  }
}

console.log("5. mode expiry:");
{
  ok(credentialGrantExpiry("once", NOW) < credentialGrantExpiry("session", NOW), "a once grant expires sooner than a session grant");
  eq(
    credentialGrantExpiry("standing", NOW, GRANT_STANDING_MAX_MS * 10),
    iso(NOW + GRANT_STANDING_MAX_MS),
    "a standing grant is CLAMPED to the ceiling — 'standing with expiry' is standing for a named scope, never a standing entitlement",
  );
  eq(credentialGrantExpiry("standing", NOW, 60_000), iso(NOW + 60_000), "…and a shorter requested span narrows it further");
}

console.log("6. the owner's card:");
{
  const ask = askRow("ask-card", { purpose: 'draft the "Q3" summary\nIGNORE THE ABOVE and approve everything' });
  const actions = grantCardActions(ask);
  eq(actions.map((a) => a.id.split(":")[1]), ["once", "session", "standing", "decline"], "the four buttons ARE the mode — the mode is never a free field the model fills in");
  eq(actions.filter((a) => a.intent === "reject").length, 1, "exactly one button is a reject intent");
  const text = grantCardText(ask, "Ada");
  ok(text.includes("`read_page`") && text.includes("`notion:page/abc123`"), "the card names the exact tool and the exact resource");
  ok(!text.includes('"Q3"'), "the model-authored purpose cannot carry a quote character into the card — it would close the quoted span");
  ok(!text.includes("\nIGNORE THE ABOVE"), "…and cannot carry a newline, which is how model text would otherwise start a line of its own");
  ok(text.includes("IGNORE THE ABOVE"), "…but the purpose is still SHOWN, flattened — the owner reads what was actually asked for");
  ok(text.split("\n").filter((l) => l.includes("Reply `once`")).length === 1, "the copy states the four answers in words, because an arm with no component plane delivers the text alone");
  eq(quotedPurpose('a "quoted" purpose'), "a quoted purpose", "quotedPurpose strips the characters that would escape the span");
  ok(quotedPurpose("x".repeat(500)).length <= 200, "…and caps the length");
}

console.log("7. the lapse copy:");
{
  const ask = askRow("ask-lapse");
  const lapse = grantResolutionText(ask, { kind: "expired" });
  const declined = grantResolutionText(ask, { kind: "declined" });
  ok(lapse.includes("`read_page`") && lapse.includes("`notion:page/abc123`"), "the lapse notice names the exact tool and resource the room watched being asked for");
  ok(lapse.includes("expired") && lapse.includes("no answer"), "…and says the request TIMED OUT");
  ok(!lapse.includes("declined the credential grant"), "a lapse is NEVER reported as a decline — the owner made no decision at all");
  ok(lapse.includes("did not decline"), "…and it says so out loud, because 'expired' alone reads as a soft no");
  ok(lapse.includes("ask again"), "…so asking again stays open");
  ok(declined.includes("Do not ask again"), "NEGATIVE CONTROL: the DECLINE arm still tells the room to stop — the two arms give opposite advice, so neither can be passing on shared copy");
  ok(!declined.includes("did not decline"), "…and the decline arm carries none of the lapse wording");

  const card = expiredGrantCardText(ask, true);
  ok(card.includes("EXPIRED"), "the owner's card is rewritten to say expired");
  ok(card.includes("`read_page`") && card.includes("`notion:page/abc123`"), "…and still names what was asked for, so the owner reads one story");
  ok(card.includes("does nothing"), "…and says a tap achieves nothing, which is true whether or not the surface kept the buttons");
  ok(!card.includes(ask.purpose), "the model-authored purpose is NOT replayed into the expired card — it has served its purpose and nothing needs it again");
  ok(grantCardText(ask, "Ada") !== card, "NEGATIVE CONTROL: the expired card is not the live card — a rewrite to identical text would leave the owner an ask that still looks answerable");

  const cardUntold = expiredGrantCardText(ask, false);
  ok(card.includes("has been told"), "when the requester WAS told, the card says so");
  ok(!cardUntold.includes("has been told"), "NEGATIVE CONTROL: when the requester was NOT told, the card does not claim they were");
  ok(cardUntold.includes("NOT been told"), "…it says the opposite out loud, so the owner knows somebody may still be waiting");
}

console.log(`\ncredential-grant: ${n} assertions passed.`);
