import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.OE_SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "oe-credential-grant-")), "ops.sqlite3");
process.env.OE_OPERATIONAL_PROVIDER = "sqlite";
delete process.env.OE_PLATFORM;

import { DatabaseSync } from "node:sqlite";

import { classifyConnectorOpTier } from "../agent/access/consequence.js";
import {
  credentialGrantExpiry,
  credentialGrantMintVerdict,
  GRANT_STANDING_MAX_MS,
  grantMintRefusalMessage,
  type GrantMintInput,
} from "../agent/access/credential-grant.js";
import { expiredGrantCardText, grantCardActions, grantCardText, GRANT_MODE_WORDS, GRANT_ONCE_MAX_ATTEMPTS_PER_TURN } from "../agent/access/credential-grant-card.js";
import { GRANT_REFUND_CAP_PER_TURN } from "../agent/access/credential-grant-broker.js";
import { grantResolutionText } from "../agent/access/credential-grant-resolution.js";
import {
  credentialGrantRefusalMessage,
  credentialGrantStateRefusal,
  grantBorrowToolName,
  grantFrozenArgsDigest,
  grantOwnerSlug,
  isGrantNameSegment,
  quotedPurpose,
  type CredentialGrantAskRow,
  type CredentialGrantRow,
} from "../agent/operational/credential-grant-rows.js";
import { grantToolEntry, mountedGrantName } from "../agent/tools/grant_tools.js";
import { runGrantedCall } from "../agent/access/credential-grant-broker.js";
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

const MCP_TOOL = "notion-fetch";
const FROZEN = { page: "abc123" };
const SCHEMA = { properties: { page: { const: "abc123", type: "string" } }, required: ["page"], type: "object" };
const TOOL_NAME = grantBorrowToolName("rowan_hale", "notion", "notion_fetch_launch_page");

console.log("1. the mint decision table:");

const baseMint: GrantMintInput = {
  borrow: { mcpTool: MCP_TOOL, rowId: "00000000-0000-4000-8000-000000000015", takenToolNames: [], targetLabel: "Launch page" },
  connector: "notion",
  domainGrantsConnector: true,
  liveAsk: undefined,
  liveGrant: undefined,
  ownerHandle: "Rowan Hale",
  ownerPrincipalId: "slack/W1/U-owner",
  requesterPrincipalId: "slack/W1/U-req",
};

{
  const good = credentialGrantMintVerdict(baseMint);
  ok(good.ok, "a READ vendor tool, in a granting domain, with one verified requester, MINTS");
  eq(good.ok ? good.toolName : "", "grant__rowan_hale_notion__notion_fetch_launch_page", "the mounted name carries the slugified handle, the connector and the tool");
  eq(good.ok ? good.tier : "", "read", "the tier comes from the CLASSIFIER's answer for the vendor tool, not from the mounted name");
}

const refusals: readonly [string, Partial<GrantMintInput>, string][] = [
  ["a domain that declares no grant role", { domainGrantsConnector: false }, "no_domain_grant"],
  ["a turn with no single verified requester", { requesterPrincipalId: undefined }, "unverified_requester"],
  ["an owner handle with no legal characters", { ownerHandle: "!!!" }, "illegal_owner_handle"],
  ["a connector id that cannot be a name segment", { connector: "no__tion" }, "illegal_connector_id"],
  ["a WRITE vendor tool, which is the next slice", { borrow: { ...baseMint.borrow, mcpTool: "notion-create-pages" } }, "write_verb_out_of_slice"],
  ["a vendor tool name with no legal characters", { borrow: { ...baseMint.borrow, mcpTool: "!!!" } }, "illegal_tool_name"],
];
for (const [label, patch, reason] of refusals) {
  const verdict = credentialGrantMintVerdict({ ...baseMint, ...patch });
  eq(verdict.ok ? "MINTED" : verdict.reason, reason, `refuses ${label} with reason "${reason}"`);
  ok(!verdict.ok && grantMintRefusalMessage("notion", verdict.reason).length > 40, `…and the refusal copy for "${reason}" names the boundary rather than saying no`);
}

