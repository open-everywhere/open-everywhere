import { PGlite } from "@electric-sql/pglite";
import { initOperationalSchema, makeOperationalPostgresStore, setOrgContext, type PgClient } from "../agent/operational/postgres.js";
import type { Routine } from "../agent/routines/routine.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

function routine(org: string, surfaceKey: string, id: string, over: Partial<Routine> = {}): Routine {
  return {
    id,
    org,
    surfaceKey,
    trigger: { kind: "interval", everyMinutes: 60 },
    prompt: "do the thing",
    createdAt: "2026-06-25T00:00:00Z",
    status: "active",
    consecutiveFailures: 0,
    ...over,
  };
}

const db = new PGlite();
const client: PgClient = { query: (text, params) => db.query(text, params ? [...params] : undefined) };
await initOperationalSchema(client);
const store = makeOperationalPostgresStore(client);

{
  await store.recordUsage("default", "slack/T1/C1", "2026-06", { inputTokens: 100, outputTokens: 100 });
  await store.recordUsage("default", "slack/T1/C1", "2026-06", { inputTokens: 0, outputTokens: 50 });
  await store.recordUsage("default", "slack/T1/C2", "2026-06", { inputTokens: 200, outputTokens: 0 });

  const led = await store.surfaceLedger("default", "slack/T1/C1");
  const w = led.windows["2026-06"];
  ok(w.inputTokens === 100 && w.outputTokens === 150 && w.calls === 2, "spend: usage accumulates atomically across calls");
  ok(!("2026-07" in led.windows), "spend: other period is empty");

  const all = await store.allLedgers();
  ok(all.length === 2, "spend: allLedgers groups one row per (org, surface)");

  await store.recordUsage("acme", "slack/T1/C1", "2026-06", { inputTokens: 777, outputTokens: 0 });
  ok((await store.surfaceLedger("default", "slack/T1/C1")).windows["2026-06"].inputTokens === 100, "spend: another org's usage doesn't bleed into this org");
  ok((await store.surfaceLedger("acme", "slack/T1/C1")).windows["2026-06"].inputTokens === 777, "spend: the other org has its own isolated ledger");
}

{
  await store.addRoutine(routine("default", "local/dev/alpha", "r-1"));
  ok((await store.listRoutines("default", "local/dev/alpha")).length === 1, "routine: persisted to its surface");
  ok((await store.listRoutines("default", "local/dev/beta")).length === 0, "routine: another surface doesn't see it");

  const upd = await store.updateRoutine("default", "local/dev/alpha", "r-1", { status: "disabled", disabledReason: "manual" });
  ok(upd?.status === "disabled" && upd?.id === "r-1" && upd?.org === "default", "routine: update mutates + preserves immutable keys");
  ok((await store.updateRoutine("default", "local/dev/alpha", "nope", {})) === null, "routine: update of missing id returns null");

  await store.addRoutine(routine("default", "local/dev/beta", "r-2"));
  ok((await store.listAllRoutines()).length === 2, "routine: listAll spans surfaces");
  ok((await store.getRoutine("default", "local/dev/alpha", "r-1"))?.id === "r-1", "routine: getRoutine by org+surface+id");

  await store.addRoutine(routine("acme", "local/dev/alpha", "r-3"));
  ok((await store.listRoutines("default", "local/dev/alpha")).length === 1, "routine: another org's routine for the same surfaceKey is invisible");
  ok((await store.getRoutine("default", "local/dev/alpha", "r-1"))?.org === "default", "routine: getRoutine stays within the requested org");

  ok((await store.removeRoutine("default", "local/dev/alpha", "r-1")) === true, "routine: remove returns true");
  ok((await store.listRoutines("default", "local/dev/alpha")).length === 0, "routine: gone after remove");
  ok((await store.removeRoutine("default", "local/dev/alpha", "r-1")) === false, "routine: removing twice returns false");
}

