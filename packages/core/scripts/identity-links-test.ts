
process.env.OE_SQLITE_PATH = ":memory:";
process.env.OE_OPERATIONAL_PROVIDER = "postgres";

import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { initOperationalSchema, makeOperationalPostgresStore, type PgClient } from "../agent/operational/postgres.js";
import { sqliteOperationalStore } from "../agent/operational/sqlite.js";
import { registerOperationalStore, resetOperationalStore, getOperationalStore } from "../agent/operational/provider.js";
import { OPERATIONAL_TABLES, type LinkChallengeRow, type LinkedIdRow, type OperationalStore } from "../agent/operational/store.js";
import { detectLinkClaim, detectAddressedLinkClaim, hashLinkCode, mintLinkCode, LINK_CODE_ALPHABET, LINK_CODE_LENGTH } from "../agent/identity/link-challenge.js";
import { agentNameTokens } from "../agent/identity/bot-name.js";
import {
  claimLinkChallenge,
  confirmLinkedId,
  confirmedLinkSetPrincipals,
  denyLinkChallenge,
  expandLinkSet,
  issueLinkChallenge,
  listLinkSetsWithIds,
  ratifyLinkChallenge,
  resolveLinkSet,
  revokeLinkSet,
  setLinkSetHold,
  suggestLinkedId,
  unlinkOwnId,
} from "../agent/identity/link-store.js";
import { unionPrincipals } from "../agent/identity/link-resolve.js";
import { observeLinkClaim } from "../agent/hooks/link-claim.js";
import { canDeliverDirectMessage } from "../agent/channels/post-arms.js";
import { directoryLinkSetVaultArmed } from "../agent/connections/connector-flags.js";
import { currentTurnAddressed, currentTurnBotName } from "../agent/identity/binding.js";
import { OE_ADDRESSED_ATTR, OE_BOT_NAME_ATTR } from "../agent/identity/bot-name.js";
import type { BindableContext } from "../agent/identity/binding.js";
import type { Principal } from "../agent/identity/principals.js";
import linkIdentityTool from "../agent/tools/link_identity.js";
import confirmLinkTool from "../agent/tools/confirm_link.js";
import unlinkIdentityTool from "../agent/tools/unlink_identity.js";
import { registerSlackFixtureMapper } from "./_slack-test-stubs.js";

registerSlackFixtureMapper();

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};
async function refuses(fn: () => Promise<unknown>, needle: string, label: string): Promise<void> {
  let msg = "";
  try {
    await fn();
  } catch (e) {
    msg = e instanceof Error ? e.message : String(e);
  }
  ok(msg.length > 0 && msg.toLowerCase().includes(needle.toLowerCase()), `${label} (got: ${msg || "no error"})`);
}

const ORG = "default";
const T1 = "T1";
const db = new PGlite();
const client: PgClient = { query: (text, params) => db.query(text, params ? [...params] : undefined) };
await initOperationalSchema(client);
const pg = makeOperationalPostgresStore(client);
registerOperationalStore(pg);
resetOperationalStore();
ok(getOperationalStore() === pg, "provider: the PGlite-backed postgres store is what link-store.ts will reach");

type ExecTool = { execute(input: unknown, ctx: unknown): Promise<any> };
const linkIdentity = linkIdentityTool as unknown as ExecTool;
const confirmLink = confirmLinkTool as unknown as ExecTool;
const unlinkIdentity = unlinkIdentityTool as unknown as ExecTool;

function ctxFor(opts: { channelId: string; channelType?: string; principalId?: string; dmPartnerTrust?: "internal" | "external" }): BindableContext {
  const attributes: Record<string, string> = { team_id: "T1", channel_id: opts.channelId, trust_checked: "true" };
  if (opts.channelType) attributes.channel_type = opts.channelType;
  if (opts.dmPartnerTrust) attributes.dm_partner_trust = opts.dmPartnerTrust;
  return {
    channel: { kind: "slack" },
    session: { auth: { current: { attributes, principalId: opts.principalId ?? "U1", principalType: "slack-user" } } },
  } as BindableContext;
}
const dmU1 = ctxFor({ channelId: "D1", channelType: "im", principalId: "U1", dmPartnerTrust: "internal" });
const dmU2 = ctxFor({ channelId: "D2", channelType: "im", principalId: "U2", dmPartnerTrust: "internal" });
const channelU1 = ctxFor({ channelId: "C_ENG", principalId: "U1" });
const mpimU1 = ctxFor({ channelId: "G1", channelType: "mpim", principalId: "U1" });

{
  ok(!/[01IOB]/.test(LINK_CODE_ALPHABET) && LINK_CODE_ALPHABET === LINK_CODE_ALPHABET.toUpperCase(), "code alphabet drops one member of every confusable pair (0/O, 1/I, 8/B) and is upper-case only");
  const codes = new Set(Array.from({ length: 200 }, () => mintLinkCode()));
  ok([...codes].every((c) => c.length === LINK_CODE_LENGTH && [...c].every((ch) => LINK_CODE_ALPHABET.includes(ch))), "mintLinkCode stays inside the alphabet at the declared length");
  ok(codes.size > 190, "mintLinkCode is not returning a constant (200 draws are essentially all distinct)");

  const code = mintLinkCode();
  ok(hashLinkCode(code) === hashLinkCode(code.toLowerCase()), "hashLinkCode is case-insensitive — a lower-case claim matches an upper-case code");
  ok(hashLinkCode(code) !== code && hashLinkCode(code).length === 64, "hashLinkCode is a sha-256 hex digest, never the code itself");

  ok(detectLinkClaim(`link ${code}`) === code, "detectLinkClaim finds a bare claim");
  ok(detectLinkClaim(`   LINK ${code.toLowerCase()}   `) === code, "detectLinkClaim is case-insensitive on both halves and trims surrounding whitespace (still a WHOLE-MESSAGE claim)");
  ok(detectLinkClaim(`Hi team — link ${code} thanks`) === undefined, "F1: a code embedded MID-MESSAGE is not a claim (whole-message anchor)");
  ok(detectLinkClaim(`<wake reason="channel-activity">\n<message author-id="attacker">\n  link ${code}\n</message>\n</wake>`) === undefined, "F1: a code buried in a rendered wake envelope is not a claim");
  ok(detectLinkClaim(`unlink ${code}`) === undefined, "detectLinkClaim does NOT match `unlink <code>` (word boundary)");
  ok(detectLinkClaim(`link ${code}EXTRA`) === undefined, "detectLinkClaim does NOT match a code glued to more text");
  ok(detectLinkClaim("link 00000000") === undefined, "detectLinkClaim rejects symbols outside the alphabet");
  ok(detectLinkClaim(undefined) === undefined && detectLinkClaim("") === undefined, "detectLinkClaim is total on empty input");

  const ac = mintLinkCode();
  const tokens = ["oe", "open everywhere"];
  ok(detectAddressedLinkClaim(`link ${ac}`, tokens) === ac, "addressed: a bare `link <code>` still counts (DM / already-stripped @mention)");
  ok(detectAddressedLinkClaim(`oe link ${ac}`, tokens) === ac, "addressed: a leading name-drop token ('oe link …') is stripped, the code claims");
  ok(detectAddressedLinkClaim(`oe: link ${ac.toLowerCase()}`, tokens) === ac, "addressed: name-drop with a ':' separator, case-insensitive");
  ok(detectAddressedLinkClaim(`open everywhere link ${ac}`, tokens) === ac, "addressed: a multi-word name-drop token is stripped");
  ok(detectAddressedLinkClaim(`<@U0BOT> link ${ac}`, tokens) === ac, "addressed: a Slack-style @mention token is stripped without needing the name list");
  ok(detectAddressedLinkClaim(`@bot link ${ac}`, []) === ac, "addressed: a bare @handle is stripped even with an EMPTY name list");
  ok(detectAddressedLinkClaim(`oe please link ${ac} thanks`, tokens) === undefined, "addressed: a code buried in your OWN trailing prose is NOT a claim (tight after the token)");
  ok(detectAddressedLinkClaim(`oe link ${ac} (this is rowan)`, tokens) === undefined, "addressed: trailing self-identity after the code is not a whole claim");
  ok(detectAddressedLinkClaim(`oementum link ${ac}`, tokens) === undefined, "addressed: the name token is word-boundary matched (not stripped inside 'oementum')");
  ok(detectAddressedLinkClaim(`hey team, here is link ${ac} for you`, tokens) === undefined, "addressed: no leading address token ⇒ not a claim (still tight)");

  const mkCtx = (attrs: Record<string, string>): BindableContext =>
    ({ channel: { kind: "notion" }, session: { auth: { current: { attributes: attrs, principalId: "P", principalType: "notion-user" } } } }) as BindableContext;
  ok(currentTurnAddressed(mkCtx({ [OE_ADDRESSED_ATTR]: "1" })) === true, "currentTurnAddressed: the oe_addressed='1' host stamp reads true");
  ok(currentTurnAddressed(mkCtx({ oe_addressing: "direct-mention" })) === true, "currentTurnAddressed: the single-window oe_addressing='direct-mention' stamp also means addressed");
  ok(currentTurnAddressed(mkCtx({ team_id: "T1" })) === false, "currentTurnAddressed: no stamp ⇒ false (fail-closed to the strict judged path)");
  ok(currentTurnBotName(mkCtx({ [OE_BOT_NAME_ATTR]: "Aria" })) === "Aria", "currentTurnBotName: reads the resolved integration name stamp");
  ok(currentTurnBotName(mkCtx({})) === undefined, "currentTurnBotName: undefined when unstamped");
}

