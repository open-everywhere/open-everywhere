process.env.OE_SQLITE_PATH = ":memory:";
process.env.OE_OPERATIONAL_PROVIDER = "postgres";

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";

import { initOperationalSchema, makeOperationalPostgresStore, type PgClient } from "../agent/operational/postgres.js";
import { sqliteOperationalStore } from "../agent/operational/sqlite.js";
import { registerOperationalStore, resetOperationalStore } from "../agent/operational/provider.js";
import { registerConfig } from "../agent/access/config.js";
import { defineDomain } from "../agent/memory/domain.js";
import { LINK_TENANT_NONE, linkTenantOf, linkTenantUnresolvableMessage, tryLinkTenantOf } from "../agent/identity/link-tenant.js";
import { backfillLinkTenants, bootBackfillLinkTenants, linkTenantBackfillWarning } from "../agent/identity/link-tenant-backfill.js";
import { claimLinkChallenge, issueLinkChallenge, ratifyLinkChallenge, resolveLinkSet } from "../agent/identity/link-store.js";
import type { LinkChallengeRow, LinkedIdRow, OperationalStore } from "../agent/operational/store.js";
import { removeTempDir } from "./_temp-dir.js";

async function issueCode(input: Parameters<typeof issueLinkChallenge>[0]): Promise<{ challenge: LinkChallengeRow; code: string }> {
  const issued = await issueLinkChallenge(input);
  assert.ok(issued.code, "the code transport always mints a code");
  return { challenge: issued.challenge, code: issued.code };
}

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

const ORG = "default";
const WS_A = "T_AAA";
const WS_B = "T_BBB";
const TMP = mkdtempSync(join(tmpdir(), "oe-link-tenant-"));

function configWithSlackTenants(tenants: readonly string[]): void {
  registerConfig({
    loadBundles: () => [],
    loadBindings: () => [],
    pluginRegistry: {},
    skillContent: {},
    loadSilos: () => [],
    domainsForSurface: () => [],
    loadDomains: () => tenants.map((t, i) => defineDomain({ name: `d${i}`, reach: [`slack/${t}/C1`] })),
  });
}

function row(over: Partial<LinkedIdRow> & { platform: string; tenant: string; nativeId: string; linkSetId: string }): LinkedIdRow {
  return {
    org: ORG,
    status: "confirmed",
    establishedBy: "test",
    createdAt: "2026-01-10T12:20:00Z",
    updatedAt: "2026-01-10T12:20:00Z",
    ...over,
  };
}

{
  configWithSlackTenants([WS_A]);

  ok(linkTenantOf("slack", WS_B) === WS_B, "vocabulary: a SUPPLIED tenant is used verbatim on a tenant-scoped platform — the delivery's own fact wins over config");
  ok(linkTenantOf("slack") === WS_A, "vocabulary: with no tenant in hand, the deployment's SOLE admitted workspace is the answer (the phase-0c fence makes it a fact)");
  ok(linkTenantOf("github", "acme") === LINK_TENANT_NONE, "🔴 property 2/3: a vendor-global platform IGNORES a supplied tenant and stores the sentinel");

  ok(
    linkTenantOf("discord", "G_GUILD_1") === linkTenantOf("discord", "300000000000000104") && linkTenantOf("discord", "G_GUILD_1") === LINK_TENANT_NONE,
    "🔴 property 3: a discord GUILD binding and a discord DM binding compose the SAME account — the uniform-3-segment regression is avoided",
  );

  ok(linkTenantOf("slack", "   ") === WS_A, "vocabulary: a blank/whitespace tenant is 'not supplied', not a tenant — it falls through to the admitted one");

  configWithSlackTenants([]);
  ok(tryLinkTenantOf("slack", undefined) === undefined, "fail-closed: nothing declared ⇒ no answer (never a default)");
  let threw = "";
  try {
    linkTenantOf("slack");
  } catch (e) {
    threw = e instanceof Error ? e.message : String(e);
  }
  ok(threw === linkTenantUnresolvableMessage("slack"), "fail-loud: the throw carries the ONE operator-actionable message, naming both fixes");
  ok(threw.includes("agent/memory/config/domains.ts") && threw.includes("identity.allowMultiTenantPrincipals"), "fail-loud: …and that message names the declare-the-channel fix and the multi-tenant knob by their real spellings");
  ok(tryLinkTenantOf("github", undefined) === LINK_TENANT_NONE, "fail-closed is SCOPED: a vendor-global platform still answers with no config at all");

  configWithSlackTenants([WS_A, WS_B]);
  ok(tryLinkTenantOf("slack", undefined) === undefined, "🔴 two admitted workspaces ⇒ UNDEFINED, not a pick — an operator who admitted both made 'which one' a question only the delivery can answer");
  ok(tryLinkTenantOf("slack", WS_B) === WS_B, "…and a caller that DOES name its workspace is unaffected by the ambiguity");
}