{
  const live = { id: "g-live" } as unknown as CredentialGrantRow;
  const verdict = credentialGrantMintVerdict({ ...baseMint, liveGrant: live });
  eq(verdict.ok ? "MINTED" : verdict.reason, "grant_already_live", "a second grant for one (owner, connector, tool, frozen arguments, scope) is refused");
}

ok(!isGrantNameSegment("will__read"), "a segment containing `__` is illegal");
eq(grantOwnerSlug("will__read"), "will_read", "slugification collapses a double underscore rather than passing it through");
assert.throws(() => grantBorrowToolName("a__b", "notion", "notion_fetch"), /illegal owner segment/u, "the name composer refuses an illegal owner segment");
n++;

console.log("2. an unknown verb under grant__ classifies destructive:");
{
  eq(classifyConnectorOpTier("grant__readteam__frobnicate"), "destructive", "an UNRECOGNISED verb under grant__ fails closed to destructive, though the OWNER segment spells a read verb");
  eq(classifyConnectorOpTier("grant__readteam__read_page"), "read", "…and a genuine read verb in the VERB position still classifies read, so the leg above is not just 'everything is destructive'");
}

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
  frozenArgs: FROZEN,
  mcpTool: MCP_TOOL,
  requesterPrincipalId: "slack/W1/U-req",
  resource: "Launch page — notion-fetch({page:abc123})",
  scopeKey: "session-1",
  status: "pending",
  toolName: TOOL_NAME,
  verb: "notion_fetch",
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
  frozenArgs: FROZEN,
  inputSchema: SCHEMA,
  mcpTool: MCP_TOOL,
  requesterPrincipalId: "slack/W1/U-req",
  resource: "Launch page — notion-fetch({page:abc123})",
  scopeKey: "session-1",
  status: "active",
  tier: "read",
  toolName: TOOL_NAME,
  verb: "notion_fetch",
  ...patch,
});

console.log("2b. a grant row naming no vendor tool:");
const LEGACY_ID = "grant-legacy-1334";
{
  const legalAsk = askRow("ask-shape-ok");
  await store.addCredentialGrantAsk(ORG, legalAsk);
  ok(
    (await store.getCredentialGrantAsk(ORG, "ask-shape-ok"))?.mcpTool === MCP_TOOL,
    "NEGATIVE CONTROL: an ask that NAMES its vendor tool is written and reads back — the refusals below are discriminating, not universal",
  );
  await assert.rejects(
    async () => await store.addCredentialGrantAsk(ORG, { ...legalAsk, id: "ask-shape-bad", frozenArgs: undefined, mcpTool: undefined, toolName: undefined }),
    /mcpTool/u,
    "🔴 an ASK naming no vendor tool is REFUSED at the insert, and the message names the missing columns",
  );
  n++;
  await assert.rejects(
    async () => await store.addCredentialGrant(ORG, { ...grantRow("grant-shape-bad"), frozenArgs: undefined, inputSchema: undefined, mcpTool: undefined, toolName: undefined }),
    /mcpTool/u,
    "🔴 …and so is a GRANT: the verb-registry row shape is no longer a legal row to write",
  );
  n++;
  eq(await store.getCredentialGrant(ORG, "grant-shape-bad"), null, "…and the refused insert wrote nothing");
}