{
  const issued = await issueLinkChallenge({ org: ORG, platform: "slack", tenant: T1, nativeId: "U1", surfaceKey: "slack/T1/D1" });
  ok(issued.challenge.status === "pending" && issued.challenge.claimedNativeId === undefined, "issue: a fresh challenge is pending and unclaimed");
  const stored = await pg.getLinkChallenge(ORG, issued.challenge.id);
  ok(stored?.nonceHash === hashLinkCode(issued.code), "issue: the row stores the HASH of the code");
  ok(!JSON.stringify(stored).includes(issued.code), "issue: the raw code appears NOWHERE on the stored row");

  ok((await claimLinkChallenge({ org: ORG, code: issued.code, claimant: { platform: "slack", tenant: T1, nativeId: "U1" } })) === null, "claim: the INITIATOR's own account cannot claim its own code (a DM echo must not burn it)");
  ok((await pg.getLinkChallenge(ORG, issued.challenge.id))?.status === "pending", "claim: a refused self-claim leaves the code still pending");

  const claimed = await claimLinkChallenge({ org: ORG, code: issued.code, claimant: { platform: "github", tenant: "", nativeId: "example-owner" } });
  ok(claimed?.status === "claimed" && claimed.claimedPlatform === "github" && claimed.claimedNativeId === "example-owner", "claim: stamps the claimant and moves pending→claimed");

  ok((await claimLinkChallenge({ org: ORG, code: issued.code, claimant: { platform: "linear", tenant: "", nativeId: "lin-9" } })) === null, "claim: SINGLE-USE — a second claimer of a spent nonce is refused");
  ok((await pg.getLinkChallenge(ORG, issued.challenge.id))?.claimedNativeId === "example-owner", "claim: the second claimer did not overwrite the first");

  const ratified = await ratifyLinkChallenge({ org: ORG, challengeId: issued.challenge.id, handle: "slack/T1/U1" });
  ok(ratified.ok, "ratify: a claimed challenge commits");
  ok((await pg.getLinkChallenge(ORG, issued.challenge.id))?.status === "ratified", "ratify: the challenge is terminal (ratified)");
  const set = ratified.ok ? await expandLinkSet(ORG, ratified.linkSetId) : [];
  const pairs = set.map((a) => (a.tenant ? `${a.platform}/${a.tenant}/${a.nativeId}` : `${a.platform}/${a.nativeId}`)).sort();
  assert.deepEqual(pairs, ["github/example-owner", "slack/T1/U1"], "ratify: EXACTLY the initiator + the claimed pair are linked, nothing else");
  n++;
  ok((await ratifyLinkChallenge({ org: ORG, challengeId: issued.challenge.id, handle: "x" })).ok === false, "ratify: a second ratification of the same challenge is refused");

  const denyIssue = await issueLinkChallenge({ org: ORG, platform: "slack", tenant: T1, nativeId: "U_DENY", surfaceKey: "slack/T1/D9" });
  await claimLinkChallenge({ org: ORG, code: denyIssue.code, claimant: { platform: "github", tenant: "", nativeId: "attacker" } });
  ok(await denyLinkChallenge({ org: ORG, challengeId: denyIssue.challenge.id }), "deny: a claimed challenge can be denied");
  ok((await pg.getLinkedId(ORG, "github", "", "attacker")) === null, "deny: NOTHING was written — the claimant holds no link row");
  ok((await pg.getLinkedId(ORG, "slack", T1, "U_DENY")) === null, "deny: the initiator is not linked either");
  ok((await denyLinkChallenge({ org: ORG, challengeId: denyIssue.challenge.id })) === false, "deny: denial is terminal — a second deny is refused");
  ok((await ratifyLinkChallenge({ org: ORG, challengeId: denyIssue.challenge.id, handle: "x" })).ok === false, "deny: a denied challenge can never be ratified afterwards");

  const past = new Date(Date.now() - 60 * 60_000);
  const stale = await issueLinkChallenge({ org: ORG, platform: "slack", tenant: T1, nativeId: "U_STALE", surfaceKey: "slack/T1/D8", now: past });
  ok((await claimLinkChallenge({ org: ORG, code: stale.code, claimant: { platform: "github", tenant: "", nativeId: "late" } })) === null, "expiry: a code past its TTL cannot be claimed");
  ok((await pg.expireLinkChallenges(ORG, new Date().toISOString())) >= 1, "expiry: the sweep marks still-open expired challenges");
  ok((await pg.getLinkChallenge(ORG, stale.challenge.id))?.status === "expired", "expiry: the swept challenge is `expired`");
  ok((await ratifyLinkChallenge({ org: ORG, challengeId: stale.challenge.id, handle: "x" })).ok === false, "expiry: an expired challenge cannot be ratified");

  const raced = await issueLinkChallenge({ org: ORG, platform: "slack", tenant: T1, nativeId: "U_RACE", surfaceKey: "slack/T1/D7" });
  await claimLinkChallenge({ org: ORG, code: raced.code, claimant: { platform: "github", tenant: "", nativeId: "racer" } });
  await pg.expireLinkChallenges(ORG, new Date(Date.now() + 60 * 60_000).toISOString());
  ok((await ratifyLinkChallenge({ org: ORG, challengeId: raced.challenge.id, handle: "x" })).ok === false, "expiry: the TTL bounds the WHOLE flow — a claimed-then-expired challenge cannot be ratified");
  ok((await pg.getLinkedId(ORG, "github", "", "racer")) === null, "expiry: nothing was written for the expired claim");

  const ttl = await issueLinkChallenge({ org: ORG, platform: "slack", tenant: T1, nativeId: "U_TTL", surfaceKey: "slack/T1/DT", now: past });
  const ttlClaimed = await claimLinkChallenge({ org: ORG, code: ttl.code, claimant: { platform: "github", tenant: "", nativeId: "ttl-gh" }, now: past });
  ok(ttlClaimed?.status === "claimed", "F7 setup: the challenge was claimed while still valid");
  ok((await pg.getLinkChallenge(ORG, ttl.challenge.id))?.status === "claimed", "F7 setup: the row is still `claimed` on disk — no sweep has run");
  const ttlRatify = await ratifyLinkChallenge({ org: ORG, challengeId: ttl.challenge.id, handle: "x" });
  ok(ttlRatify.ok === false, "F7: a claimed-but-expired challenge cannot be ratified WITHOUT a prior sweep (TTL is enforced inside the CAS)");
  ok((await pg.getLinkedId(ORG, "github", "", "ttl-gh")) === null, "F7: nothing was written for the expired ratification");
}