async function keyInvariants(store: OperationalStore, engine: string): Promise<void> {
  const label = (s: string) => `${engine}: ${s}`;
  await store.putLinkSet(ORG, { org: ORG, id: "set-a", handle: "person A", status: "active", createdAt: "z", updatedAt: "z" });
  await store.putLinkSet(ORG, { org: ORG, id: "set-b", handle: "person B", status: "active", createdAt: "z", updatedAt: "z" });

  ok(await store.insertLinkedId(ORG, row({ linkSetId: "set-a", platform: "slack", tenant: WS_A, nativeId: "U_SAME" })), label("workspace A's member is inserted"));
  ok(
    await store.insertLinkedId(ORG, row({ linkSetId: "set-b", platform: "slack", tenant: WS_B, nativeId: "U_SAME" })),
    label("🔴 workspace B's member with the SAME native id is a SECOND account — under the 3-column key this insert was refused and the two humans shared one row"),
  );
  const a = await store.getLinkedId(ORG, "slack", WS_A, "U_SAME");
  const b = await store.getLinkedId(ORG, "slack", WS_B, "U_SAME");
  ok(a?.linkSetId === "set-a" && b?.linkSetId === "set-b", label("🔴 …and each resolves to its OWN person — the read is keyed by the whole triple"));
  ok(a?.tenant === WS_A && b?.tenant === WS_B, label("the tenant round-trips on the row"));

  ok(!(await store.insertLinkedId(ORG, row({ linkSetId: "set-b", platform: "slack", tenant: WS_A, nativeId: "U_SAME" }))), label("invariant 1 SURVIVES the widening — a second person cannot claim workspace A's account"));

  ok(await store.insertLinkedId(ORG, row({ linkSetId: "set-a", platform: "github", tenant: LINK_TENANT_NONE, nativeId: "octocat" })), label("a vendor-global account inserts under the sentinel"));
  ok(!(await store.insertLinkedId(ORG, row({ linkSetId: "set-b", platform: "github", tenant: LINK_TENANT_NONE, nativeId: "octocat" }))), label("property 2: a vendor-global platform still refuses a second claim — its behaviour is byte-identical"));

  ok(await store.updateLinkedIdStatus(ORG, "slack", WS_A, "U_SAME", ["confirmed"], "revoked", "test", undefined, "z"), label("update keys on the triple"));
  ok((await store.getLinkedId(ORG, "slack", WS_B, "U_SAME"))?.status === "confirmed", label("🔴 …and revoking workspace A's account leaves workspace B's UNTOUCHED"));
  ok(await store.deleteLinkedId(ORG, "slack", WS_A, "U_SAME"), label("delete keys on the triple"));
  ok((await store.getLinkedId(ORG, "slack", WS_B, "U_SAME")) !== null, label("🔴 …and severing workspace A's account does not sever workspace B's"));
}

const freshPg = new PGlite();
const freshPgClient: PgClient = { query: (text, params) => freshPg.query(text, params ? [...params] : undefined) };
await initOperationalSchema(freshPgClient);
await keyInvariants(makeOperationalPostgresStore(freshPgClient), "postgres");