{
  await store.addCredentialGrant(ORG, grantRow(LEGACY_ID, { mode: "once", scopeKey: "session-legacy" }));
  const db = new DatabaseSync(process.env.OE_SQLITE_PATH ?? "");
  db.prepare("UPDATE credential_grant SET mcp_tool = NULL, frozen_args = NULL, tool_name = NULL, input_schema = NULL WHERE id = ?").run(LEGACY_ID);
  db.close();
  const legacy = await store.getCredentialGrant(ORG, LEGACY_ID);
  ok(legacy !== null, "🔴 a row an older build persisted still READS — never a crash, which is what a throwing reader would give every caller of the scope read");
  eq(legacy?.mcpTool, undefined, "…and it names no vendor tool");
  eq(legacy?.frozenArgs, undefined, "…and no frozen arguments — absent, never {}");
  eq(legacy?.toolName, undefined, "…and no pinned mounted name");
  ok(legacy?.status === "active" && legacy.expiresAt > iso(NOW), "…while its lifecycle columns say it is live, so nothing below can pass because the row was already dead");
}

{
  const legacy = await store.getCredentialGrant(ORG, LEGACY_ID);
  assert.ok(legacy !== null);
  eq(mountedGrantName(legacy), undefined, "🔴 a row with no pinned name claims NO mounted name — the composed grant__<owner>__<verb> arm is gone");
  eq(grantToolEntry(legacy), undefined, "🔴 …and it offers no tool entry: there is no honest description or schema for a tool this build cannot name");
  const legal = grantRow("g-mount-control", { scopeKey: "session-legacy" });
  eq(mountedGrantName(legal), TOOL_NAME, "NEGATIVE CONTROL: a row that names its tool DOES claim its pinned name");
  ok(grantToolEntry(legal) !== undefined, "…and DOES offer a tool entry, so the two refusals above are about the shape and not about the mount being broken");
}

{
  const result = await runGrantedCall(LEGACY_ID, {}, {
    nowMs: NOW,
    org: ORG,
    platform: "slack",
    requesterPrincipalId: "slack/W1/U-req",
    scopeKey: "session-legacy",
    workspace: "W1",
  });
  ok(!result.ok && result.refused === "no_lent_tool", "🔴 the broker refuses a row that names no vendor tool BY NAME — not `expired`, and not `no_transport`");
  ok(!result.ok && result.message.startsWith("Refused:") && result.message.includes("no vendor tool"), "…and the copy names the boundary rather than saying no");
  eq((await store.getCredentialGrant(ORG, LEGACY_ID))?.status, "active", "🔴 …and the ONCE-mode row is STILL ACTIVE: the refusal runs before the burn, so nothing was spent");
}

console.log("3. the compare-and-set statements:");
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
  await store.addCredentialGrant(ORG, grantRow("grant-refund"));
  const burnAt = iso(NOW + 1000);
  ok((await store.burnCredentialGrant(ORG, "grant-refund", burnAt)) !== null, "the grant burns");
  eq(await store.refundCredentialGrant(ORG, "grant-refund", burnAt), true, "the caller that owns the burn stamp refunds it");
  const back = await store.getCredentialGrant(ORG, "grant-refund");
  eq(back?.status, "active", "…and the row is ACTIVE again");
  eq(back?.usedAt, undefined, "…with the stamp CLEARED, so a later burn reads no leftover value");
  eq(await store.refundCredentialGrant(ORG, "grant-refund", burnAt), false, "a SECOND refund of the same stamp loses — the row is no longer `used`");

  const winnerAt = iso(NOW + 2000);
  ok((await store.burnCredentialGrant(ORG, "grant-refund", winnerAt)) !== null, "the grant burns again, at a different instant");
  eq(await store.refundCredentialGrant(ORG, "grant-refund", burnAt), false, "a refund carrying ANOTHER call's burn stamp loses — a loser cannot un-spend the winner's burn");
  eq((await store.getCredentialGrant(ORG, "grant-refund"))?.status, "used", "…and the row stays spent");

  await store.addCredentialGrant(ORG, grantRow("grant-refund-revoked"));
  await store.revokeCredentialGrant(ORG, "grant-refund-revoked", iso(NOW + 3100));
  eq(await store.refundCredentialGrant(ORG, "grant-refund-revoked", iso(NOW + 3000)), false, "a refund of a REVOKED row loses");
  eq((await store.getCredentialGrant(ORG, "grant-refund-revoked"))?.status, "revoked", "…and the grant stays ended — a refund never resurrects one its owner revoked");
}

