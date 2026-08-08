
process.env.OE_SQLITE_PATH = ":memory:";
process.env.OE_OPERATIONAL_PROVIDER = "postgres";

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";

process.env.OE_CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString("base64");

import { initOperationalSchema, makeOperationalPostgresStore, type PgClient } from "../agent/operational/postgres.js";
import { sqliteOperationalStore } from "../agent/operational/sqlite.js";
import { registerOperationalStore, resetOperationalStore, getOperationalStore } from "../agent/operational/provider.js";
import { OPERATIONAL_TABLES, type OperationalStore } from "../agent/operational/store.js";
import { purgeLinkSetCredentials, revokeLinkSet, setLinkSetHold, unlinkOwnId } from "../agent/identity/link-store.js";
import { rawVaultSubject, sharedVaultSubject, RAW_VAULT_SUBJECT_PREFIX, SHARED_VAULT_SUBJECT_PREFIX } from "../agent/identity/oauth-vault-share.js";
import { sharedVaultSubjectFor } from "../agent/access/group-request.js";
import { encryptedKvVault } from "../agent/credentials/kv-vault.js";
import { registerCredentialPurgeHook, resetCredentialPurgeHook } from "../agent/credentials/purge.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

{
  const a = rawVaultSubject("acme", "slack", "T1", "U1");
  ok(a === `${RAW_VAULT_SUBJECT_PREFIX}acme/slack/T1/U1`, "raw subject: composes p:<org>/<principal-key> — the SAME grammar principal-key.ts owns, org-qualified like the shared form, and since OPE-309 carrying Slack's workspace rung");
  ok(a !== "U1", "raw subject: 🔴 NOT the bare native id — that spelling is what OPE-286 deleted");
  ok(rawVaultSubject("acme", "discord", undefined, "U1") === `${RAW_VAULT_SUBJECT_PREFIX}acme/discord/U1`, "raw subject: …and a vendor-global platform's subject is BYTE-IDENTICAL to its pre-OPE-309 form — no gratuitous re-consent");

  ok(rawVaultSubject("acme", "slack", "T1", "U1") !== rawVaultSubject("acme", "slack", "T2", "U1"), "raw subject: 🔴 the SAME Slack member id in two WORKSPACES of one org → two DIFFERENT subjects (OPE-309 — the residual OPE-286 stated and could not close)");
  ok(rawVaultSubject("acme", "slack", "T1", "U1") !== rawVaultSubject("beta", "slack", "T1", "U1"), "raw subject: 🔴 the SAME Slack member id in two orgs → two DIFFERENT subjects (two humans can hold one U-id; they must not hold one credential row)");
  ok(rawVaultSubject("acme", "slack", "T1", "U1") !== rawVaultSubject("acme", "discord", "T1", "U1"), "raw subject: 🔴 the same native id on two platforms → two DIFFERENT subjects (six id namespaces that never agreed to share one)");

  let subjectThrew = false;
  try { rawVaultSubject("acme", "slack", undefined, "U1"); } catch { subjectThrew = true; }
  ok(subjectThrew, "raw subject: 🔴 THROWS when a tenant-scoped platform names no workspace — never a subject that quietly aliases two people");

  ok(rawVaultSubject("acme-x", "slack", "T1", "U1") !== rawVaultSubject("acme", "x-slack", "T1", "U1"), "raw subject: distinct (org, platform) pairs compose distinct subjects — the segments cannot be re-split into a collision");

  ok(!rawVaultSubject("acme", "slack", "T1", "ls:evil/x").startsWith(SHARED_VAULT_SUBJECT_PREFIX), "disjoint: a native id crafted as 'ls:evil/x' still composes a RAW subject — it can never be mistaken for a link-set's shared row");
  ok(rawVaultSubject("acme", "slack", "T1", "ls:evil/x") === `${RAW_VAULT_SUBJECT_PREFIX}acme/slack/T1/ls:evil/x`, "disjoint: …the crafted id rides VERBATIM in the tail (never interpreted, never stripped) — the qualifier is what makes it inert");
  ok(!sharedVaultSubject("acme", "S1").startsWith(RAW_VAULT_SUBJECT_PREFIX), "disjoint: a shared subject can never take the raw shape either");
  ok(!sharedVaultSubject("ls:evil", "S1").startsWith(RAW_VAULT_SUBJECT_PREFIX), "disjoint: …including when the org itself is crafted");
  const rawPrefix: string = RAW_VAULT_SUBJECT_PREFIX;
  const sharedPrefix: string = SHARED_VAULT_SUBJECT_PREFIX;
  ok(rawPrefix !== sharedPrefix && !rawPrefix.startsWith(sharedPrefix) && !sharedPrefix.startsWith(rawPrefix), "disjoint: the two prefixes are distinct literals, NEITHER of which prefixes the other — the property every assertion above is anchored on");
}