process.env.OE_SQLITE_PATH = join(TMP, "fresh.sqlite3");
await keyInvariants(sqliteOperationalStore, "sqlite");

const OLD_PG_DDL = `CREATE TABLE identity_linked_ids (
   org_id         text NOT NULL,
   platform       text NOT NULL,
   native_id      text NOT NULL,
   link_set_id    text NOT NULL,
   status         text NOT NULL,
   established_by text NOT NULL,
   evidence       text,
   created_at     text NOT NULL,
   updated_at     text NOT NULL,
   PRIMARY KEY (org_id, platform, native_id)
 )`;
const OLD_SQLITE_DDL = OLD_PG_DDL.replace(/text/g, "TEXT");

{
  const old = new PGlite();
  const client: PgClient = { query: (text, params) => old.query(text, params ? [...params] : undefined) };
  await old.query(OLD_PG_DDL);
  await old.query("CREATE INDEX identity_linked_ids_org_set ON identity_linked_ids (org_id, link_set_id)");
  await old.query(
    `INSERT INTO identity_linked_ids (org_id, platform, native_id, link_set_id, status, established_by, created_at, updated_at)
     VALUES ('default','slack','U_LEGACY','set-legacy','confirmed','challenge:old','z','z'),
            ('default','github','gh-legacy','set-legacy','confirmed','challenge:old','z','z')`,
  );

  await initOperationalSchema(client);
  const store = makeOperationalPostgresStore(client);

  const rows = await store.listLinkedIds(ORG, "set-legacy");
  ok(rows.length === 2, "postgres migration: property 4 — BOTH pre-existing rows survived (this is real identity, not pre-launch ephemera)");
  ok(rows.every((r) => r.tenant === LINK_TENANT_NONE), "postgres migration: every migrated row carries the sentinel — final for github, 'nobody has named this yet' for slack");
  ok((await store.getLinkedId(ORG, "github", LINK_TENANT_NONE, "gh-legacy"))?.establishedBy === "challenge:old", "postgres migration: the evidence on a migrated row is intact");

  await store.putLinkSet(ORG, { org: ORG, id: "set-new", handle: "other", status: "active", createdAt: "z", updatedAt: "z" });
  ok(
    await store.insertLinkedId(ORG, row({ linkSetId: "set-new", platform: "slack", tenant: WS_B, nativeId: "U_LEGACY" })),
    "🔴 postgres migration: the PRIMARY KEY was swapped, not just the column added — a second workspace's same-id member now inserts",
  );

  await initOperationalSchema(client);
  ok((await store.listLinkedIds(ORG, "set-legacy")).length === 2, "postgres migration: property 4 — idempotent, a second boot changes nothing");
  ok((await store.getLinkedId(ORG, "slack", WS_B, "U_LEGACY"))?.linkSetId === "set-new", "postgres migration: …and the post-migration row is untouched by the re-run");
}