{
  const CAP = 3;
  await store.addCredentialGrant(ORG, grantRow("grant-claim"));
  await store.addCredentialGrant(ORG, grantRow("grant-claim-sibling"));
  for (let attempt = 1; attempt <= CAP; attempt++) {
    eq(await store.claimCredentialGrantRefund(ORG, "grant-claim", "turn_1", CAP), true, `claim ${attempt} of ${CAP} lands`);
  }
  eq(await store.claimCredentialGrantRefund(ORG, "grant-claim", "turn_1", CAP), false, `🔴 claim ${CAP + 1} on the SAME turn is refused — the allowance is spent`);
  eq(await store.claimCredentialGrantRefund(ORG, "grant-claim", "turn_1", CAP), false, "…and stays refused, so a capped turn cannot retry its way back in");
  const claimed = await store.getCredentialGrant(ORG, "grant-claim");
  eq(claimed?.status, "active", "a claim never touches the row's own state — it counts, and the burn/refund pair decides the status");
  eq(claimed?.usedAt, undefined, "…nor the burn stamp the refund is keyed on");

  eq(await store.claimCredentialGrantRefund(ORG, "grant-claim-sibling", "turn_1", CAP), true, "🔴 a DIFFERENT row in the SAME turn still claims — the count is a column on the row, so one row's exhaustion never spends another's");

  eq(await store.claimCredentialGrantRefund(ORG, "grant-claim", "turn_2", CAP), true, "🔴 the SAME row claims again on a NEW turn — the allowance is per turn, and a count nothing rolled would have refused here");
  for (let attempt = 2; attempt <= CAP; attempt++) {
    eq(await store.claimCredentialGrantRefund(ORG, "grant-claim", "turn_2", CAP), true, `…and the new turn gets the WHOLE allowance: claim ${attempt} of ${CAP}`);
  }
  eq(await store.claimCredentialGrantRefund(ORG, "grant-claim", "turn_2", CAP), false, "…bounded at the same K, so a roll hands over one allowance and not an unbounded one");

  eq(await store.claimCredentialGrantRefund(ORG, "grant-claim", "turn_1", CAP), true, "a claim under an EARLIER turn key rolls the count too — the row holds one key, not a set");

  eq(await store.claimCredentialGrantRefund(ORG, "grant-missing", "turn_1", CAP), false, "a row that does not exist claims nothing — the fail-closed direction");

  await store.addCredentialGrant(ORG, grantRow("grant-claim-one"));
  eq(await store.claimCredentialGrantRefund(ORG, "grant-claim-one", "turn_1", 1), true, "a cap of one allows the first claim");
  eq(await store.claimCredentialGrantRefund(ORG, "grant-claim-one", "turn_1", 1), false, "…and refuses the second");

  await store.addCredentialGrant(ORG, grantRow("grant-claim-noturn"));
  for (let attempt = 1; attempt <= CAP; attempt++) {
    eq(await store.claimCredentialGrantRefund(ORG, "grant-claim-noturn", "turn_1", CAP), true, `the named turn spends allowance ${attempt} of ${CAP}`);
  }
  eq(await store.claimCredentialGrantRefund(ORG, "grant-claim-noturn", undefined, CAP), false, "🔴 a claim with NO turn key is refused against a spent allowance — it counts against the stored key rather than rolling it");
  eq(await store.claimCredentialGrantRefund(ORG, "grant-claim-noturn", "turn_1", CAP), false, "…and the stored key is untouched, so the named turn is still spent too");
  await store.addCredentialGrant(ORG, grantRow("grant-claim-noturn-only"));
  for (let attempt = 1; attempt <= CAP; attempt++) {
    eq(await store.claimCredentialGrantRefund(ORG, "grant-claim-noturn-only", undefined, CAP), true, `a keyless claim ${attempt} of ${CAP} still lands on a row that has never refunded`);
  }
  eq(await store.claimCredentialGrantRefund(ORG, "grant-claim-noturn-only", undefined, CAP), false, "…and the K+1'th keyless claim is refused: with nothing to roll, the allowance is the row's whole life");

  await store.addCredentialGrant(ORG, grantRow("grant-claim-race"));
  const [first, second] = await Promise.all([
    store.claimCredentialGrantRefund(ORG, "grant-claim-race", "turn_1", 1),
    store.claimCredentialGrantRefund(ORG, "grant-claim-race", "turn_1", 1),
  ]);
  eq([first, second].filter((won) => won).length, 1, "two overlapping claims of a one-refund allowance: exactly ONE wins");
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
  const digest = grantFrozenArgsDigest(FROZEN);
  await store.addCredentialGrant(ORG, grantRow("grant-live", { scopeKey: "session-live" }));
  const live = await store.liveBorrowCredentialGrant(ORG, "slack/W1/U-owner", "notion", MCP_TOOL, digest, "session-live", iso(NOW));
  eq(live?.id, "grant-live", "the live-grant read finds an active, unexpired grant for (owner, connector, tool, digest, scope)");
  eq(
    await store.liveBorrowCredentialGrant(ORG, "slack/W1/U-owner", "notion", MCP_TOOL, digest, "session-live", iso(NOW + 90 * 60_000)),
    null,
    "…and finds nothing once it has expired, so the at-most-one rule stops blocking a fresh ask",
  );
  eq(
    await store.liveBorrowCredentialGrant(ORG, "slack:U-other", "notion", MCP_TOOL, digest, "session-live", iso(NOW)),
    null,
    "…and nothing for a DIFFERENT owner, so one person's grant never blocks another's",
  );
}