{
  const foreignSet = "dir-person-x";
  await pg.putLinkSet(ORG, { org: ORG, id: foreignSet, handle: "person-x", status: "active", createdAt: "2026-01-10T12:20:00Z", updatedAt: "2026-01-10T12:20:00Z" });
  await pg.insertLinkedId(ORG, { org: ORG, linkSetId: foreignSet, platform: "slack", tenant: T1, nativeId: "PERSON_X", status: "confirmed", establishedBy: "challenge:x-real", createdAt: "z", updatedAt: "z" });
  const sug = await suggestLinkedId({ org: ORG, linkSetId: foreignSet, account: { platform: "slack", tenant: T1, nativeId: "U_INIT3" }, evidence: { kind: "directory-sync", provider: "okta", grade: "email-match" } });
  ok(sug.ok, "F3 setup: the initiator's account is merely SUGGESTED into person X's set");

  const ch = await issueLinkChallenge({ org: ORG, platform: "slack", tenant: T1, nativeId: "U_INIT3", surfaceKey: "slack/T1/DZ" });
  await claimLinkChallenge({ org: ORG, code: ch.code, claimant: { platform: "github", tenant: "", nativeId: "u-init3-gh" } });
  const rat = await ratifyLinkChallenge({ org: ORG, challengeId: ch.challenge.id, handle: "slack/T1/U_INIT3" });
  ok(rat.ok, "F3: the legitimate challenge ratifies");
  ok(rat.ok && rat.linkSetId !== foreignSet, "F3: ratify used the initiator's OWN set, NOT the set it was only suggested into");

  const xMembers = (await expandLinkSet(ORG, foreignSet)).map((a) => (a.tenant ? `${a.platform}/${a.tenant}/${a.nativeId}` : `${a.platform}/${a.nativeId}`)).sort();
  assert.deepEqual(xMembers, ["slack/T1/PERSON_X"], "F3: person X's set did NOT absorb the initiator or the claimed account");
  n++;
  const ownMembers = rat.ok ? (await expandLinkSet(ORG, rat.linkSetId)).map((a) => (a.tenant ? `${a.platform}/${a.tenant}/${a.nativeId}` : `${a.platform}/${a.nativeId}`)).sort() : [];
  assert.deepEqual(ownMembers, ["github/u-init3-gh", "slack/T1/U_INIT3"], "F3: the initiator and the claimed account ARE linked, in the initiator's own set");
  n++;
  ok((await pg.getLinkedId(ORG, "slack", T1, "U_INIT3"))?.linkSetId === (rat.ok ? rat.linkSetId : ""), "F3: the stale suggestion was dropped — the initiator's account now lives in its own set");
}

{
  const other = await issueLinkChallenge({ org: ORG, platform: "slack", tenant: T1, nativeId: "U_OTHER", surfaceKey: "slack/T1/D3" });
  await claimLinkChallenge({ org: ORG, code: other.code, claimant: { platform: "github", tenant: "", nativeId: "example-owner" } });
  const dup = await ratifyLinkChallenge({ org: ORG, challengeId: other.challenge.id, handle: "slack/T1/U_OTHER" });
  ok(dup.ok === false && !dup.ok && dup.reason.includes("exactly one person"), "invariant 1 (API): a second person cannot ratify an account another link-set already holds");
  const stillRowan = await resolveLinkSet(ORG, "github", "example-owner", "");
  ok(stillRowan !== null, "invariant 1 (API): the original owner keeps the account");
  ok((await pg.getLinkedId(ORG, "slack", T1, "U_OTHER")) === null, "invariant 1 (API): the refused ratification wrote NOTHING at all, not even the initiator's own id");

  const owner = (await pg.getLinkedId(ORG, "github", "", "example-owner"))!;
  const foreign: LinkedIdRow = { ...owner, linkSetId: "some-other-set", status: "confirmed", establishedBy: "challenge:forged", createdAt: owner.createdAt, updatedAt: owner.updatedAt };
  ok((await pg.insertLinkedId(ORG, foreign)) === false, "invariant 1 (DB, postgres): the (org, platform, native_id) PRIMARY KEY refuses a second row for one account");
  ok((await pg.getLinkedId(ORG, "github", "", "example-owner"))?.linkSetId === owner.linkSetId, "invariant 1 (DB, postgres): the refused insert did not repoint the account");

  ok((await pg.insertLinkedId("acme", { ...foreign, org: "acme" })) === true, "org isolation: another org may hold the same (platform, native_id)");
  ok((await resolveLinkSet(ORG, "github", "example-owner", ""))?.id === owner.linkSetId, "org isolation: the other org's row does not leak into this one");

  const sugSet = "set-suggest";
  await pg.putLinkSet(ORG, { org: ORG, id: sugSet, handle: "slack/T1/U_SUG", status: "active", createdAt: "2026-01-10T12:20:00Z", updatedAt: "2026-01-10T12:20:00Z" });
  const suggested = await suggestLinkedId({ org: ORG, linkSetId: sugSet, account: { platform: "linear", tenant: "", nativeId: "lin-77" }, evidence: { kind: "directory-sync", provider: "okta", grade: "scim" } });
  ok(suggested.ok, "evidence: a directory sync may record a SUGGESTED account");
  ok((await pg.getLinkedId(ORG, "linear", "", "lin-77"))?.status === "suggested", "evidence: it lands as `suggested`, not `confirmed`");
  ok((await resolveLinkSet(ORG, "linear", "lin-77", "")) === null, "evidence: a `suggested` account resolves to NOTHING — attribution is unchanged until it is proven");
  ok((await expandLinkSet(ORG, sugSet)).length === 0, "evidence: expandLinkSet excludes suggested accounts");

  const confirmed = await confirmLinkedId({ org: ORG, account: { platform: "linear", tenant: "", nativeId: "lin-77" }, evidence: { kind: "challenge", challengeId: "chal-xyz" } });
  ok(confirmed.ok, "evidence: suggested → confirmed with evidence succeeds");
  const confRow = (await pg.getLinkedId(ORG, "linear", "", "lin-77"))!;
  ok(confRow.status === "confirmed" && confRow.establishedBy === "challenge:chal-xyz", "evidence: WHAT confirmed it is recorded on the row (establishedBy)");
  ok(JSON.parse(confRow.evidenceJson ?? "{}").challengeId === "chal-xyz", "evidence: the structured evidence record round-trips for later phases");
  ok((await resolveLinkSet(ORG, "linear", "lin-77", ""))?.id === sugSet, "evidence: a confirmed account now resolves");
  ok((await confirmLinkedId({ org: ORG, account: { platform: "linear", tenant: "", nativeId: "nope" }, evidence: { kind: "config-import", note: "x" } })).ok === false, "evidence: confirming an account on no link-set is refused");

  const revoked = await revokeLinkSet({ org: ORG, linkSetId: sugSet, actor: "admin@example" });
  ok(revoked.ok, "revoke: an active set can be revoked");
  ok((await pg.getLinkSet(ORG, sugSet))?.status === "revoked", "revoke: the set is revoked");
  ok((await pg.getLinkedId(ORG, "linear", "", "lin-77"))?.status === "revoked", "revoke: every account on the set is tombstoned");
  ok((await resolveLinkSet(ORG, "linear", "lin-77", "")) === null, "revoke: a tombstoned account resolves to nothing");
  ok((await pg.insertLinkedId(ORG, { org: ORG, linkSetId: "brand-new", platform: "linear", tenant: "", nativeId: "lin-77", status: "confirmed", establishedBy: "challenge:x", createdAt: "z", updatedAt: "z" })) === false, "revoke: a tombstone keeps the PK, so the account cannot be re-linked by a later challenge");
  ok((await confirmLinkedId({ org: ORG, account: { platform: "linear", tenant: "", nativeId: "lin-77" }, evidence: { kind: "challenge", challengeId: "c2" } })).ok === false, "revoke: a revoked row can NEVER be re-confirmed (terminal)");
  ok((await setLinkSetHold({ org: ORG, linkSetId: sugSet, hold: "active", actor: "admin@example" })).ok === false, "revoke: a revoked SET can never be reactivated (terminal)");
  ok((await revokeLinkSet({ org: ORG, linkSetId: sugSet, actor: "admin@example" })).ok === false, "revoke: revoking twice is refused");

  const held = (await resolveLinkSet(ORG, "github", "example-owner", ""))!;
  ok((await setLinkSetHold({ org: ORG, linkSetId: held.id, hold: "suspended", actor: "admin@example" })).ok, "suspend: an active set can be held");
  ok((await resolveLinkSet(ORG, "github", "example-owner", "")) === null, "suspend: a held set resolves to nothing (attribution degrades to per-surface)");
  ok((await expandLinkSet(ORG, held.id)).length === 0, "suspend: a held set expands to nothing");
  ok((await setLinkSetHold({ org: ORG, linkSetId: held.id, hold: "active", actor: "admin@example" })).ok, "reactivate: the hold lifts");
  ok((await resolveLinkSet(ORG, "github", "example-owner", ""))?.id === held.id, "reactivate: the set resolves again");
  ok((await setLinkSetHold({ org: ORG, linkSetId: "no-such-set", hold: "suspended", actor: "a" })).ok === false, "suspend: an unknown set is refused, not silently created");
}