{
  const path = join(TMP, "legacy.sqlite3");
  const seed = new DatabaseSync(path);
  seed.exec(`${OLD_SQLITE_DDL};
    CREATE INDEX identity_linked_ids_org_set ON identity_linked_ids (org_id, link_set_id);
    INSERT INTO identity_linked_ids (org_id, platform, native_id, link_set_id, status, established_by, created_at, updated_at)
      VALUES ('default','slack','U_LEGACY','set-legacy','confirmed','challenge:old','z','z'),
             ('default','github','gh-legacy','set-legacy','confirmed','challenge:old','z','z');`);
  seed.close();

  process.env.OE_SQLITE_PATH = path;
  const store = sqliteOperationalStore;
  const rows = await store.listLinkedIds(ORG, "set-legacy");
  ok(rows.length === 2, "sqlite migration: property 4 — both rows survived the rename-copy-drop rebuild (sqlite cannot ALTER a PRIMARY KEY)");
  ok(rows.every((r) => r.tenant === LINK_TENANT_NONE), "sqlite migration: every migrated row carries the sentinel");
  ok((await store.getLinkedId(ORG, "github", LINK_TENANT_NONE, "gh-legacy"))?.establishedBy === "challenge:old", "sqlite migration: the evidence on a migrated row is intact");

  await store.putLinkSet(ORG, { org: ORG, id: "set-new", handle: "other", status: "active", createdAt: "z", updatedAt: "z" });
  ok(
    await store.insertLinkedId(ORG, row({ linkSetId: "set-new", platform: "slack", tenant: WS_B, nativeId: "U_LEGACY" })),
    "🔴 sqlite migration: the rebuilt table carries the 4-column PRIMARY KEY — a second workspace's same-id member now inserts",
  );
  const db = new DatabaseSync(path);
  const leftovers = db.prepare("SELECT name FROM sqlite_master WHERE name LIKE '%__pre_tenant%'").all();
  const idx = db.prepare("SELECT tbl_name FROM sqlite_master WHERE type = 'index' AND name = 'identity_linked_ids_org_set'").all() as { tbl_name: string }[];
  db.close();
  ok(leftovers.length === 0, "sqlite migration: the pre-migration table was dropped — no orphan left behind");
  ok(idx.length === 1 && idx[0]!.tbl_name === "identity_linked_ids", "sqlite migration: the org/set index is attached to the NEW table (the DROP INDEX before the rename is what makes this true)");
}

{
  const pg = new PGlite();
  const client: PgClient = { query: (text, params) => pg.query(text, params ? [...params] : undefined) };
  await initOperationalSchema(client);
  const store = makeOperationalPostgresStore(client);
  registerOperationalStore(store);
  resetOperationalStore();

  await store.putLinkSet(ORG, { org: ORG, id: "set-1", handle: "p", status: "active", createdAt: "z", updatedAt: "z" });
  await store.putLinkSet("other-org", { org: "other-org", id: "set-2", handle: "q", status: "active", createdAt: "z", updatedAt: "z" });
  await store.insertLinkedId(ORG, row({ linkSetId: "set-1", platform: "slack", tenant: LINK_TENANT_NONE, nativeId: "U_OLD" }));
  await store.insertLinkedId(ORG, row({ linkSetId: "set-1", platform: "github", tenant: LINK_TENANT_NONE, nativeId: "gh-old" }));
  await store.insertLinkedId("other-org", { ...row({ linkSetId: "set-2", platform: "slack", tenant: LINK_TENANT_NONE, nativeId: "U_OTHER_ORG" }), org: "other-org" });

  configWithSlackTenants([]);
  const blind = await backfillLinkTenants();
  ok(blind.filled.length === 0 && blind.unresolved.join() === "slack", "🔴 property 6: with no nameable workspace the sweep FILLS NOTHING and reports the platform as unresolved");
  ok((await store.getLinkedId(ORG, "slack", LINK_TENANT_NONE, "U_OLD")) !== null, "🔴 property 6: …the row is LEFT EXACTLY AS IT WAS — a dormant link (standing lost) beats an invented workspace (standing mis-granted)");

  const lines: string[] = [];
  await bootBackfillLinkTenants({ log: (l) => lines.push(l) });
  ok(lines.length === 1 && lines[0] === linkTenantBackfillWarning("slack"), "🔴 property 6: the BOOT hook logs the operator line…");
  ok(lines[0]!.includes("agent/memory/config/domains.ts") && lines[0]!.includes("DORMANT"), "property 6: …which names the self-healing fix and says plainly that the links are dormant");

  configWithSlackTenants([WS_A]);
  const filled = await backfillLinkTenants();
  ok(filled.unresolved.length === 0 && filled.filled.length === 1 && filled.filled[0]!.tenant === WS_A, "property 5: with the workspace declared the sweep resolves it — the backfill is SELF-HEALING across boots");
  ok(filled.filled[0]!.rows === 2, "🔴 the sweep is DEPLOYMENT-WIDE — both orgs' slack rows moved, because the workspace is a fact about the deployment, not about an org");
  ok((await store.getLinkedId(ORG, "slack", WS_A, "U_OLD"))?.linkSetId === "set-1", "property 5: the slack row now answers under its real workspace");
  ok((await store.getLinkedId(ORG, "slack", LINK_TENANT_NONE, "U_OLD")) === null, "property 5: …and no longer under the sentinel — it MOVED, it was not copied");
  ok((await store.getLinkedId(ORG, "github", LINK_TENANT_NONE, "gh-old")) !== null, "🔴 property 5: the vendor-global row was NOT touched — `''` is its correct, permanent value, not a backlog item");

  configWithSlackTenants([WS_B]);
  const second = await backfillLinkTenants();
  ok(second.filled.length === 0 && second.unresolved.length === 0, "property 5: a second sweep under a DIFFERENT declared workspace finds no blanks — idempotent");
  ok((await store.getLinkedId(ORG, "slack", WS_A, "U_OLD")) !== null, "🔴 property 5: …and the already-stamped row keeps ITS workspace — a backfill only ever fills a blank, it never rewrites a delivery's own statement");

  const broken: OperationalStore = { ...store, unbackfilledLinkedIdPlatforms: async () => { throw new Error("store down"); } };
  const outageLines: string[] = [];
  await bootBackfillLinkTenants({ store: broken, log: (l) => outageLines.push(l) });
  ok(outageLines.length === 1 && outageLines[0]!.includes("store down"), "the boot hook SWALLOWS a store outage into one line — an identity backfill is never the reason a deployment fails to come up");
}