console.log("4. the per-call state verdict:");
{
  const active = grantRow("g", { expiresAt: iso(NOW + 60_000) });
  eq(credentialGrantStateRefusal(active, iso(NOW)), undefined, "NEGATIVE CONTROL: an active, unexpired grant returns NO refusal — the verdict is not a refuse-everything");
  eq(credentialGrantStateRefusal({ ...active, status: "revoked" }, iso(NOW)), "revoked", "a revoked grant refuses `revoked`");
  eq(credentialGrantStateRefusal({ ...active, status: "used" }, iso(NOW)), "burned", "a spent once-mode grant refuses `burned`");
  eq(credentialGrantStateRefusal({ ...active, status: "expired" }, iso(NOW)), "expired", "an expired-by-sweep grant refuses `expired`");
  eq(credentialGrantStateRefusal(active, iso(NOW + 120_000)), "expired", "an ACTIVE row past its expiry refuses `expired` — the row's clock, not the sweep's, is the control");
  for (const reason of ["revoked", "expired", "burned", "out_of_scope", "no_lent_tool", "no_transport", "unverified_requester"] as const) {
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
  ok(text.includes(`\`${MCP_TOOL}\``) && text.includes(ask.resource), "the card names the exact vendor tool and the exact resource label");
  ok(!text.includes('"Q3"'), "the model-authored purpose cannot carry a quote character into the card — it would close the quoted span");
  ok(!text.includes("\nIGNORE THE ABOVE"), "…and cannot carry a newline, which is how model text would otherwise start a line of its own");
  ok(text.includes("IGNORE THE ABOVE"), "…but the purpose is still SHOWN, flattened — the owner reads what was actually asked for");
  ok(
    text.split("\n").filter((l) => l.startsWith("• *Approve") || l.startsWith("• *Decline")).length === 4,
    "the copy states ALL FOUR answers in words, one per line, because an arm with no component plane delivers the text alone",
  );
  ok(
    !text.split("\n").some((l) => /^reply\b/iu.test(l.trim())),
    "🔴 …and it never invites a TYPED reply (OPE-1217): a parsed button id is the only route to `approveCredentialGrant`, so copy offering a reply would promise a control no route reads",
  );

  eq(
    GRANT_ONCE_MAX_ATTEMPTS_PER_TURN,
    GRANT_REFUND_CAP_PER_TURN + 1,
    "🔴 the card's attempt ceiling IS the broker's refund cap plus the first call — a drift here would print a bound the broker does not enforce",
  );
  const onceLine = text.split("\n").find((l) => l.startsWith(`• *Approve ${GRANT_MODE_WORDS.once}*`));
  ok(onceLine !== undefined, "the `once` bullet is present");
  ok(
    (onceLine ?? "").includes(String(GRANT_ONCE_MAX_ATTEMPTS_PER_TURN)),
    "…and it states the attempt ceiling, interpolated from the pinned constant rather than typed as prose",
  );
  ok(
    !/one single call/iu.test(onceLine ?? ""),
    "🔴 …and NEVER 'one single call, and the grant is spent' — the burn is a DISPATCHED call, and a blocked attempt refunds, so that sentence undersold what one approval admits (OPE-1198/OPE-1240)",
  );
  ok(
    /in one turn/iu.test(onceLine ?? ""),
    "🔴 …and it SCOPES that ceiling to one turn — the broker's allowance rolls at the turn boundary (both stores reset `refund_count` when `refund_turn` changes), so a bullet stating the number as an absolute ceiling would promise the owner a bound the code does not enforce",
  );
  ok(
    (onceLine ?? "").includes("notion"),
    "…and it names the connector the call would actually reach, so 'one call' is anchored to something the owner recognises",
  );
  eq(quotedPurpose('a "quoted" purpose'), "a quoted purpose", "quotedPurpose strips the characters that would escape the span");
  ok(quotedPurpose("x".repeat(500)).length <= 200, "…and caps the length");
}

console.log("7. the lapse copy:");
{
  const ask = askRow("ask-lapse");
  const lapse = grantResolutionText(ask, { kind: "expired" });
  const declined = grantResolutionText(ask, { kind: "declined" });
  ok(lapse.includes("`notion_fetch`") && lapse.includes(ask.resource), "the lapse notice names the exact tool and resource the room watched being asked for");
  ok(lapse.includes("expired") && lapse.includes("no answer"), "…and says the request TIMED OUT");
  ok(!lapse.includes("declined the credential grant"), "a lapse is NEVER reported as a decline — the owner made no decision at all");
  ok(lapse.includes("did not decline"), "…and it says so out loud, because 'expired' alone reads as a soft no");
  ok(lapse.includes("ask again"), "…so asking again stays open");
  ok(declined.includes("Do not ask again"), "NEGATIVE CONTROL: the DECLINE arm still tells the room to stop — the two arms give opposite advice, so neither can be passing on shared copy");
  ok(!declined.includes("did not decline"), "…and the decline arm carries none of the lapse wording");

  const card = expiredGrantCardText(ask, true);
  ok(card.includes("EXPIRED"), "the owner's card is rewritten to say expired");
  ok(card.includes(`\`${MCP_TOOL}\``) && card.includes(ask.resource), "…and still names what was asked for, so the owner reads one story");
  ok(card.includes("does nothing"), "…and says a tap achieves nothing, which is true whether or not the surface kept the buttons");
  ok(!card.includes(ask.purpose), "the model-authored purpose is NOT replayed into the expired card — it has served its purpose and nothing needs it again");
  ok(grantCardText(ask, "Ada") !== card, "NEGATIVE CONTROL: the expired card is not the live card — a rewrite to identical text would leave the owner an ask that still looks answerable");

  const cardUntold = expiredGrantCardText(ask, false);
  ok(card.includes("has been told"), "when the requester WAS told, the card says so");
  ok(!cardUntold.includes("has been told"), "NEGATIVE CONTROL: when the requester was NOT told, the card does not claim they were");
  ok(cardUntold.includes("NOT been told"), "…it says the opposite out loud, so the owner knows somebody may still be waiting");
}

console.log(`\ncredential-grant: ${n} assertions passed.`);