{
  const sq: OperationalStore = sqliteOperationalStore;
  const now = "2026-01-14T12:20:00Z";
  await sq.putLinkSet(ORG, { org: ORG, id: "s1", handle: "slack/T1/U1", status: "active", createdAt: now, updatedAt: now });
  const row: LinkedIdRow = { org: ORG, linkSetId: "s1", platform: "github", tenant: "", nativeId: "gh1", status: "confirmed", establishedBy: "challenge:c1", createdAt: now, updatedAt: now };
  ok((await sq.insertLinkedId(ORG, row)) === true, "sqlite: first insert of an account wins");
  ok((await sq.insertLinkedId(ORG, { ...row, linkSetId: "s2" })) === false, "sqlite: the (org, platform, native_id) PRIMARY KEY refuses a second person's claim on that account");
  ok((await sq.getLinkedId(ORG, "github", "", "gh1"))?.linkSetId === "s1", "sqlite: the original owner is untouched");

  const ch: LinkChallengeRow = {
    org: ORG,
    id: "c-sq",
    nonceHash: hashLinkCode("ABCDEFGH"),
    initiatingPlatform: "slack",
    initiatingTenant: T1,
    initiatingNativeId: "U1",
    initiatingSurfaceKey: "slack/T1/D1",
    status: "pending",
    createdAt: now,
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
  };
  await sq.addLinkChallenge(ORG, ch);
  ok((await sq.claimLinkChallenge(ORG, ch.nonceHash, "slack", T1, "U1", new Date().toISOString())) === null, "sqlite: the initiator cannot self-claim");
  const sqClaimed = await sq.claimLinkChallenge(ORG, ch.nonceHash, "github", "", "gh2", new Date().toISOString());
  ok(sqClaimed?.claimedNativeId === "gh2", "sqlite: the claim CAS stamps the claimant and returns the row");
  ok((await sq.claimLinkChallenge(ORG, ch.nonceHash, "linear", "", "l1", new Date().toISOString())) === null, "sqlite: single-use — a second claimer is refused");
  ok((await sq.decideLinkChallenge(ORG, "c-sq", ["claimed"], "ratified", now)) === true, "sqlite: a claimed challenge can be decided");
  ok((await sq.decideLinkChallenge(ORG, "c-sq", ["claimed"], "denied", now)) === false, "sqlite: a decided challenge is terminal");
  ok((await sq.updateLinkedIdStatus(ORG, "github", "", "gh1", ["suggested", "confirmed"], "revoked", "x", undefined, now)) === true, "sqlite: a status CAS lands from a legal `from`");
  ok((await sq.updateLinkedIdStatus(ORG, "github", "", "gh1", ["suggested", "confirmed"], "confirmed", "x", undefined, now)) === false, "sqlite: `revoked` is never a legal `from` — the CAS refuses, so revocation is terminal at the query layer");

  const expCh: LinkChallengeRow = {
    org: ORG, id: "c-sq-exp", nonceHash: hashLinkCode("PQRSTUVW"),
    initiatingPlatform: "slack", initiatingTenant: T1, initiatingNativeId: "U_TTL", initiatingSurfaceKey: "slack/T1/D1",
    status: "pending", createdAt: now, expiresAt: new Date(Date.now() - 600_000).toISOString(),
  };
  await sq.addLinkChallenge(ORG, expCh);
  const sqExpClaim = await sq.claimLinkChallenge(ORG, expCh.nonceHash, "github", "", "ttl-z", new Date(Date.now() - 700_000).toISOString());
  ok(sqExpClaim?.status === "claimed", "sqlite F7 setup: the challenge was claimed while still valid");
  ok((await sq.decideLinkChallenge(ORG, "c-sq-exp", ["claimed"], "ratified", new Date().toISOString())) === false, "sqlite F7: the ratified CAS refuses a claimed-but-EXPIRED challenge (TTL conjunct in the statement)");
  ok((await sq.decideLinkChallenge(ORG, "c-sq-exp", ["claimed"], "denied", new Date().toISOString())) === true, "sqlite F7: a DENY carries NO TTL conjunct — an expired claim can still be denied");

  ok(OPERATIONAL_TABLES.includes("identity_link_sets") && OPERATIONAL_TABLES.includes("identity_linked_ids") && OPERATIONAL_TABLES.includes("identity_link_challenges"), "the three tables are in OPERATIONAL_TABLES (the migrator's canonical list)");
}