ok(!(OPERATIONAL_TABLES as readonly string[]).includes("identity_oauth_vault_grants"), "registry: the per-connector grant table is GONE — consent collapsed to link-level, no ratification machinery");

const WS = "T_C3";
const tenantOf = (platform: string): string => (platform === "slack" ? WS : "");

async function mkSet(
  store: OperationalStore,
  org: string,
  id: string,
  accounts: readonly { platform: string; tenant?: string; nativeId: string; status?: "confirmed" | "suggested" }[],
): Promise<void> {
  const at = new Date().toISOString();
  await store.putLinkSet(org, { org, id, handle: id, status: "active", createdAt: at, updatedAt: at });
  for (const a of accounts) {
    await store.insertLinkedId(org, {
      org,
      platform: a.platform,
      tenant: a.tenant ?? tenantOf(a.platform),
      nativeId: a.nativeId,
      linkSetId: id,
      status: a.status ?? "confirmed",
      establishedBy: "test",
      evidenceJson: undefined,
      createdAt: at,
      updatedAt: at,
    });
  }
}

async function runInvariants(store: OperationalStore, engine: string): Promise<void> {
  const ORG = "default";
  const C = "notion";
  const label = (s: string) => `[${engine}] ${s}`;

  await mkSet(store, ORG, "S1", [
    { platform: "slack", tenant: tenantOf("slack"), nativeId: "U1" },
    { platform: "discord", tenant: tenantOf("discord"), nativeId: "D1" },
    { platform: "slack", tenant: tenantOf("slack"), nativeId: "U_SUG", status: "suggested" },
  ]);

  ok((await sharedVaultSubjectFor(ORG, C, "slack", "U1", WS)) === sharedVaultSubject(ORG, "S1"), label("confirmed member → the org-scoped SHARED subject ls:<org>/<set>, no ratify step"));
  ok((await sharedVaultSubjectFor(ORG, C, "slack", "U1", WS))!.startsWith("ls:"), label("the shared subject is namespaced apart from a raw principal id"));

  ok((await sharedVaultSubjectFor(ORG, "other", "slack", "U1", WS)) === sharedVaultSubject(ORG, "S1"), label("a SECOND connector resolves shared immediately — adding an MCP does not prompt (per-connector re-ratification removed)"));

  const sub1 = await sharedVaultSubjectFor(ORG, C, "slack", "U1", WS);
  const sub2 = await sharedVaultSubjectFor(ORG, C, "discord", "D1");
  ok(sub1 !== undefined && sub1 === sub2, label("CONSENT-ONCE WIN: both confirmed accounts of one set resolve the SAME subject across platforms"));

  ok((await sharedVaultSubjectFor(ORG, C, "slack", "U_SUG", WS)) === undefined, label("suggested member → RAW subject (a proposal is not a proven link)"));
  ok((await sharedVaultSubjectFor(ORG, C, "slack", "NOBODY", WS)) === undefined, label("an account in no set → RAW subject (unlinked, byte-identical to today)"));

  await setLinkSetHold({ org: ORG, linkSetId: "S1", hold: "suspended", actor: "admin" });
  ok((await sharedVaultSubjectFor(ORG, C, "slack", "U1", WS)) === undefined, label("suspended set → RAW subject (membership resolves to nothing — the SOLE REACHABILITY-severance mechanism; credential DEATH is §PURGE)"));
  await setLinkSetHold({ org: ORG, linkSetId: "S1", hold: "active", actor: "admin" });
  ok((await sharedVaultSubjectFor(ORG, C, "slack", "U1", WS)) === sharedVaultSubject(ORG, "S1"), label("reactivate → sharing restored from the surviving membership"));

  const un = await unlinkOwnId({ org: ORG, actor: { platform: "slack", tenant: tenantOf("slack"), nativeId: "U1" }, target: { platform: "discord", tenant: tenantOf("discord"), nativeId: "D1" } });
  ok(un.ok, label("unlink: U1 severs discord/D1 from their own set"));
  ok((await sharedVaultSubjectFor(ORG, C, "discord", "D1")) === undefined, label("unlink SEVERS reach → the unlinked account re-derives its RAW subject (no grant survives to re-inherit — threat h N/A by design)"));
  ok((await sharedVaultSubjectFor(ORG, C, "slack", "U1", WS)) === sharedVaultSubject(ORG, "S1"), label("unlink of one account leaves the OTHER account's reach intact"));

  await revokeLinkSet({ org: ORG, linkSetId: "S1", actor: "admin" });
  ok((await sharedVaultSubjectFor(ORG, C, "slack", "U1", WS)) === undefined, label("revoke → RAW subject (offboarded account loses shared-token reach, terminally)"));

  await mkSet(store, "orgA", "SHARED_ID", [{ platform: "slack", tenant: tenantOf("slack"), nativeId: "P" }]);
  ok((await sharedVaultSubjectFor("orgA", C, "slack", "P", WS)) === "ls:orgA/SHARED_ID", label("org isolation: orgA resolves ls:orgA/SHARED_ID"));
  ok((await sharedVaultSubjectFor("orgB", C, "slack", "P", WS)) === undefined, label("org isolation: orgB (same id string, no membership of its own) → RAW — never sees orgA's set"));
  ok(sharedVaultSubject("orgA", "SHARED_ID") !== sharedVaultSubject("orgB", "SHARED_ID"), label("org isolation: the subject shape itself org-qualifies (no cross-org vault-key alias)"));
}

