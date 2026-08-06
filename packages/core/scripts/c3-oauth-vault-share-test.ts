process.env.OE_SQLITE_PATH = ":memory:";
process.env.OE_OPERATIONAL_PROVIDER = "postgres";

import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { initOperationalSchema, makeOperationalPostgresStore, type PgClient } from "../agent/operational/postgres.js";
import { sqliteOperationalStore } from "../agent/operational/sqlite.js";
import { registerOperationalStore, resetOperationalStore, getOperationalStore } from "../agent/operational/provider.js";
import { OPERATIONAL_TABLES, type OperationalStore } from "../agent/operational/store.js";
import { revokeLinkSet, setLinkSetHold, unlinkOwnId } from "../agent/identity/link-store.js";
import {
  hasRatifiedShare,
  ratifyOauthVaultShare,
  sharedVaultSubject,
  unshareOauthVault,
} from "../agent/identity/oauth-vault-share.js";
import { sharedVaultSubjectFor } from "../agent/access/group-request.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

ok(OPERATIONAL_TABLES.includes("identity_oauth_vault_grants"), "registry: identity_oauth_vault_grants is in OPERATIONAL_TABLES (the migrator's canonical list)");

async function mkSet(store: OperationalStore, org: string, id: string, accounts: readonly { platform: string; nativeId: string; status?: "confirmed" | "suggested" }[]): Promise<void> {
  const at = new Date().toISOString();
  await store.putLinkSet(org, { org, id, handle: id, status: "active", createdAt: at, updatedAt: at });
  for (const a of accounts) {
    await store.insertLinkedId(org, {
      org,
      platform: a.platform,
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
    { platform: "slack", nativeId: "U1" },
    { platform: "discord", nativeId: "D1" },
    { platform: "slack", nativeId: "U_SUG", status: "suggested" },
  ]);

  ok((await sharedVaultSubjectFor(ORG, C, "slack", "U1")) === undefined, label("confirmed member, no grant → RAW subject (no silent inheritance)"));

  const r1 = await ratifyOauthVaultShare({ org: ORG, connector: C, actor: { platform: "slack", nativeId: "U1" } });
  ok(r1.ok && r1.linkSetId === "S1", label("ratify: a confirmed member of an active set records the grant"));
  ok((await hasRatifiedShare(ORG, "S1", C, "slack", "U1")) === true, label("ratify: the grant row now exists"));
  ok((await sharedVaultSubjectFor(ORG, C, "slack", "U1")) === sharedVaultSubject(ORG, "S1"), label("ratified → the org-scoped SHARED subject ls:<org>/<set>"));
  ok((await sharedVaultSubjectFor(ORG, C, "slack", "U1"))!.startsWith("ls:"), label("the shared subject is namespaced apart from a raw principal id"));

  ok((await sharedVaultSubjectFor(ORG, C, "discord", "D1")) === undefined, label("a second linked account not yet ratified → RAW (must re-ratify from its own DM)"));
  await ratifyOauthVaultShare({ org: ORG, connector: C, actor: { platform: "discord", nativeId: "D1" } });
  const sub1 = await sharedVaultSubjectFor(ORG, C, "slack", "U1");
  const sub2 = await sharedVaultSubjectFor(ORG, C, "discord", "D1");
  ok(sub1 !== undefined && sub1 === sub2, label("CONSENT-ONCE WIN: both ratified accounts of one set resolve the SAME subject across platforms"));

  ok((await sharedVaultSubjectFor(ORG, "other", "slack", "U1")) === undefined, label("per-connector: a grant for 'notion' does not share 'other'"));

  ok((await sharedVaultSubjectFor(ORG, C, "slack", "U_SUG")) === undefined, label("suggested member → RAW subject"));
  ok((await ratifyOauthVaultShare({ org: ORG, connector: C, actor: { platform: "slack", nativeId: "U_SUG" } })).ok === false, label("ratify REFUSES a suggested (non-confirmed) member"));
  ok((await ratifyOauthVaultShare({ org: ORG, connector: C, actor: { platform: "slack", nativeId: "NOBODY" } })).ok === false, label("ratify REFUSES an account in no set"));

  await setLinkSetHold({ org: ORG, linkSetId: "S1", hold: "suspended", actor: "admin" });
  ok((await sharedVaultSubjectFor(ORG, C, "slack", "U1")) === undefined, label("suspended set → RAW subject (membership resolves to nothing)"));
  ok((await hasRatifiedShare(ORG, "S1", C, "slack", "U1")) === true, label("suspend KEEPS the grant (reversible hold, not a trust-severing event)"));
  await setLinkSetHold({ org: ORG, linkSetId: "S1", hold: "active", actor: "admin" });
  ok((await sharedVaultSubjectFor(ORG, C, "slack", "U1")) === sharedVaultSubject(ORG, "S1"), label("reactivate → sharing restored from the surviving grant"));

  const un = await unlinkOwnId({ org: ORG, actor: { platform: "slack", nativeId: "U1" }, target: { platform: "discord", nativeId: "D1" } });
  ok(un.ok, label("unlink: U1 severs discord/D1 from their own set"));
  ok((await hasRatifiedShare(ORG, "S1", C, "discord", "D1")) === false, label("unlink SEVERED discord/D1's grant (a re-join starts unratified — threat h)"));
  ok((await sharedVaultSubjectFor(ORG, C, "slack", "U1")) === sharedVaultSubject(ORG, "S1"), label("unlink of one account leaves the OTHER account's grant intact"));

  ok((await unshareOauthVault({ org: ORG, connector: C, linkSetId: "S1", actor: { platform: "slack", nativeId: "U1" } })).ok, label("unshare: an account can withdraw its own grant"));
  ok((await sharedVaultSubjectFor(ORG, C, "slack", "U1")) === undefined, label("after unshare → RAW subject"));

  await ratifyOauthVaultShare({ org: ORG, connector: C, actor: { platform: "slack", nativeId: "U1" } });
  ok((await sharedVaultSubjectFor(ORG, C, "slack", "U1")) === sharedVaultSubject(ORG, "S1"), label("re-ratify before revoke → shared again"));
  await revokeLinkSet({ org: ORG, linkSetId: "S1", actor: "admin" });
  ok((await hasRatifiedShare(ORG, "S1", C, "slack", "U1")) === false, label("revoke SEVERED the whole set's grants"));
  ok((await sharedVaultSubjectFor(ORG, C, "slack", "U1")) === undefined, label("revoke → RAW subject (offboarded account loses shared-token reach)"));

  await mkSet(store, "orgA", "SHARED_ID", [{ platform: "slack", nativeId: "P" }]);
  await mkSet(store, "orgB", "SHARED_ID", [{ platform: "slack", nativeId: "P" }]);
  await ratifyOauthVaultShare({ org: "orgA", connector: C, actor: { platform: "slack", nativeId: "P" } });
  ok((await sharedVaultSubjectFor("orgA", C, "slack", "P")) === "ls:orgA/SHARED_ID", label("org isolation: orgA resolves ls:orgA/SHARED_ID"));
  ok((await sharedVaultSubjectFor("orgB", C, "slack", "P")) === undefined, label("org isolation: orgB (same id string, no grant of its own) → RAW — never sees orgA's grant"));
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
  const throwing = {
    id: "throwing",
    getLinkedId: async () => { throw new Error("store outage"); },
    getLinkSet: async () => { throw new Error("store outage"); },
    getOauthVaultGrant: async () => { throw new Error("store outage"); },
  } as unknown as OperationalStore;
  process.env.OE_OPERATIONAL_PROVIDER = "throwing";
  registerOperationalStore(throwing);
  resetOperationalStore();
  ok((await sharedVaultSubjectFor("default", "notion", "slack", "U1")) === undefined, "fail-closed: a throwing store → RAW subject (never a stranger's shared token — threat c)");
  ok((await hasRatifiedShare("default", "S1", "notion", "slack", "U1")) === false, "fail-closed: hasRatifiedShare swallows a store outage as 'not ratified'");
}

{
  const db2 = new PGlite();
  const client2: PgClient = { query: (text, params) => db2.query(text, params ? [...params] : undefined) };
  await initOperationalSchema(client2);
  const pg2 = makeOperationalPostgresStore(client2);
  process.env.OE_OPERATIONAL_PROVIDER = "postgres";
  registerOperationalStore(pg2);
  resetOperationalStore();

  await mkSet(pg2, "default", "SP31", [
    { platform: "slack", nativeId: "U1" },
    { platform: "discord", nativeId: "D1" },
  ]);
  await ratifyOauthVaultShare({ org: "default", connector: "notion", actor: { platform: "discord", nativeId: "D1" } });
  ok((await hasRatifiedShare("default", "SP31", "notion", "discord", "D1")) === true, "P3-1 setup: discord/D1 holds a ratified grant");

  const faulting = { ...pg2, id: "faulting", deleteOauthVaultGrantsForAccount: async () => { throw new Error("grant-delete outage"); } } as unknown as OperationalStore;
  process.env.OE_OPERATIONAL_PROVIDER = "faulting";
  registerOperationalStore(faulting);
  resetOperationalStore();

  const un = await unlinkOwnId({ org: "default", actor: { platform: "discord", nativeId: "D1" }, target: { platform: "discord", nativeId: "D1" } });
  ok(un.ok === false, "P3-1: unlink ABORTS when the shared-vault sever faults (does not report success)");

  process.env.OE_OPERATIONAL_PROVIDER = "postgres";
  registerOperationalStore(pg2);
  resetOperationalStore();
  ok((await pg2.getLinkedId("default", "discord", "D1"))?.linkSetId === "SP31", "P3-1: a faulted unlink left the membership row intact (linked, not orphaned)");
  ok((await hasRatifiedShare("default", "SP31", "notion", "discord", "D1")) === true, "P3-1: a faulted unlink left the grant intact — the safe linked+ratified state, never unlinked+ratified");
}

console.log(`✓ c3-oauth-vault-share: ${n} assertions passed`);