{
  const pg = new PGlite();
  const client: PgClient = { query: (text, params) => pg.query(text, params ? [...params] : undefined) };
  await initOperationalSchema(client);
  const store = makeOperationalPostgresStore(client);
  registerOperationalStore(store);
  resetOperationalStore();
  configWithSlackTenants([WS_A]);

  const issued = await issueCode({ org: ORG, platform: "slack", tenant: WS_A, nativeId: "U_TWIN", surfaceKey: `slack/${WS_A}/D1` });
  ok((await store.getLinkChallenge(ORG, issued.challenge.id))?.initiatingTenant === WS_A, "property 7: the challenge records the INITIATING workspace, so a ratification days later joins the account this turn named");

  const claimed = await claimLinkChallenge({ org: ORG, code: issued.code, claimant: { platform: "slack", tenant: WS_B, nativeId: "U_TWIN" } });
  ok(claimed?.claimedTenant === WS_B && claimed.claimedNativeId === "U_TWIN", "🔴 property 7: the initiator's ID-TWIN IN ANOTHER WORKSPACE may claim — the self-claim exclusion is tenant-qualified, not id-qualified");

  const ratified = await ratifyLinkChallenge({ org: ORG, challengeId: issued.challenge.id, handle: "twin" });
  ok(ratified.ok, "property 7: …and the ratification lands");
  ok((await resolveLinkSet(ORG, "slack", "U_TWIN", WS_A))?.id === (ratified.ok ? ratified.linkSetId : ""), "property 7: workspace A's account resolves the set");
  ok((await resolveLinkSet(ORG, "slack", "U_TWIN", WS_B))?.id === (ratified.ok ? ratified.linkSetId : ""), "property 7: so does workspace B's — two accounts, ONE person, which is exactly what a link-set is for");

  const own = await issueCode({ org: ORG, platform: "slack", tenant: WS_A, nativeId: "U_SELF", surfaceKey: `slack/${WS_A}/D2` });
  ok((await claimLinkChallenge({ org: ORG, code: own.code, claimant: { platform: "slack", tenant: WS_A, nativeId: "U_SELF" } })) === null, "property 7: a TRUE self-claim (same workspace, same id) is still refused — the fence narrowed, it did not open");
}

await removeTempDir(TMP);
console.log(`✓ link-tenant: ${n} assertions (vocabulary, the widened PK on both engines, the in-place migration from the pre-phase-2 shape, the backfill + its fail-loud/fail-closed edge, the tenant-qualified challenge flow)`);