{
  const db = new PGlite();
  const client: PgClient = { query: (text, params) => db.query(text, params ? [...params] : undefined) };
  await initOperationalSchema(client);
  const pg = makeOperationalPostgresStore(client);
  registerOperationalStore(pg);
  resetOperationalStore();
  ok(getOperationalStore() === pg, "provider: the PGlite-backed postgres store is what the C.3 API will reach");
  await runInvariants(pg, "postgres");
}

{
  process.env.OE_OPERATIONAL_PROVIDER = "sqlite";
  registerOperationalStore(sqliteOperationalStore);
  resetOperationalStore();
  await runInvariants(sqliteOperationalStore, "sqlite");
}

{
  process.env.OE_OPERATIONAL_PROVIDER = "postgres";
  const db = new PGlite();
  const client: PgClient = { query: (text, params) => db.query(text, params ? [...params] : undefined) };
  await initOperationalSchema(client);
  const store = makeOperationalPostgresStore(client);
  registerOperationalStore(store);
  resetOperationalStore();

  const ORG = "default";
  const vault = encryptedKvVault();
  const tokRef = (subject: string) => `oe-oauth:tok:notion:user:${subject}`;
  const seed = (subject: string) => vault.write(tokRef(subject), JSON.stringify({ accessToken: "AT", refreshToken: "RT", obtainedAt: 0 }), { provider: "notion" });
  const rowOf = (subject: string) => store.getStoredCredential(ORG, tokRef(subject));
  const lastRevokeDetail = async (setId: string): Promise<Record<string, unknown>> => {
    const rows = await store.readAudit({ org: ORG });
    const row = rows.filter((r) => r.action === "identity.link.revoked" && (r.detail as { linkSetId?: string } | undefined)?.linkSetId === setId).at(-1);
    return (row?.detail ?? {}) as Record<string, unknown>;
  };

  {
    registerCredentialPurgeHook("oe-oauth", {
      purgeSubject: async (subjectId: string) => ((await vault.delete(tokRef(subjectId))) ? 1 : 0),
    });
    await mkSet(store, ORG, "P1", [{ platform: "slack", tenant: tenantOf("slack"), nativeId: "PU1" }]);
    const subject = sharedVaultSubject(ORG, "P1");
    await seed(subject);
    ok((await rowOf(subject)) !== null, "purge setup: the shared subject's credential row exists before the revoke");

    const res = await revokeLinkSet({ org: ORG, linkSetId: "P1", actor: "admin" });
    ok(res.ok, "purge: revoke succeeded");
    ok((await sharedVaultSubjectFor(ORG, "notion", "slack", "PU1", WS)) === undefined, "purge: reachability is still severed (the pre-existing property is intact)");
    ok((await rowOf(subject)) === null, "🔴 purge: the stored_credential ROW IS GONE — revoke is credential DEATH, not merely unreachability");
    const detail = await lastRevokeDetail("P1");
    ok(detail.credentialsPurged === 1, "purge: the identity.link.revoked audit row states how many credentials were purged");
    ok(detail.purgeFailed === undefined, "purge: a clean purge stamps no failure flag");
  }

  {
    registerCredentialPurgeHook("oe-oauth", {
      purgeSubject: async () => {
        throw new Error("vault backing unavailable");
      },
    });
    await mkSet(store, ORG, "P2", [{ platform: "slack", tenant: tenantOf("slack"), nativeId: "PU2" }]);
    const subject = sharedVaultSubject(ORG, "P2");
    await seed(subject);

    const res = await revokeLinkSet({ org: ORG, linkSetId: "P2", actor: "admin" });
    ok(res.ok, "🔴 purge failure: the REVOKE still succeeds — a vault outage never blocks an offboarding");
    ok((await sharedVaultSubjectFor(ORG, "notion", "slack", "PU2", WS)) === undefined, "purge failure: the tombstone landed regardless (reachability severed)");
    const detail = await lastRevokeDetail("P2");
    ok(detail.purgeFailed === true && detail.credentialsPurged === 0, "🔴 purge failure: the audit row records purgeFailed — the residue is VISIBLE, never silent");
    ok(res.ok && res.note.includes("purge_link_set_credentials"), "purge failure: the operator is told the exact repair verb to re-run");
    ok((await rowOf(subject)) !== null, "purge failure: nothing was destroyed (the assertion above is not vacuous)");

    registerCredentialPurgeHook("oe-oauth", { purgeSubject: async (subjectId: string) => ((await vault.delete(tokRef(subjectId))) ? 1 : 0) });
    const repair = await purgeLinkSetCredentials({ org: ORG, linkSetId: "P2", actor: "admin" });
    ok(repair.ok && repair.purged === 1, "purge repair: purge_link_set_credentials finishes a purge that failed at revoke time");
    ok((await rowOf(subject)) === null, "purge repair: the row is gone");
    ok((await purgeLinkSetCredentials({ org: ORG, linkSetId: "P2", actor: "admin" })).ok, "purge repair: re-running on an already-purged set is a clean no-op (idempotent)");
    ok(!(await purgeLinkSetCredentials({ org: ORG, linkSetId: "NO_SUCH_SET", actor: "admin" })).ok, "purge repair: an unknown link-set is a REFUSAL, never a cheerful 0-purged");
  }

  {
    registerCredentialPurgeHook("oe-oauth", { purgeSubject: async (subjectId: string) => ((await vault.delete(tokRef(subjectId))) ? 1 : 0) });
    await mkSet(store, ORG, "P3", [{ platform: "slack", tenant: tenantOf("slack"), nativeId: "PU3" }]);
    const subject = sharedVaultSubject(ORG, "P3");
    await seed(subject);

    let revoked!: Promise<unknown>;
    await vault.withLock(tokRef(subject), async () => {
      revoked = revokeLinkSet({ org: ORG, linkSetId: "P3", actor: "admin" });
      for (let i = 0; i < 20; i++) await Promise.resolve();
      await vault.write(tokRef(subject), JSON.stringify({ accessToken: "AT-rotated", refreshToken: "RT-rotated", obtainedAt: 1 }), { provider: "notion" });
      ok((await rowOf(subject)) !== null, "purge race: the holder's rotated row is really there mid-critical-section");
    });
    await revoked;
    ok((await rowOf(subject)) === null, "🔴 purge race: the ROTATED row is destroyed too — a refresh racing a purge cannot resurrect the credential");

    await seed(subject);
    ok((await store.claimStoredCredential(ORG, tokRef(subject), "claim-1", "2026-08-07T00:00:10Z", "2026-08-07T00:00:00Z")) === true, "purge race: a claim is held on the row");
    ok((await store.deleteStoredCredential(ORG, tokRef(subject))) === true, "purge race: a CLAIMED row still deletes (a held lease never wedges a purge)");
    ok((await store.claimStoredCredential(ORG, tokRef(subject), "claim-2", "2026-08-07T00:00:20Z", "2026-08-07T00:00:00Z")) === false, "purge race: claiming the destroyed row LOSES — no orphan claim state survives the delete");
    ok((await store.deleteStoredCredential(ORG, tokRef(subject))) === false, "purge: deleting an absent row reports false, never throws (idempotent)");

    await store.putStoredCredential("orgZ", { ref: tokRef(subject), ciphertext: "opaque", createdBy: "test", createdAt: new Date().toISOString() });
    await seed(subject);
    ok((await store.deleteStoredCredential(ORG, tokRef(subject))) === true, "purge: the deployment org's row goes");
    ok((await store.getStoredCredential("orgZ", tokRef(subject))) !== null, "🔴 purge: ANOTHER org's row under the same ref is untouched (the delete is org-scoped)");
  }

  {
    resetCredentialPurgeHook();
    await mkSet(store, ORG, "P4", [{ platform: "slack", tenant: tenantOf("slack"), nativeId: "PU4" }]);
    const res = await revokeLinkSet({ org: ORG, linkSetId: "P4", actor: "admin" });
    const detail = await lastRevokeDetail("P4");
    ok(res.ok && detail.credentialsPurged === 0 && detail.purgeFailed === undefined, "no purge hook registered: revoke reports 0 purged and NO failure (nothing to destroy is not an outage)");
  }

  {
    resetCredentialPurgeHook();
    const ssoRef = (subject: string) => `aws-sso:tok:${subject}`;
    registerCredentialPurgeHook("oe-oauth", { purgeSubject: async (subjectId: string) => ((await vault.delete(tokRef(subjectId))) ? 1 : 0) });
    registerCredentialPurgeHook("aws-sso", { purgeSubject: async (subjectId: string) => ((await vault.delete(ssoRef(subjectId))) ? 1 : 0) });

    await mkSet(store, ORG, "P5", [
      { platform: "slack", tenant: tenantOf("slack"), nativeId: "PU5" },
      { platform: "github", tenant: tenantOf("github"), nativeId: "gh-PU5" },
    ]);
    const shared = sharedVaultSubject(ORG, "P5");
    const rawSlack = rawVaultSubject(ORG, "slack", tenantOf("slack"), "PU5");
    const rawGithub = rawVaultSubject(ORG, "github", tenantOf("github"), "gh-PU5");
    await mkSet(store, ORG, "P6", [{ platform: "slack", tenant: tenantOf("slack"), nativeId: "PU6" }]);
    const strangerRaw = rawVaultSubject(ORG, "slack", tenantOf("slack"), "PU6");

    await seed(shared);
    await vault.write(ssoRef(rawSlack), "sso-token-blob", { provider: "aws-sso" });
    await seed(rawGithub);
    await vault.write(ssoRef(strangerRaw), "someone-elses-sso", { provider: "aws-sso" });

    const res = await revokeLinkSet({ org: ORG, linkSetId: "P5", actor: "admin" });
    ok(res.ok, "G3: the revoke succeeded");
    ok((await store.getStoredCredential(ORG, ssoRef(rawSlack))) === null, "🔴 G3: the offboarded person's AWS Identity Center SSO TOKEN is gone — it is keyed per-person and was untouchable through the shared subject alone");
    ok((await rowOf(shared)) === null, "G3: the shared subject's OAuth row still goes (the OPE-287 property is intact)");
    ok((await rowOf(rawGithub)) === null, "G3: a SECOND tombstoned account's raw row goes too — the sweep is per-account, not per-set-plus-one");
    ok((await store.getStoredCredential(ORG, ssoRef(strangerRaw))) !== null, "🔴 G3: ANOTHER person's raw row is untouched — the sweep is scoped to the accounts ON THE SET, never every raw row in the org");
    ok((await lastRevokeDetail("P5")).credentialsPurged === 3, "G3: the audit row counts every credential destroyed across BOTH holders (shared OAuth + SSO + the second account's OAuth)");

    registerCredentialPurgeHook("broken", {
      purgeSubject: async () => {
        throw new Error("holder down");
      },
    });
    await mkSet(store, ORG, "P7", [{ platform: "slack", tenant: tenantOf("slack"), nativeId: "PU7" }]);
    await vault.write(ssoRef(rawVaultSubject(ORG, "slack", tenantOf("slack"), "PU7")), "sso-token-blob", { provider: "aws-sso" });
    const res7 = await revokeLinkSet({ org: ORG, linkSetId: "P7", actor: "admin" });
    ok(res7.ok, "G3: a failing holder still never blocks the offboarding (the one deliberate fail-open, unchanged)");
    ok((await store.getStoredCredential(ORG, ssoRef(rawVaultSubject(ORG, "slack", tenantOf("slack"), "PU7")))) === null, "G3: …and the WORKING holder still destroyed its row (per-holder isolation)");
    const d7 = await lastRevokeDetail("P7");
    ok(d7.purgeFailed === true && d7.credentialsPurged === 1, "G3: the audit reports BOTH what went and that something did not — never 'everything went' while a row survives");
    registerCredentialPurgeHook("broken", { purgeSubject: async () => 0 });

    await mkSet(store, ORG, "P8", [
      { platform: "slack", tenant: tenantOf("slack"), nativeId: "PU8" },
      { platform: "github", tenant: tenantOf("github"), nativeId: "gh-PU8" },
    ]);
    const keptRaw = rawVaultSubject(ORG, "slack", tenantOf("slack"), "PU8");
    const goneRaw = rawVaultSubject(ORG, "github", tenantOf("github"), "gh-PU8");
    await vault.write(ssoRef(keptRaw), "kept-sso", { provider: "aws-sso" });
    await vault.write(ssoRef(goneRaw), "severed-sso", { provider: "aws-sso" });
    const unlinked = await unlinkOwnId({ org: ORG, actor: { platform: "slack", tenant: tenantOf("slack"), nativeId: "PU8" }, target: { platform: "github", tenant: tenantOf("github"), nativeId: "gh-PU8" } });
    ok(unlinked.ok, "G3: the unlink succeeded");
    ok((await store.getStoredCredential(ORG, ssoRef(goneRaw))) === null, "🔴 G3: unlinking an account DESTROYS its own stored credentials — a severed account must not keep minting on a token it earned while it had standing");
    ok((await store.getStoredCredential(ORG, ssoRef(keptRaw))) !== null, "G3: the accounts still on the set are untouched by an unlink");
    const unlinkRow = (await store.readAudit({ org: ORG })).filter((r) => r.action === "identity.link.unlinked").at(-1);
    ok((unlinkRow?.detail as { credentialsPurged?: number } | undefined)?.credentialsPurged === 1, "G3: the unlink audit row states how many credentials were destroyed");
  }
}

{
  const throwing = {
    id: "throwing",
    getLinkedId: async () => { throw new Error("store outage"); },
    getLinkSet: async () => { throw new Error("store outage"); },
  } as unknown as OperationalStore;
  process.env.OE_OPERATIONAL_PROVIDER = "throwing";
  registerOperationalStore(throwing);
  resetOperationalStore();
  ok((await sharedVaultSubjectFor("default", "notion", "slack", "U1", WS)) === undefined, "fail-closed: a throwing store → RAW subject (never a stranger's shared token — threat c)");
}

console.log(`✓ c3-oauth-vault-share: ${n} assertions passed`);