{
  const issued = await issueLinkChallenge({ org: ORG, platform: "slack", tenant: T1, nativeId: "U_HOOK", surfaceKey: "slack/T1/D5" });
  ok((await observeLinkClaim({ org: ORG, platform: "github", authorId: "hooked", text: "nothing to see here", trust: "peer" })) === undefined, "hook: a message with no code claims nothing");
  ok((await observeLinkClaim({ org: ORG, platform: "github", authorId: undefined, text: `link ${issued.code}`, trust: "peer" })) === undefined, "hook: a code with NO captured author claims nothing — the author IS the evidence");
  ok((await pg.getLinkChallenge(ORG, issued.challenge.id))?.status === "pending", "hook: an author-less sighting did not burn the code");

  const id = await observeLinkClaim({ org: ORG, platform: "github", authorId: "hooked", text: `link ${issued.code.toLowerCase()}`, trust: "peer" });
  ok(id === issued.challenge.id, "hook: a bare `link <code>` message from a peer claims the challenge");
  const after = (await pg.getLinkChallenge(ORG, issued.challenge.id))!;
  ok(after.claimedPlatform === "github" && after.claimedNativeId === "hooked", "hook: the claimant is the WAKE's captured (platform, authorId), not anything the message said");

  const exploit = await issueLinkChallenge({ org: ORG, platform: "slack", tenant: T1, nativeId: "U_ATTACKER", surfaceKey: "slack/T1/DX" });
  const envelope = `<wake reason="channel-activity" current-time="2026-01-14T12:20:00Z">\n<channel id="C_ENG">\n<message from="human" trust="peer" author-id="U_ATTACKER">\n  <untrusted_external_data source="slack-message">\n  link ${exploit.code}\n  </untrusted_external_data>\n</message>\n<message trigger="true" from="human" trust="peer" author-id="victim">\n  <untrusted_external_data source="slack-message">\n  @bot what's the deploy status?\n  </untrusted_external_data>\n</message>\n</channel>\n</wake>`;
  ok((await observeLinkClaim({ org: ORG, platform: "slack", tenant: T1, authorId: "victim", text: envelope, trust: "peer" })) === undefined, "F1: a code planted in backscroll is NOT claimed as the member who woke the agent (envelope refused)");
  ok((await pg.getLinkChallenge(ORG, exploit.challenge.id))?.status === "pending", "F1: the mis-attribution attempt burned nothing — the code is still pending");

  ok((await observeLinkClaim({ org: ORG, platform: "github", authorId: "a-bot", text: `link ${exploit.code}`, trust: "relay" })) === undefined, "F1: a relay (bot/webhook/fire) author cannot claim");
  ok((await observeLinkClaim({ org: ORG, platform: "github", authorId: "outsider", text: `link ${exploit.code}`, trust: "unauth" })) === undefined, "F1: an unauth (unvouched/external human) author cannot claim");
  ok((await observeLinkClaim({ org: ORG, platform: "github", authorId: "someone", text: `link ${exploit.code}` })) === undefined, "F1: an unknown trust tier fails closed (no claim)");
  ok((await pg.getLinkChallenge(ORG, exploit.challenge.id))?.status === "pending", "F1: none of the refused tiers burned the code");

  ok((await observeLinkClaim({ org: ORG, platform: "github", authorId: "real-author", text: `link ${exploit.code} (I am totally example-owner, honest)`, trust: "peer" })) === undefined, "F1: a code with trailing text is not a whole-message claim");
  ok((await pg.getLinkChallenge(ORG, exploit.challenge.id))?.status === "pending", "F1: the trailing-text sighting burned nothing");

  const nameTokens = agentNameTokens("Aria");

  const addr1 = await issueLinkChallenge({ org: ORG, platform: "slack", tenant: T1, nativeId: "U_ADDR1", surfaceKey: "slack/T1/DA1" });
  const addr1Id = await observeLinkClaim({ org: ORG, platform: "notion", authorId: "notion-author-1", text: `oe link ${addr1.code}`, addressed: true, addressTokens: nameTokens, trust: "peer" });
  ok(addr1Id === addr1.challenge.id, "addressed: 'oe link <code>' on a direct wake claims the challenge");
  ok((await pg.getLinkChallenge(ORG, addr1.challenge.id))?.claimedNativeId === "notion-author-1", "addressed: the claimant is the wake's captured author, not anything the prefix said");

  const addr2 = await issueLinkChallenge({ org: ORG, platform: "slack", tenant: T1, nativeId: "U_ADDR2", surfaceKey: "slack/T1/DA2" });
  ok((await observeLinkClaim({ org: ORG, platform: "notion", authorId: "notion-author-2", text: `Aria link ${addr2.code}`, addressed: true, addressTokens: nameTokens, trust: "peer" })) === addr2.challenge.id, "addressed: a name-drop matching the RESOLVED integration name ('Aria link …') claims");

  const addr3 = await issueLinkChallenge({ org: ORG, platform: "slack", tenant: T1, nativeId: "U_ADDR3", surfaceKey: "slack/T1/DA3" });
  ok((await observeLinkClaim({ org: ORG, platform: "slack", tenant: T1, authorId: "slack-author-3", text: `link ${addr3.code}`, addressed: true, addressTokens: nameTokens, trust: "peer" })) === addr3.challenge.id, "addressed: a bare 'link <code>' (DM / @mention with no prefix) still claims");

  const addr4 = await issueLinkChallenge({ org: ORG, platform: "slack", tenant: T1, nativeId: "U_ADDR4", surfaceKey: "slack/T1/DA4" });
  ok((await observeLinkClaim({ org: ORG, platform: "notion", authorId: "notion-author-4", text: `oe link ${addr4.code}`, addressTokens: nameTokens, trust: "peer" })) === undefined, "fail-closed: a missing addressing flag ⇒ judged ⇒ strict ⇒ 'oe link <code>' is NOT a claim");
  ok((await pg.getLinkChallenge(ORG, addr4.challenge.id))?.status === "pending", "fail-closed: the un-addressed prefixed sighting burned nothing");

  const f1 = await issueLinkChallenge({ org: ORG, platform: "slack", tenant: T1, nativeId: "U_F1ADDR", surfaceKey: "slack/T1/DF1" });
  const f1Envelope = `<wake reason="channel-activity" current-time="2026-01-15T12:20:00Z">\n<channel id="C_ENG">\n<message from="human" trust="peer" author-id="U_ATTACKER">\n  <untrusted_external_data source="notion-message">\n  link ${f1.code}\n  </untrusted_external_data>\n</message>\n<message trigger="true" from="human" trust="peer" author-id="victim">\n  <untrusted_external_data source="notion-message">\n  oe what's the status?\n  </untrusted_external_data>\n</message>\n</channel>\n</wake>`;
  ok((await observeLinkClaim({ org: ORG, platform: "notion", authorId: "victim", text: f1Envelope, addressed: false, addressTokens: nameTokens, trust: "peer" })) === undefined, "F1 (judged): a code planted in a multi-author envelope is NOT claimed as the victim who woke the agent");
  ok((await observeLinkClaim({ org: ORG, platform: "notion", authorId: "victim", text: f1Envelope, addressed: true, addressTokens: nameTokens, trust: "peer" })) === undefined, "F1 (defense-in-depth): even if addressing were wrongly asserted, envelope-shaped text is refused by the belt");
  ok((await pg.getLinkChallenge(ORG, f1.challenge.id))?.status === "pending", "F1: neither envelope attempt burned the code — still pending");

  const addr5 = await issueLinkChallenge({ org: ORG, platform: "slack", tenant: T1, nativeId: "U_ADDR5", surfaceKey: "slack/T1/DA5" });
  ok((await observeLinkClaim({ org: ORG, platform: "notion", authorId: "a-bot", text: `oe link ${addr5.code}`, addressed: true, addressTokens: nameTokens, trust: "relay" })) === undefined, "addressed: a relay author cannot claim even on a direct wake (trust gate unchanged)");
  ok((await observeLinkClaim({ org: ORG, platform: "notion", authorId: "outsider", text: `oe link ${addr5.code}`, addressed: true, addressTokens: nameTokens, trust: "unauth" })) === undefined, "addressed: an unauth author cannot claim even on a direct wake");
  ok((await pg.getLinkChallenge(ORG, addr5.challenge.id))?.status === "pending", "addressed: the refused trust tiers burned nothing on the direct wake");

  const notices: string[] = [];
  const recorder = (text: string): void => void notices.push(text);

  const ev1 = await issueLinkChallenge({ org: ORG, platform: "slack", tenant: T1, nativeId: "U_EV1", surfaceKey: "slack/T1/DE1" });
  const ev1Id = await observeLinkClaim({ org: ORG, platform: "github", authorId: "gh-claimant", text: `link ${ev1.code}`, trust: "unauth", trustIsEvidence: false, notifyRefusal: recorder });
  ok(ev1Id === ev1.challenge.id, "evidence-scoping: an `unauth` claim from a platform whose verdict is NOT evidence (github) CLAIMS — the headline flow works on a stock deployment");
  ok((await pg.getLinkChallenge(ORG, ev1.challenge.id))?.claimedNativeId === "gh-claimant", "evidence-scoping: the claimant is still the wake's captured author");
  ok(notices.length === 0, "evidence-scoping: a successful claim posts no refusal notice");

  const ev2 = await issueLinkChallenge({ org: ORG, platform: "slack", tenant: T1, nativeId: "U_EV2", surfaceKey: "slack/T1/DE2" });
  ok((await observeLinkClaim({ org: ORG, platform: "slack", tenant: T1, authorId: "slack-outsider", text: `link ${ev2.code}`, trust: "unauth", trustIsEvidence: true, notifyRefusal: recorder })) === undefined, "evidence-scoping: an `unauth` claim on an EVIDENCE platform (slack) is still refused");
  ok((await pg.getLinkChallenge(ORG, ev2.challenge.id))?.status === "pending", "evidence-scoping: the refused evidence-platform claim burned nothing");
  ok(notices.length === 1 && /can't confirm this surface is inside your organization/.test(notices[0]!), "visibility: the tier refusal is REPORTED to the claimant, not just logged");

  ok((await observeLinkClaim({ org: ORG, platform: "slack", tenant: T1, authorId: "slack-outsider", text: `link ${ev2.code}`, trust: "unauth" })) === undefined, "evidence-scoping: an ABSENT trustIsEvidence defaults to evidence ⇒ refused (fail-closed)");

  const relayNotices = notices.length;
  ok((await observeLinkClaim({ org: ORG, platform: "github", authorId: "a-bot", text: `link ${ev2.code}`, trust: "relay", trustIsEvidence: false, notifyRefusal: recorder })) === undefined, "evidence-scoping: `relay` is refused even where the trust verdict is NOT evidence — machine-ness is platform-independent");
  ok((await observeLinkClaim({ org: ORG, platform: "github", authorId: "nobody", text: `link ${ev2.code}`, trustIsEvidence: false, notifyRefusal: recorder })) === undefined, "evidence-scoping: an UNKNOWN tier still fails closed even where the verdict is not evidence");
  ok((await pg.getLinkChallenge(ORG, ev2.challenge.id))?.status === "pending", "evidence-scoping: neither relay nor unknown-tier burned the code");
  ok(notices.length === relayNotices, "visibility: a relay / unknown-tier refusal posts NO notice (nobody to tell)");

  notices.length = 0;
  ok((await observeLinkClaim({ org: ORG, platform: "github", authorId: "gh-someone", text: `link ${mintLinkCode()}`, trust: "peer", notifyRefusal: recorder })) === undefined, "CAS null: a well-formed code that never existed claims nothing");
  ok((await observeLinkClaim({ org: ORG, platform: "github", authorId: "gh-someone-else", text: `link ${ev1.code}`, trust: "peer", notifyRefusal: recorder })) === undefined, "CAS null: an already-claimed code claims nothing a second time");
  ok(notices.length === 2 && notices[0] === notices[1], "visibility: an unknown code and a SPENT code produce the IDENTICAL notice — no oracle over the code space");
  ok(/didn't work/.test(notices[0]!) && !new RegExp(ev1.code, "i").test(notices[0]!), "visibility: the CAS-null notice is actionable and never echoes the code back");

  for (const id of [addr1.challenge.id, addr2.challenge.id, addr3.challenge.id, addr4.challenge.id, addr5.challenge.id, f1.challenge.id, ev1.challenge.id, ev2.challenge.id]) {
    await denyLinkChallenge({ org: ORG, challengeId: id });
  }

  await denyLinkChallenge({ org: ORG, challengeId: exploit.challenge.id });
  await denyLinkChallenge({ org: ORG, challengeId: after.id });
}

{
  const rowan: Principal = { name: "Rowan Hale", handle: "rowan", ids: { slack: "U0EXOWNER", github: "example-owner" } };
  const sarah: Principal = { name: "Sarah Kim", ids: { linear: "lin-uuid-1" } };

  const configOnly = unionPrincipals([rowan, sarah], []);
  ok(configOnly.principals.length === 2 && configOnly.warnings.length === 0, "union: config-only passes the reviewed map straight through");
  assert.deepEqual(configOnly.principals[0]!.ids, rowan.ids, "union: a config entry with no DB counterpart is byte-identical");
  n++;

  const dbOnly = unionPrincipals([], [{ linkSetId: "ls1", handle: "slack/T1/U9", ids: { slack: "U9", github: "ninelives" } }]);
  ok(dbOnly.principals.length === 1 && dbOnly.warnings.length === 0, "union: DB-only produces one entry");
  ok(dbOnly.principals[0]!.name === "slack/T1/U9" && dbOnly.principals[0]!.ids.github === "ninelives", "union: a DB-only entry is named by its (display-only) handle and carries its confirmed ids");

  const disjoint = unionPrincipals([rowan], [{ linkSetId: "ls2", handle: "slack/T1/U9", ids: { slack: "U9" } }]);
  ok(disjoint.principals.length === 2 && disjoint.warnings.length === 0, "union: disjoint sources produce both people, no warning");

  const merged = unionPrincipals([rowan], [{ linkSetId: "ls3", handle: "rowan", ids: { slack: "U0EXOWNER", linear: "lin-rowan" } }]);
  ok(merged.principals.length === 1 && merged.warnings.length === 0, "union: a shared ACCOUNT (never a shared name) merges the two into one person");
  ok(merged.principals[0]!.name === "Rowan Hale", "union: the merged entry keeps the REVIEWED name, not the link-set handle");
  ok(merged.principals[0]!.ids.linear === "lin-rowan" && merged.principals[0]!.ids.github === "example-owner", "union: the merged entry gains the DB's extra surface and keeps config's");

  const conflict = unionPrincipals([rowan, sarah], [{ linkSetId: "ls4", handle: "someone-else", ids: { github: "example-owner", linear: "lin-uuid-1" } }]);
  ok(conflict.warnings.length > 0, "union: a (platform, id) claimed by two different people produces a LOUD warning");
  ok(
    conflict.warnings.some((w) => w.key === "github/example-owner"),
    "union: the warning names the disputed account by its COMPOSED PRINCIPAL KEY (OPE-350 — PrincipalSurfaceIds now carries the workspace, so there is a real key to quote instead of prose)",
  );
  ok(conflict.warnings.every((w) => w.message.includes("NO merge")), "union: the warning says plainly that no merge was applied");
  const rowanOut = conflict.principals.find((p) => p.name === "Rowan Hale")!;
  ok(rowanOut.ids.github === undefined, "union: the disputed account is DROPPED from the config entry (fail-closed on merge)");
  ok(rowanOut.ids.slack === "U0EXOWNER", "union: the config entry's UNDISPUTED accounts survive — a conflict costs one account, not the person");
  ok(conflict.principals.every((p) => p.ids.linear !== "lin-uuid-1"), "union: the disputed account is dropped from BOTH sides, never awarded to one");

  const nameOnly = unionPrincipals([{ name: "Rowan Hale", ids: { slack: "U_REAL" } }], [{ linkSetId: "ls5", handle: "Rowan Hale", ids: { github: "impostor" } }]);
  ok(nameOnly.principals.length === 2 && nameOnly.warnings.length === 0, "union: two entries sharing a NAME and no account are two people — display names are never a join key");

  const live = await confirmedLinkSetPrincipals(ORG);
  ok(live.every((s) => Object.keys(s.ids).length > 0), "confirmedLinkSetPrincipals: never emits an entry with no accounts");
  ok(live.some((s) => s.ids.github === "example-owner"), "confirmedLinkSetPrincipals: the confirmed link-set is visible to the attribution path");
}

{
  await refuses(() => linkIdentity.execute({}, channelU1), "DM-only", "link_identity refuses in a channel");
  await refuses(() => linkIdentity.execute({}, mpimU1), "DM-only", "link_identity refuses in a group DM (mpim)");
  await refuses(() => confirmLink.execute({ decision: "confirm" }, channelU1), "DM-only", "confirm_link refuses in a channel");
  await refuses(() => unlinkIdentity.execute({}, mpimU1), "DM-only", "unlink_identity refuses in a group DM");

  const out = (await linkIdentity.execute({}, dmU1)) as { challengeId: string; instructions: string; expiresAt: string };
  ok(typeof out.challengeId === "string" && out.instructions.includes("link "), "link_identity: returns a challenge id and postable instructions");
  const code = out.instructions.match(new RegExp(String.raw`link (${"[" + LINK_CODE_ALPHABET + "]"}{${LINK_CODE_LENGTH}})`))![1]!;
  ok(code !== undefined && detectLinkClaim(`link ${code}`) === code, "link_identity: the instructions carry a well-formed code (matches the whole-message claim form)");

  await refuses(() => confirmLink.execute({ decision: "confirm" }, dmU1), "nothing of yours is waiting", "confirm_link refuses before anything has claimed the code");

  await observeLinkClaim({ org: ORG, platform: "github", authorId: "u1-github", text: `link ${code}`, trust: "peer" });
  await refuses(() => confirmLink.execute({ decision: "confirm" }, dmU2), "nothing of yours is waiting", "confirm_link refuses a DIFFERENT person — a claim awaiting U1 is invisible to U2");
  await refuses(() => confirmLink.execute({ decision: "confirm", challengeId: out.challengeId }, dmU2), "nothing of yours is waiting", "confirm_link refuses when a different person names the challenge id explicitly");
  await refuses(() => confirmLink.execute({ decision: "deny", challengeId: out.challengeId }, dmU2), "nothing of yours is waiting", "confirm_link refuses a different person's DENY too — a stranger cannot cancel your link either");
  ok((await pg.getLinkChallenge(ORG, out.challengeId))?.status === "claimed", "confirm_link: the refused attempts changed nothing — the claim still awaits its initiator");

  const confirmed = (await confirmLink.execute({ decision: "confirm" }, dmU1)) as { decided: string; claimant: string; linkSetId: string };
  ok(confirmed.decided === "confirmed" && confirmed.claimant === "github/u1-github", "confirm_link: the initiator commits the link and the claimant is named back");
  ok((await resolveLinkSet(ORG, "github", "u1-github", ""))?.id === confirmed.linkSetId, "confirm_link: the link resolves afterwards");

  await refuses(() => unlinkIdentity.execute({ platform: "github" }, dmU1), "BOTH platform and nativeId", "unlink_identity refuses a half-specified target");
  await refuses(() => unlinkIdentity.execute({ platform: "linear", tenant: "", nativeId: "lin-uuid-1" }, dmU1), "not on your link-set", "unlink_identity refuses an account that is not on the caller's set");
  const unlinked = (await unlinkIdentity.execute({ platform: "github", tenant: "", nativeId: "u1-github" }, dmU1)) as { unlinked: string };
  ok(unlinked.unlinked === "github/u1-github", "unlink_identity: a caller may remove ANOTHER id from their OWN set (they may have lost access to it)");
  ok((await resolveLinkSet(ORG, "github", "u1-github", "")) === null, "unlink_identity: the severed account no longer resolves");
  ok((await pg.getLinkedId(ORG, "github", "", "u1-github")) === null, "unlink_identity: a sever DELETES the row (no tombstone) so the account is joinable again");
  ok((await pg.insertLinkedId(ORG, { org: ORG, linkSetId: "fresh", platform: "github", tenant: "", nativeId: "u1-github", status: "confirmed", establishedBy: "challenge:z", createdAt: "z", updatedAt: "z" })) === true, "unlink_identity: unlink-then-relink works — the asymmetry with admin REVOKE is real");

  const self = (await unlinkIdentity.execute({}, dmU1)) as { unlinked: string };
  ok(self.unlinked === "slack/T1/U1", "unlink_identity: with no target it removes the account the caller is speaking from");
  await refuses(() => unlinkIdentity.execute({}, dmU2), "no linked accounts", "unlink_identity refuses a caller with no link-set at all");
}

{
  const dmGuest = ctxFor({ channelId: "D_GUEST", channelType: "im", principalId: "U_GUEST", dmPartnerTrust: "external" });
  await refuses(() => linkIdentity.execute({}, dmGuest), "can't confirm you're inside this organisation", "OPE-289: link_identity refuses an EXTERNAL-trust Slack DM (the initiator-trust gate)");
  await refuses(() => confirmLink.execute({ decision: "confirm" }, dmGuest), "can't confirm you're inside this organisation", "OPE-289: confirm_link refuses the same DM — the standing is checked at BOTH ends of the flow");
  ok((await getOperationalStore().listLinkChallenges(ORG, { initiatingPlatform: "slack", initiatingTenant: T1, initiatingNativeId: "U_GUEST" })).length === 0, "OPE-289: the refused initiator minted NO challenge at all");
  const dmUnchecked = ctxFor({ channelId: "D_UNCH", channelType: "im", principalId: "U_UNCH" });
  await refuses(() => linkIdentity.execute({}, dmUnchecked), "can't confirm you're inside this organisation", "OPE-289: an UNVERIFIED Slack DM partner is refused too — on an evidence platform, unchecked is external");

  const { registerIdentityMapper } = await import("../agent/identity/binding.js");
  registerIdentityMapper("discord", (c) => {
    const a = (c.session?.auth?.current?.attributes ?? {}) as Record<string, string>;
    return { workspace: a["guild_id"], surface: a["channel_id"], mode: "dm", visibility: "private", principalId: c.session?.auth?.current?.principalId, target: undefined };
  });
  const dmDiscord = {
    channel: { kind: "discord" },
    session: { auth: { current: { attributes: { guild_id: "G1", channel_id: "DC1" }, principalId: "DU1", principalType: "discord-user" } } },
  } as BindableContext;
  const { bindFrom } = await import("../agent/identity/binding.js");
  ok(bindFrom(dmDiscord).trust === "external" && bindFrom(dmDiscord).mode === "dm", "OPE-289 setup: a Discord DM really does bind `external` (no mapper verdict exists) — the assertion below is not vacuous");
  const dcOut = (await linkIdentity.execute({}, dmDiscord)) as { challengeId: string; instructions: string };
  ok(typeof dcOut.challengeId === "string" && dcOut.instructions.includes("link "), "🔴 OPE-289 scoping: an `external` DISCORD DM (platform NOT in BINDING_TRUSTED_PLATFORMS) STILL LINKS — absence of a membership check is not evidence of an outsider");
  const dcCode = dcOut.instructions.match(new RegExp(String.raw`link (${"[" + LINK_CODE_ALPHABET + "]"}{${LINK_CODE_LENGTH}})`))![1]!;
  await observeLinkClaim({ org: ORG, platform: "github", authorId: "dc-gh", text: `link ${dcCode}`, trust: "unauth", trustIsEvidence: false });
  const dcConfirmed = (await confirmLink.execute({ decision: "confirm" }, dmDiscord)) as { decided: string; claimant: string };
  ok(dcConfirmed.decided === "confirmed" && dcConfirmed.claimant === "github/dc-gh", "🔴 OPE-289 scoping: confirm_link admits the same Discord DM — the gate is scoped identically at both ends");

  const fireCtx = {
    channel: { kind: "slack" },
    session: { auth: { current: { attributes: { team_id: "T1", channel_id: "D1", channel_type: "im", trust_checked: "true", dm_partner_trust: "internal", oe_fire_principal: "U1", oe_fire_unattended: "true" }, principalId: "U1", principalType: "slack-user" } } },
  } as BindableContext;
  await refuses(() => linkIdentity.execute({}, fireCtx), "needs a verified person on this turn", "OPE-289: an unattended fire is still refused by the PRINCIPAL gate, which precedes the trust gate");
  await refuses(() => confirmLink.execute({ decision: "confirm" }, fireCtx), "needs a verified person on this turn", "OPE-289: confirm_link refuses the fire the same way");
}

{
  const { registerPostArm } = await import("../agent/channels/post-arms.js");
  type Notice = { platform: string; to: string; text: string };
  const notices: Notice[] = [];
  let slackThrows = false;
  registerPostArm({
    platform: "slack",
    deliverDirectMessage: async (input) => {
      if (slackThrows) throw new Error("slack DM arm is down");
      notices.push({ platform: "slack", to: input.principalId, text: input.text });
      return { surfaceId: `D-${input.principalId}`, messageId: "m1" };
    },
  });
  registerPostArm({
    platform: "discord",
    deliverDirectMessage: async (input) => {
      notices.push({ platform: "discord", to: input.principalId, text: input.text });
      return { surfaceId: `DD-${input.principalId}`, messageId: "m1" };
    },
  });
  ok(canDeliverDirectMessage("slack") && canDeliverDirectMessage("discord") && !canDeliverDirectMessage("github"), "OPE-288 setup: slack + discord can DM, github cannot — the unreachable-account limit is real in this fixture");

  const dmN1 = ctxFor({ channelId: "D_N1", channelType: "im", principalId: "U_N1", dmPartnerTrust: "internal" });
  const dmDc = {
    channel: { kind: "discord" },
    session: { auth: { current: { attributes: { guild_id: "G1", channel_id: "DC_N1" }, principalId: "dc-n1", principalType: "discord-user" } } },
  } as BindableContext;

  async function link(ctx: BindableContext, claimant: { platform: string; tenant: string; nativeId: string }): Promise<string> {
    const out = (await linkIdentity.execute({}, ctx)) as { instructions: string };
    const code = out.instructions.match(new RegExp(String.raw`link (${"[" + LINK_CODE_ALPHABET + "]"}{${LINK_CODE_LENGTH}})`))![1]!;
    await observeLinkClaim({ org: ORG, platform: claimant.platform, tenant: claimant.tenant, authorId: claimant.nativeId, text: `link ${code}`, trust: "peer" });
    notices.length = 0;
    const res = (await confirmLink.execute({ decision: "confirm" }, ctx)) as { linkSetId: string };
    return res.linkSetId;
  }

  const setId = await link(dmN1, { platform: "github", tenant: "", nativeId: "gh-n1" });
  ok(notices.length === 0, "OPE-288: no set notice when the only other member is DM-incapable — and the initiator is never notified about their own act");

  await link(dmN1, { platform: "discord", tenant: "", nativeId: "dc-n1" });
  ok(notices.length === 1 && notices[0]!.platform === "discord" && notices[0]!.to === "dc-n1", "OPE-288: the joining account is a member and hears about the join; github (no DM arm) does not; the initiator is not double-notified");

  const grown = await link(dmDc, { platform: "github", tenant: "", nativeId: "gh-n2" });
  ok(grown === setId, "OPE-288 setup: the discord member grew the SAME set (not a new one)");
  const members = (await expandLinkSet(ORG, setId)).map((a) => (a.tenant ? `${a.platform}/${a.tenant}/${a.nativeId}` : `${a.platform}/${a.nativeId}`)).sort();
  assert.deepEqual(members, ["discord/dc-n1", "github/gh-n1", "github/gh-n2", "slack/T1/U_N1"], "OPE-288 setup: the set now holds four accounts, two of them DM-incapable");
  n++;
  ok(notices.length === 1 && notices[0]!.platform === "slack" && notices[0]!.to === "U_N1", "🔴 OPE-288: EVERY other DM-capable member is told when a member grows the set — the compromised-member case cannot be silent");
  ok(!notices.some((x) => x.platform === "discord"), "OPE-288: the member who DID the growing is excluded — no double-notify (they hold the tool's own answer)");
  ok(/github\/gh-n2/.test(notices[0]!.text) && /unlink/i.test(notices[0]!.text), "OPE-288: the notice NAMES the account that joined and points at the one-call remedy");

  slackThrows = true;
  notices.length = 0;
  const survived = await link(dmDc, { platform: "github", tenant: "", nativeId: "gh-n3" });
  ok(survived === setId, "🔴 OPE-288: a THROWING DM arm does not fail the tool — the link committed and the undeliverable notice was swallowed");
  ok((await resolveLinkSet(ORG, "github", "gh-n3", ""))?.id === setId, "OPE-288: …and the link it wrote is really there");
  ok(notices.length === 0, "OPE-288: the throwing arm delivered nothing (the assertion above is not passing by accident)");
  slackThrows = false;

  notices.length = 0;
  await unlinkIdentity.execute({ platform: "discord", tenant: "", nativeId: "dc-n1" }, dmN1);
  ok(notices.length === 1 && notices[0]!.platform === "discord" && notices[0]!.to === "dc-n1", "🔴 OPE-288: a SEVER reaches the REMOVED account on its other surface — being cut out of your own set is not something you learn by accident");
  ok(/removed from your linked identity/.test(notices[0]!.text), "OPE-288: the sever notice says what happened, in core-owned text");
  ok(!notices.some((x) => x.platform === "slack"), "OPE-288: the caller who did the unlinking is not notified about their own act");

  await link(dmN1, { platform: "discord", tenant: "", nativeId: "dc-n1" });
  notices.length = 0;
  await unlinkIdentity.execute({ platform: "github", tenant: "", nativeId: "gh-n3" }, dmDc);
  ok(notices.length === 1 && notices[0]!.platform === "slack" && notices[0]!.to === "U_N1", "OPE-288: a sever of an unreachable account still tells the REMAINING DM-capable members");
  ok(/github\/gh-n3/.test(notices[0]!.text), "OPE-288: the sever notice names the account that was removed");

  const rows = await pg.readAudit({ org: ORG });
  const conf = rows.filter((r) => r.action === "identity.link.confirmed" && (r.detail as { linkSetId?: string })?.linkSetId === setId);
  const unl = rows.filter((r) => r.action === "identity.link.unlinked" && (r.detail as { linkSetId?: string })?.linkSetId === setId);
  ok(conf.length > 0 && unl.length > 0, "OPE-288 setup: this set produced both confirmed and unlinked audit rows");
  ok(conf.every((r) => typeof (r.detail as { memberCount?: unknown }).memberCount === "number"), "OPE-288: identity.link.confirmed carries memberCount");
  ok(conf.every((r) => typeof (r.detail as { vaultArmed?: unknown }).vaultArmed === "boolean"), "OPE-288: identity.link.confirmed carries vaultArmed — the flag state AT THE TIME, which is not recoverable later");
  ok(unl.every((r) => typeof (r.detail as { memberCount?: unknown }).memberCount === "number" && typeof (r.detail as { vaultArmed?: unknown }).vaultArmed === "boolean"), "OPE-288: identity.link.unlinked carries both too");
  const counts = conf.map((r) => (r.detail as { memberCount: number }).memberCount);
  ok(counts[counts.length - 1] === 2, "OPE-288: the FIRST confirmed row for this set recorded 2 accounts — the size the set actually was then");
  ok(new Set(counts).size > 1, "🔴 OPE-288: memberCount MOVED across the set's rows — it is a live count, not a constant, and a later snapshot could not recover it");
  ok((unl[0]!.detail as { memberCount: number }).memberCount === (await expandLinkSet(ORG, setId)).length, "OPE-288: the newest unlink row recorded the set size AFTER the sever");
  ok(conf.every((r) => (r.detail as { vaultArmed: boolean }).vaultArmed === directoryLinkSetVaultArmed()), "OPE-288: vaultArmed is the flag reader's own answer (fail-closed), not an independent re-derivation");

  registerPostArm({ platform: "slack" });
  registerPostArm({ platform: "discord" });
  ok(!canDeliverDirectMessage("slack") && !canDeliverDirectMessage("discord"), "OPE-288 teardown: the recorder arms are gone");
}

{
  const { registerControlWriteTools } = await import("../agent/control/writes.js");
  type Registered = { name: string; handler: (a: any) => Promise<{ isError?: boolean; content: { text: string }[] }> };
  const mount = (roles: readonly string[]) => {
    const tools: Registered[] = [];
    const server = { registerTool: (name: string, _spec: unknown, handler: Registered["handler"]) => tools.push({ name, handler }) };
    registerControlWriteTools(server as never, "admin@example", roles);
    return tools;
  };
  const IDENTITY_VERBS = ["link_sets_list", "suspend_link_set", "reactivate_link_set", "revoke_link_set"];

  const adminTools = mount(["admin"]);
  ok(IDENTITY_VERBS.every((v) => adminTools.some((t) => t.name === v)), "admin tools: all four identity verbs are registered");

  const domainTools = mount(["domain:eng"]);
  for (const verb of IDENTITY_VERBS) {
    const tool = domainTools.find((t) => t.name === verb)!;
    const res = await tool.handler({ org: ORG, linkSetId: "whatever" });
    ok(res.isError === true && res.content[0]!.text.includes('org-wide "admin"'), `admin tools: ${verb} refuses a domain-role identity (a link-set spans every surface)`);
  }
  const noRole = mount([]).find((t) => t.name === "link_sets_list")!;
  ok((await noRole.handler({ org: ORG })).isError === true, "admin tools: link_sets_list refuses an identity with NO roles — the read is org-admin too");

  const listed = await adminTools.find((t) => t.name === "link_sets_list")!.handler({ org: ORG });
  const payload = JSON.parse(listed.content[0]!.text) as { linkSets: { id: string; status: string; ids: { establishedBy: string }[] }[] };
  ok(payload.linkSets.length > 0, "admin tools: link_sets_list returns the org's sets");
  ok(payload.linkSets.some((s) => s.status === "revoked"), "admin tools: the list shows REVOKED sets too — it is the offboarding worklist, not a live-only view");
  ok(payload.linkSets.flatMap((s) => s.ids).some((i) => i.establishedBy.startsWith("challenge:")), "admin tools: each account names the challenge that established it");

  const target = (await listLinkSetsWithIds(ORG)).find((r) => r.set.status === "active")!;
  const suspend = adminTools.find((t) => t.name === "suspend_link_set")!;
  ok((await suspend.handler({ org: ORG, linkSetId: target.set.id })).isError !== true, "admin tools: suspend_link_set holds an active set");
  ok((await suspend.handler({ org: ORG, linkSetId: target.set.id })).isError === true, "admin tools: suspending an already-suspended set is refused, not a silent no-op");
  ok((await adminTools.find((t) => t.name === "reactivate_link_set")!.handler({ org: ORG, linkSetId: target.set.id })).isError !== true, "admin tools: reactivate_link_set lifts the hold");
  ok((await adminTools.find((t) => t.name === "revoke_link_set")!.handler({ org: ORG, linkSetId: target.set.id })).isError !== true, "admin tools: revoke_link_set closes the set");
  ok((await adminTools.find((t) => t.name === "reactivate_link_set")!.handler({ org: ORG, linkSetId: target.set.id })).isError === true, "admin tools: a REVOKED set can never be reactivated — revocation is terminal on the admin plane too");
}

{
  const rows = await pg.readAudit({ org: ORG });
  const actions = new Set(rows.map((r) => r.action));
  for (const action of ["identity.link.challenge_issued", "identity.link.challenge_claimed", "identity.link.confirmed", "identity.link.denied", "identity.link.unlinked", "identity.link.suspended", "identity.link.reactivated", "identity.link.revoked", "identity.link.suggested"]) {
    ok(actions.has(action), `audit: ${action} was appended`);
  }
  const fresh = await issueLinkChallenge({ org: ORG, platform: "slack", tenant: T1, nativeId: "U_AUDIT", surfaceKey: "slack/T1/D4" });
  const everything = JSON.stringify(await pg.readAudit({ org: ORG }));
  ok(everything.includes(fresh.challenge.id), "audit: the challenge-issued row is there (the negative below is not vacuous)");
  ok(!everything.includes(fresh.code), "audit: the raw code appears NOWHERE in the audit log");
  ok(!JSON.stringify(await pg.getLinkChallenge(ORG, fresh.challenge.id)).includes(fresh.code), "audit: nor anywhere on the challenge row — only its sha-256 is at rest");
}

console.log(`✓ identity-links: ${n} assertions (challenge state machine, store invariants incl. sqlite parity, claim hook, union resolver, tools, admin plane, audit)`);