{
  await store.appendAudit({ ts: "2026-06-24T10:00:00Z", org: "acme", platform: "slack", workspace: "T1", surface: "C1", principalId: "U1", action: "memory.write", detail: { files: 2 } });
  await store.appendAudit({ ts: "2026-06-24T12:00:00Z", org: "acme", platform: "slack", workspace: "T2", surface: "C9", principalId: "U1", action: "egress.policy" });
  await store.appendAudit({ ts: "2026-06-24T09:00:00Z", org: "globex", platform: "linear", workspace: "O1", action: "memory.write" });

  const acme = await store.readAudit({ org: "acme" });
  ok(acme.length === 2 && acme.every((e) => e.org === "acme"), "audit: org scan isolates");
  ok(acme[0].ts === "2026-06-24T12:00:00Z", "audit: newest-first");
  ok((await store.readAudit({ org: "acme", action: "memory.write" })).length === 1, "audit: filter by action");
  ok((await store.readAudit({ org: "acme", since: "2026-06-24T11:00:00Z" })).length === 1, "audit: filter by since");
  ok((await store.readAudit({ org: "acme", limit: 1 })).length === 1, "audit: limit caps");
  ok((await store.readAudit({})).length === 3, "audit: no-org scan walks all");
  ok((acme[0].detail === undefined) === true || acme[1].detail?.files === 2, "audit: detail round-trips as JSON");
  ok(!("removeAudit" in store) && !("deleteAudit" in store), "audit: store exposes no delete method");
}

{
  await store.setSpendLimit("default", "slack/T1/C1", "surface", 1000);
  await store.setSpendLimit("default", "slack/T1", "workspace", 50000);
  await store.setSpendLimit("acme", "slack/T1/C1", "surface", 7);
  const def = await store.spendLimits("default");
  ok(def.length === 2, "spend limits persist per org");
  ok((await store.spendLimits("acme")).every((l) => l.monthlyTokens === 7), "spend limit is org-isolated");
  await store.setSpendLimit("default", "slack/T1/C1", "surface", 2000);
  ok((await store.spendLimits("default")).find((l) => l.scopeKey === "slack/T1/C1")?.monthlyTokens === 2000, "setSpendLimit upserts");
  ok((await store.clearSpendLimit("default", "slack/T1/C1", "surface")) === true && (await store.spendLimits("default")).length === 1, "clearSpendLimit removes one");

  await store.setConnectorOverride("default", "slack/T1/C1", "notion", true);
  await store.setConnectorOverride("default", "slack/T1/C1", "linear", false);
  const ov = await store.connectorOverrides("default", "slack/T1/C1");
  ok(ov.find((o) => o.connector === "notion")?.granted === true && ov.find((o) => o.connector === "linear")?.granted === false, "connector overrides persist grant + revoke");
  ok((await store.connectorOverrides("default", "slack/T1/C9")).length === 0, "connector overrides are scope-isolated");
  ok((await store.clearConnectorOverride("default", "slack/T1/C1", "linear")) === true && (await store.connectorOverrides("default", "slack/T1/C1")).length === 1, "clearConnectorOverride reverts to config");
}

{
  await db.exec(`CREATE ROLE oe_app NOSUPERUSER;
                 GRANT SELECT, INSERT, UPDATE, DELETE ON spend_ledger, routine, audit_entry TO oe_app;`);
  try {
    await db.exec("SET ROLE oe_app");
    await setOrgContext(client, "acme");

    const spendOrgs = ((await client.query("SELECT DISTINCT org_id FROM spend_ledger")).rows as { org_id: string }[]).map((r) => r.org_id);
    ok(spendOrgs.length === 1 && spendOrgs[0] === "acme", "RLS: spend no-WHERE read returns only the GUC org");
    const auditOrgs = ((await client.query("SELECT DISTINCT org_id FROM audit_entry")).rows as { org_id: string }[]).map((r) => r.org_id);
    ok(auditOrgs.length === 1 && auditOrgs[0] === "acme", "RLS: audit no-WHERE read returns only the GUC org");

    const del = (await client.query("DELETE FROM audit_entry RETURNING seq")).rows;
    ok(del.length === 0, "RLS: DELETE on audit_entry affects 0 rows under the app role (append-only)");
    const upd = (await client.query("UPDATE audit_entry SET action = 'tampered' RETURNING seq")).rows;
    ok(upd.length === 0, "RLS: UPDATE on audit_entry affects 0 rows under the app role (immutable)");
  } finally {
    await db.exec("RESET ROLE");
  }
  ok((await store.readAudit({ org: "acme" })).length === 2, "RLS: audit rows survived the blocked DELETE/UPDATE");
}

await db.close();
console.log(`✓ operational — ${passed} assertions (pglite contract, spend/routine/audit isolation, RLS, audit append-only)`);
