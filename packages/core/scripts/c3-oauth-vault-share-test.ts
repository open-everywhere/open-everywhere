process.env.OE_SQLITE_PATH = ":memory:";
process.env.OE_OPERATIONAL_PROVIDER = "postgres";

import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { initOperationalSchema, makeOperationalPostgresStore, type PgClient } from "../agent/operational/postgres.js";
import { sqliteOperationalStore } from "../agent/operational/sqlite.js";
import { registerOperationalStore, resetOperationalStore, getOperationalStore } from "../agent/operational/provider.js";
import { OPERATIONAL_TABLES, type OperationalStore } from "../agent/operational/store.js";
import { revokeLinkSet, setLinkSetHold, unlinkOwnId } from "../agent/identity/link-store.js";
import { sharedVaultSubject } from "../agent/identity/oauth-vault-share.js";
import { sharedVaultSubjectFor } from "../agent/access/group-request.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

ok(!(OPERATIONAL_TABLES as readonly string[]).includes("identity_oauth_vault_grants"), "registry: the per-connector grant table is GONE — consent collapsed to link-level, no ratification machinery");

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

  ok((await sharedVaultSubjectFor(ORG, C, "slack", "U1")) === sharedVaultSubject(ORG, "S1"), label("confirmed member → the org-scoped SHARED subject ls:<org>/<set>, no ratify step"));
  ok((await sharedVaultSubjectFor(ORG, C, "slack", "U1"))!.startsWith("ls:"), label("the shared subject is namespaced apart from a raw principal id"));

  ok((await sharedVaultSubjectFor(ORG, "other", "slack", "U1")) === sharedVaultSubject(ORG, "S1"), label("a SECOND connector resolves shared immediately — adding an MCP does not prompt (per-connector re-ratification removed)"));

  const sub1 = await sharedVaultSubjectFor(ORG, C, "slack", "U1");
  const sub2 = await sharedVaultSubjectFor(ORG, C, "discord", "D1");
  ok(sub1 !== undefined && sub1 === sub2, label("CONSENT-ONCE WIN: both confirmed accounts of one set resolve the SAME subject across platforms"));

  ok((await sharedVaultSubjectFor(ORG, C, "slack", "U_SUG")) === undefined, label("suggested member → RAW subject (a proposal is not a proven link)"));
  ok((await sharedVaultSubjectFor(ORG, C, "slack", "NOBODY")) === undefined, label("an account in no set → RAW subject (unlinked, byte-identical to today)"));

  await setLinkSetHold({ org: ORG, linkSetId: "S1", hold: "suspended", actor: "admin" });
  ok((await sharedVaultSubjectFor(ORG, C, "slack", "U1")) === undefined, label("suspended set → RAW subject (membership resolves to nothing — the SOLE severance mechanism)"));
  await setLinkSetHold({ org: ORG, linkSetId: "S1", hold: "active", actor: "admin" });
  ok((await sharedVaultSubjectFor(ORG, C, "slack", "U1")) === sharedVaultSubject(ORG, "S1"), label("reactivate → sharing restored from the surviving membership"));

  const un = await unlinkOwnId({ org: ORG, actor: { platform: "slack", nativeId: "U1" }, target: { platform: "discord", nativeId: "D1" } });
  ok(un.ok, label("unlink: U1 severs discord/D1 from their own set"));
  ok((await sharedVaultSubjectFor(ORG, C, "discord", "D1")) === undefined, label("unlink SEVERS reach → the unlinked account re-derives its RAW subject (no grant survives to re-inherit — threat h N/A by design)"));
  ok((await sharedVaultSubjectFor(ORG, C, "slack", "U1")) === sharedVaultSubject(ORG, "S1"), label("unlink of one account leaves the OTHER account's reach intact"));

  await revokeLinkSet({ org: ORG, linkSetId: "S1", actor: "admin" });
  ok((await sharedVaultSubjectFor(ORG, C, "slack", "U1")) === undefined, label("revoke → RAW subject (offboarded account loses shared-token reach, terminally)"));

  await mkSet(store, "orgA", "SHARED_ID", [{ platform: "slack", nativeId: "P" }]);
  ok((await sharedVaultSubjectFor("orgA", C, "slack", "P")) === "ls:orgA/SHARED_ID", label("org isolation: orgA resolves ls:orgA/SHARED_ID"));
  ok((await sharedVaultSubjectFor("orgB", C, "slack", "P")) === undefined, label("org isolation: orgB (same id string, no membership of its own) → RAW — never sees orgA's set"));
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
  } as unknown as OperationalStore;
  process.env.OE_OPERATIONAL_PROVIDER = "throwing";
  registerOperationalStore(throwing);
  resetOperationalStore();
  ok((await sharedVaultSubjectFor("default", "notion", "slack", "U1")) === undefined, "fail-closed: a throwing store → RAW subject (never a stranger's shared token — threat c)");
}

console.log(`✓ c3-oauth-vault-share: ${n} assertions passed`);
