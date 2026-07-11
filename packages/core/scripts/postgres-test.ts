
import { PGlite } from "@electric-sql/pglite";
import { initPostgresSchema, makePostgresProvider, setOrgContext, type PgClient } from "../agent/memory/postgres.js";
import { WORKSPACE, SURFACE, siloTier } from "../agent/memory/store.js";
import type { Partition } from "../agent/memory/partition.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

function partition(workspace: string, surface: string, org = "default"): Partition {
  const workspaceKey = `slack/${workspace}`;
  const surfaceKey = `${workspaceKey}/${surface}`;
  return { org, platform: "slack", workspace, surface, workspaceKey, surfaceKey, key: surfaceKey };
}

const db = new PGlite();
const client: PgClient = { query: (text, params) => db.query(text, params ? [...params] : undefined) };
await initPostgresSchema(client);
const provider = makePostgresProvider(client);

{
  const p = partition("acme", "general");

  ok(Object.keys(await provider.readTier(p, WORKSPACE)).length === 0, "fresh tier reads empty");

  const seeded = await provider.ensureTier(p, WORKSPACE);
  ok("MEMORY.md" in seeded && seeded["MEMORY.md"].includes("Workspace memory"), "ensureTier seeds workspace MEMORY.md");
  ok((await provider.readTier(p, WORKSPACE))["MEMORY.md"] === seeded["MEMORY.md"], "readTier returns seeded content");
  ok((await provider.ensureTier(p, WORKSPACE))["MEMORY.md"] === seeded["MEMORY.md"], "ensureTier idempotent");

  ok((await provider.writeTier(p, WORKSPACE, seeded, "noop")) === null, "unchanged write returns null");
  const v1 = await provider.writeTier(p, WORKSPACE, { "MEMORY.md": "# changed\n" }, "edit");
  ok(typeof v1 === "string" && v1.length > 0, "changed write returns a version token");
  ok((await provider.readTier(p, WORKSPACE))["MEMORY.md"] === "# changed\n", "write is durable");

  await provider.writeTier(p, WORKSPACE, { "people.md": "@ana owns deploys\n" }, "add");
  const both = await provider.readTier(p, WORKSPACE);
  ok(both["MEMORY.md"] === "# changed\n" && both["people.md"] === "@ana owns deploys\n", "write unions files (upsert-only)");

  ok((await provider.tierVersion!(partition("never", "written"), WORKSPACE)) === null, "tierVersion is null for a never-written tier");
  const vBefore = await provider.tierVersion!(p, WORKSPACE);
  ok(typeof vBefore === "string" && vBefore.length > 0, "tierVersion is non-null once written");
  ok((await provider.tierVersion!(p, WORKSPACE)) === vBefore, "tierVersion is stable while nothing changes (the skip gate)");
  await provider.writeTier(p, WORKSPACE, { "version-probe.md": "advanced\n" }, "bump");
  const vAfter = await provider.tierVersion!(p, WORKSPACE);
  ok(typeof vAfter === "string" && vAfter !== vBefore, "tierVersion advances on a changed write");

  await provider.ensureTier(p, SURFACE);
  await provider.writeTier(p, SURFACE, { "MEMORY.md": "surface-only\n" }, "s");
  await provider.ensureTier(p, siloTier("payments"));
  ok((await provider.readTier(p, WORKSPACE))["MEMORY.md"] === "# changed\n", "surface/domain writes don't touch workspace");
  ok((await provider.readTier(p, SURFACE))["MEMORY.md"] === "surface-only\n", "surface tier isolated");
  ok((await provider.readTier(p, siloTier("payments")))["MEMORY.md"].includes('"payments"'), "silo tier seeded under its name");

  await provider.deleteTier(p, WORKSPACE);
  ok(Object.keys(await provider.readTier(p, WORKSPACE)).length === 0, "deleteTier erases the tier");
  await provider.deleteTier(p, WORKSPACE);
  ok(true, "deleteTier is idempotent");
  ok((await provider.readTier(p, SURFACE))["MEMORY.md"] === "surface-only\n", "delete is tier-scoped");
}

{
  const a = partition("acme", "general", "org-a");
  const b = partition("acme", "general", "org-b");

  await provider.ensureTier(a, WORKSPACE);
  await provider.writeTier(a, WORKSPACE, { "MEMORY.md": "A's secret\n" }, "a");
  ok(Object.keys(await provider.readTier(b, WORKSPACE)).length === 0, "org-b cannot see org-a's tier (different org)");
  await provider.ensureTier(b, WORKSPACE);
  await provider.writeTier(b, WORKSPACE, { "MEMORY.md": "B's secret\n" }, "b");
  ok((await provider.readTier(a, WORKSPACE))["MEMORY.md"] === "A's secret\n", "org-a unaffected by org-b's write");

  await provider.deleteTier(a, WORKSPACE);
  ok(Object.keys(await provider.readTier(a, WORKSPACE)).length === 0, "org-a erased");
  ok((await provider.readTier(b, WORKSPACE))["MEMORY.md"] === "B's secret\n", "org-b survives org-a's erasure");
}

{
  const p = partition("ver", "general");
  await provider.ensureTier(p, WORKSPACE);
  const a = await provider.writeTier(p, WORKSPACE, { "MEMORY.md": "one\n" }, "1");
  const b = await provider.writeTier(p, WORKSPACE, { "MEMORY.md": "two\n" }, "2");
  ok(a !== null && b !== null && Number(b) > Number(a), "version token is monotonic across changes");
}

{
  const a = partition("rls", "general", "rls-org-a");
  const b = partition("rls", "general", "rls-org-b");
  await provider.ensureTier(a, WORKSPACE);
  await provider.writeTier(a, WORKSPACE, { "MEMORY.md": "A under rls\n" }, "a");
  await provider.ensureTier(b, WORKSPACE);
  await provider.writeTier(b, WORKSPACE, { "MEMORY.md": "B under rls\n" }, "b");

  await db.exec(`CREATE ROLE open_everywhere_app NOSUPERUSER;
                 GRANT SELECT, INSERT, UPDATE, DELETE ON memory_file, memory_tier TO open_everywhere_app;`);
  try {
    await db.exec("SET ROLE open_everywhere_app");
    await setOrgContext(client, "rls-org-a");
    const all = await client.query("SELECT DISTINCT org_id FROM memory_file");
    const orgs = (all.rows as { org_id: string }[]).map((r) => r.org_id);
    ok(orgs.length === 1 && orgs[0] === "rls-org-a", "RLS: a no-WHERE read under the app role returns only the GUC's org");

    ok((await provider.readTier(a, WORKSPACE))["MEMORY.md"] === "A under rls\n", "RLS: provider reads its own org under the app role");
    ok(Object.keys(await provider.readTier(b, WORKSPACE)).length === 0, "RLS: provider sees nothing for the other org under the app role");
  } finally {
    await db.exec("RESET ROLE");
  }
}

await db.close();
console.log(`✓ postgres — ${passed} assertions (pglite contract, column isolation, erasure, versioning, RLS enforcement)`);
