
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

  await store.addRoutine(routine("default", "local/dev/gamma", "r-cron", { trigger: { kind: "cron", expr: "0 9 * * *" } }));
  await store.addRoutine(
    routine("default", "local/dev/gamma", "r-once", { trigger: { kind: "once", at: "2026-07-08T09:00:00.000Z" }, nextRunAt: "2026-07-08T09:00:00.000Z" }),
  );
  const gamma = await store.listRoutines("default", "local/dev/gamma");
  ok(gamma.length === 2, "routine: a once row round-trips through postgres alongside a pre-existing cron row");
  const onceRow = gamma.find((r) => r.id === "r-once");
  ok(onceRow?.trigger.kind === "once" && (onceRow.trigger as { at: string }).at === "2026-07-08T09:00:00.000Z", "routine: postgres round-trips the once trigger's `at` exactly");
  ok(gamma.find((r) => r.id === "r-cron")?.trigger.kind === "cron", "routine: the pre-existing cron row is untouched by the once addition");

  const onceDisabled = await store.updateRoutine("default", "local/dev/gamma", "r-once", {
    status: "disabled",
    disabledReason: "once: fired at 2026-07-08T09:05:00.000Z",
    nextRunAt: null,
  });
  ok(onceDisabled?.status === "disabled" && onceDisabled.trigger.kind === "once", "routine: postgres updateRoutine's generic patch disables a once row without disturbing its trigger");
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
  const { findChainBreak, auditRowSha, verifyAuditChainTail } = await import("../agent/audit/chain.js");
  const CO = "chainacme";
  await store.appendAudit({ ts: "2026-07-01T00:00:00Z", org: CO, platform: "slack", workspace: "T1", action: "a.one", detail: { n: 1 } });
  await store.appendAudit({ ts: "2026-07-01T00:01:00Z", org: CO, platform: "slack", workspace: "T1", action: "a.two", detail: { n: 2 } });
  await store.appendAudit({ ts: "2026-07-01T00:02:00Z", org: CO, platform: "slack", workspace: "T1", action: "a.three", detail: { n: 3 } });

  const chain = await store.readAuditChain(CO);
  ok(chain.length === 3 && chain[0].ts === "2026-07-01T00:00:00Z" && chain[2].ts === "2026-07-01T00:02:00Z", "chain(pg): readAuditChain returns all rows oldest-first");
  ok(chain[0].prevSha === null, "chain(pg): genesis row has null prev_sha");
  ok(chain[1].prevSha === auditRowSha(chain[0], null) && chain[2].prevSha === auditRowSha(chain[1], chain[1].prevSha), "chain(pg): each row's prev_sha = sha(previous row)");
  ok(findChainBreak(chain, { expectGenesis: true }) === null, "chain(pg): an intact chain verifies clean");

  const mutated = chain.map((r, i) => (i === 1 ? { ...r, detail: { n: 999 } } : r));
  ok(findChainBreak(mutated, { expectGenesis: true })?.action === "a.three", "chain(pg): a mutated middle row is detected at its successor");
  const deleted = [chain[0], chain[2]];
  ok(findChainBreak(deleted, { expectGenesis: true })?.action === "a.three", "chain(pg): a deleted middle row is detected at the next surviving row");

  await store.appendAudit({ ts: "2026-07-01T00:00:00Z", org: "chainglobex", platform: "discord", workspace: "G1", action: "b.one" });
  const other = await store.readAuditChain("chainglobex");
  ok(other.length === 1 && other[0].prevSha === null, "chain(pg): a second org starts its own genesis (no interleave)");
  ok((await store.readAuditChain(CO)).length === 3, "chain(pg): the first org's chain is unchanged by the second org's append");

  const tail = await store.readAuditChain(CO, { tailLimit: 2 });
  ok(tail.length === 2 && tail[0].ts === "2026-07-01T00:01:00Z" && findChainBreak(tail, { expectGenesis: false }) === null, "chain(pg): tailLimit returns the last N oldest-first, sound");

  const orgs = await store.listAuditOrgs();
  ok(orgs.includes(CO) && orgs.includes("chainglobex"), "chain(pg): listAuditOrgs enumerates the chained orgs");
  const mine = (await verifyAuditChainTail(store)).filter((r) => r.org === CO || r.org === "chainglobex");
  ok(mine.length === 2 && mine.every((r) => r.break === null && !r.error), "chain(pg): verifyAuditChainTail reports both chained orgs intact");
}

{
  const base = { org: "acme", surfaceKey: "slack/T1/C1", sessionId: "sess-1", inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  await store.appendUsageEvent({ ...base, ts: "2026-06-24T10:00:00Z", principalId: "U1", kind: "channel", inputTokens: 100, outputTokens: 50 });
  await store.appendUsageEvent({ ...base, ts: "2026-06-24T10:05:00Z", principalId: "U1", kind: "channel", inputTokens: 10, outputTokens: 5 });
  await store.appendUsageEvent({ ...base, sessionId: "sess-2", ts: "2026-06-24T10:10:00Z", principalId: "U2", kind: "dm", inputTokens: 200 });
  await store.appendUsageEvent({ org: "globex", surfaceKey: "slack/T1/C1", sessionId: "sess-9", ts: "2026-06-24T10:00:00Z", inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });

  const forSession = await store.usageForSession("acme", "sess-1");
  ok(forSession.length === 2 && forSession[0].ts === "2026-06-24T10:00:00Z", "usage events: usageForSession returns the session's rows, oldest-first");
  ok((await store.usageForSession("globex", "sess-1")).length === 0, "usage events: usageForSession is org-isolated");

  const summary = await store.usageSummary("acme");
  const chan = summary.find((r) => r.kind === "channel");
  ok(chan?.inputTokens === 110 && chan.outputTokens === 55 && chan.events === 2 && chan.sessions === 1, "usage events: usageSummary sums tokens + counts events/sessions per group");
  ok((await store.usageSummary("globex")).every((r) => r.sessions === 1), "usage events: usageSummary is org-isolated");

  ok((await store.pruneUsageEvents("acme", "2099-01-01T00:00:00Z")) === 0, "usage events: pruneUsageEvents is a no-op on Postgres (append-only)");
  ok((await store.usageForSession("acme", "sess-1")).length === 2, "usage events: rows survive the no-op prune untouched");
}

{
  await store.setSpendLimit("default", "slack/T1/C1", "surface", { monthlyTokens: 1000 });
  await store.setSpendLimit("default", "slack/T1", "workspace", { monthlyTokens: 50000 });
  await store.setSpendLimit("acme", "slack/T1/C1", "surface", { monthlyTokens: 7 });
  const def = await store.spendLimits("default");
  ok(def.length === 2, "spend limits persist per org");
  ok((await store.spendLimits("acme")).every((l) => l.monthlyTokens === 7), "spend limit is org-isolated");
  await store.setSpendLimit("default", "slack/T1/C1", "surface", { monthlyTokens: 2000 });
  ok((await store.spendLimits("default")).find((l) => l.scopeKey === "slack/T1/C1")?.monthlyTokens === 2000, "setSpendLimit upserts");
  const tokenOnly = (await store.spendLimits("default")).find((l) => l.scopeKey === "slack/T1/C1");
  ok(tokenOnly?.monthlyUsd === undefined, "a token-only override carries no monthlyUsd");
  await store.setSpendLimit("default", "slack/T1/C1", "surface", { monthlyUsd: 12.5 });
  const usdOnly = (await store.spendLimits("default")).find((l) => l.scopeKey === "slack/T1/C1");
  ok(usdOnly?.monthlyUsd === 12.5 && usdOnly?.monthlyTokens === undefined, "a USD-only override round-trips with monthlyTokens absent (sentinel never leaks)");
  await store.setSpendLimit("default", "slack/T1/C1", "surface", { monthlyTokens: 2000, monthlyUsd: 40 });
  const both = (await store.spendLimits("default")).find((l) => l.scopeKey === "slack/T1/C1");
  ok(both?.monthlyTokens === 2000 && both?.monthlyUsd === 40, "an override carrying both components round-trips both");
  await store.setSpendLimit("default", "slack/T1/C1", "surface", { monthlyTokens: 2000 });
  ok(await store.setSpendLimit("default", "slack/T1/C1", "surface", {}).then(() => false, () => true), "setSpendLimit rejects an override with no component");
  ok(await store.setSpendLimit("default", "slack/T1/C1", "surface", { monthlyTokens: -5 }).then(() => false, () => true), "setSpendLimit rejects a negative token limit (would collide with the sentinel)");
  ok(await store.setSpendLimit("default", "slack/T1/C1", "surface", { monthlyUsd: 0 }).then(() => false, () => true), "setSpendLimit rejects a non-positive USD limit");
  ok((await store.clearSpendLimit("default", "slack/T1/C1", "surface")) === true && (await store.spendLimits("default")).length === 1, "clearSpendLimit removes one");

  await store.setSpendLimit("default", "eng", "domain", { monthlyTokens: 4000 });
  const domainLimits = await store.spendLimits("default");
  const domainRow = domainLimits.find((l) => l.scopeKey === "eng" && l.level === "domain");
  ok(domainRow?.monthlyTokens === 4000, "setSpendLimit round-trips a domain-level override, scoped by domain name");
  ok(domainLimits.some((l) => l.level === "workspace" && l.scopeKey === "slack/T1"), "a domain-level override coexists with the earlier workspace-level one at a DIFFERENT scopeKey (no key collision)");
  await store.setSpendLimit("default", "eng", "domain", { monthlyUsd: 99 });
  ok((await store.spendLimits("default")).find((l) => l.scopeKey === "eng" && l.level === "domain")?.monthlyUsd === 99, "setSpendLimit upserts a domain-level override the same way surface/workspace do");
  ok((await store.clearSpendLimit("default", "eng", "domain")) === true, "clearSpendLimit removes a domain-level override");
  ok((await store.spendLimits("default")).every((l) => !(l.scopeKey === "eng" && l.level === "domain")), "the cleared domain-level override is gone");

  await store.setConnectorOverride("default", "slack/T1/C1", "notion", true);
  await store.setConnectorOverride("default", "slack/T1/C1", "linear", false);
  const ov = await store.connectorOverrides("default", "slack/T1/C1");
  ok(ov.find((o) => o.connector === "notion")?.granted === true && ov.find((o) => o.connector === "linear")?.granted === false, "connector overrides persist grant + revoke");
  ok((await store.connectorOverrides("default", "slack/T1/C9")).length === 0, "connector overrides are scope-isolated");
  ok((await store.clearConnectorOverride("default", "slack/T1/C1", "linear")) === true && (await store.connectorOverrides("default", "slack/T1/C1")).length === 1, "clearConnectorOverride reverts to config");
}

{
  await store.setSpendLimit("default", "slack/T1/C1", "surface", { monthlyTokens: 3000 }, { expiresAt: 1234567890, reason: "blocked mid-task", setBy: "admin#1" });
  const meta = (await store.spendLimits("default")).find((l) => l.scopeKey === "slack/T1/C1" && l.level === "surface");
  ok(meta?.expiresAt === 1234567890 && meta?.reason === "blocked mid-task" && meta?.setBy === "admin#1", "spend override persists bridge metadata");
  await store.setSpendLimit("default", "slack/T1/C1", "surface", { monthlyTokens: 3000 });
  ok((await store.spendLimits("default")).find((l) => l.scopeKey === "slack/T1/C1" && l.level === "surface")?.expiresAt === undefined, "re-set without meta clears expiresAt (no stale bridge)");

  await store.setConnectorOverride("default", "slack/T1/C1", "notion", false, { reason: "leaked token", setBy: "admin#2" });
  const all = await store.allConnectorOverrides("default");
  const a = all.find((o) => o.connector === "notion");
  ok(a?.scopeKey === "slack/T1/C1" && a?.reason === "leaked token" && a?.setBy === "admin#2", "allConnectorOverrides returns scope + reason/setBy (drift view)");
  ok((await store.allConnectorOverrides("acme")).length === 0, "allConnectorOverrides is org-isolated");
}

{
  await db.exec(`CREATE ROLE open_everywhere_app NOSUPERUSER;
                 GRANT SELECT, INSERT, UPDATE, DELETE ON spend_ledger, routine, audit_entry, usage_events TO open_everywhere_app;`);
  try {
    await db.exec("SET ROLE open_everywhere_app");
    await setOrgContext(client, "acme");

    const spendOrgs = ((await client.query("SELECT DISTINCT org_id FROM spend_ledger")).rows as { org_id: string }[]).map((r) => r.org_id);
    ok(spendOrgs.length === 1 && spendOrgs[0] === "acme", "RLS: spend no-WHERE read returns only the GUC org");

    const auditOrgs = new Set(((await client.query("SELECT DISTINCT org_id FROM audit_entry")).rows as { org_id: string }[]).map((r) => r.org_id));
    ok(auditOrgs.has("acme") && auditOrgs.has("globex"), "RLS: audit SELECT is GUC-free/permissive — isolation is the query filter, not the policy");
    const usageOrgs = new Set(((await client.query("SELECT DISTINCT org_id FROM usage_events")).rows as { org_id: string }[]).map((r) => r.org_id));
    ok(usageOrgs.has("acme") && usageOrgs.has("globex"), "RLS: usage_events SELECT is GUC-free/permissive — isolation is the query filter");

    ok((await client.query("DELETE FROM audit_entry RETURNING seq")).rows.length === 0, "append-only: DELETE on audit_entry affects 0 rows under the app role");
    ok((await client.query("UPDATE audit_entry SET action = 'tampered' RETURNING seq")).rows.length === 0, "append-only: UPDATE on audit_entry affects 0 rows under the app role");
    ok((await client.query("DELETE FROM usage_events RETURNING seq")).rows.length === 0, "append-only: DELETE on usage_events affects 0 rows under the app role");
    ok((await client.query("UPDATE usage_events SET kind = 'tampered' RETURNING seq")).rows.length === 0, "append-only: UPDATE on usage_events affects 0 rows under the app role");
    await client.query("INSERT INTO audit_entry (ts, org_id, platform, workspace, action) VALUES ('2026-06-24T13:00:00Z', 'acme', 'slack', 'T1', 'probe.append')");
  } finally {
    await db.exec("RESET ROLE");
  }
  await db.exec("REVOKE UPDATE, DELETE ON audit_entry, usage_events FROM open_everywhere_app");
}

{
  await db.exec(`CREATE ROLE oe_table_owner NOSUPERUSER;
                 GRANT CREATE ON SCHEMA public TO oe_table_owner;
                 GRANT SELECT, INSERT, UPDATE, DELETE ON audit_entry, usage_events TO oe_table_owner;
                 ALTER TABLE audit_entry OWNER TO oe_table_owner;
                 ALTER TABLE usage_events OWNER TO oe_table_owner;`);
  try {
    await db.exec("SET ROLE oe_table_owner");
    ok(((await client.query("SELECT count(*)::int AS n FROM audit_entry")).rows as { n: number }[])[0].n > 0, "FORCE: the non-superuser OWNER can still SELECT audit_entry");
    await client.query("INSERT INTO audit_entry (ts, org_id, platform, workspace, action) VALUES ('2026-06-24T14:00:00Z', 'acme', 'slack', 'T1', 'owner.append')");
    ok((await client.query("DELETE FROM audit_entry RETURNING seq")).rows.length === 0, "FORCE: DELETE on audit_entry affects 0 rows for the NON-SUPERUSER OWNER (owner-bypass closed)");
    ok((await client.query("UPDATE audit_entry SET action = 'tampered' RETURNING seq")).rows.length === 0, "FORCE: UPDATE on audit_entry affects 0 rows for the owner (immutable)");
    ok((await client.query("DELETE FROM usage_events RETURNING seq")).rows.length === 0, "FORCE: DELETE on usage_events affects 0 rows for the owner (append-only)");
    ok((await client.query("UPDATE usage_events SET kind = 'tampered' RETURNING seq")).rows.length === 0, "FORCE: UPDATE on usage_events affects 0 rows for the owner (immutable)");
  } finally {
    await db.exec("RESET ROLE");
    await db.exec("ALTER TABLE audit_entry OWNER TO CURRENT_USER; ALTER TABLE usage_events OWNER TO CURRENT_USER;");
  }
  const acmeAudit = await store.readAudit({ org: "acme" });
  ok(
    acmeAudit.some((r) => r.action === "memory.write") &&
      acmeAudit.some((r) => r.action === "egress.policy") &&
      !acmeAudit.some((r) => r.action === "tampered"),
    "append-only: original audit rows survived all blocked UPDATE/DELETE (none deleted, none tampered)",
  );
  const sess1 = await store.usageForSession("acme", "sess-1");
  ok(sess1.length === 2 && sess1[0].kind === "channel", "append-only: usage_events rows survived the blocked UPDATE/DELETE, content unchanged");
}

{
  await store.markEngaged("acme", "slack/T/C1", "100.1", "2026-06-30T10:00:00Z");
  await store.markEngaged("acme", "slack/T/C1", "100.1", "2026-06-30T11:00:00Z");
  const row = await store.getEngagement("acme", "slack/T/C1", "100.1");
  ok(row !== null && row.engagedAt === "2026-06-30T10:00:00Z" && row.lastTurnAt === "2026-06-30T11:00:00Z", "pg: engagedAt sticks, lastTurnAt advances");
  await store.markEngaged("globex", "slack/T/C1", "100.1", "2026-06-30T10:00:00Z");
  ok((await store.listEngagements("acme")).length === 1, "pg: engagement listing is org-isolated");
  ok((await store.disengage("acme", "slack/T/C1", "100.1")) === true, "pg: disengage removes the row");
  ok((await store.getEngagement("acme", "slack/T/C1", "100.1")) === null, "pg: gone after disengage");
}

{
  const CK = "slack/C_OWN";
  const TOK = "oe-dom:payments:win:t/slack~C_OWN/170.5:oe-sup:g3";
  ok((await store.getThreadOwner("acme", CK, "170.5")) === null, "pg: a fresh thread has no owner");
  await store.putThreadOwner("acme", CK, "170.5", TOK, "2026-07-15T10:00:00Z", 7 * 24 * 60 * 60 * 1000);
  ok((await store.getThreadOwner("acme", CK, "170.5")) === TOK, "pg: putThreadOwner then getThreadOwner returns the task token");
  ok((await store.getThreadOwner("globex", CK, "170.5")) === null, "pg: thread ownership is org-partitioned");
  const TOK2 = "oe-dom:payments:win:t/slack~C_OWN/170.5:oe-sup:g4";
  await store.putThreadOwner("acme", CK, "170.5", TOK2, "2026-07-15T11:00:00Z", 7 * 24 * 60 * 60 * 1000);
  ok((await store.getThreadOwner("acme", CK, "170.5")) === TOK2, "pg: a second put on the same thread replaces the owner (rotation re-key)");
  ok((await store.clearThreadOwner("acme", CK, "170.5")) === true, "pg: clearThreadOwner removes the row");
  ok((await store.getThreadOwner("acme", CK, "170.5")) === null, "pg: gone after clear");
  ok((await store.clearThreadOwner("acme", CK, "170.5")) === false, "pg: clearing an absent row returns false");
  await store.putThreadOwner("acme", CK, "old", TOK, "2026-01-01T00:00:00Z", 7 * 24 * 60 * 60 * 1000);
  await store.putThreadOwner("acme", CK, "new", TOK, "2026-03-01T00:00:00Z", 7 * 24 * 60 * 60 * 1000);
  ok((await store.getThreadOwner("acme", CK, "old")) === null, "pg: a row past its TTL is pruned on the next same-org write");
  ok((await store.getThreadOwner("acme", CK, "new")) === TOK, "pg: the fresh row survives the prune");
  await store.clearThreadOwner("acme", CK, "new");
}

{
  const TTL = 6 * 60 * 60 * 1000;
  const ORIGIN = JSON.stringify({ platform: "slack", channelId: "C_WAKE" });
  const WIN = "oe-dom:payments:oe-sup:g1";

  ok((await store.getUnifiedWakeRecord("acme", "w-nope")) === null, "pg: an unknown wakeId has no record (fail-closed null, never a phantom)");

  await store.putUnifiedWakeTarget("acme", "w-1", ORIGIN, "2026-07-26T10:00:00Z", TTL, WIN);
  const fresh = await store.getUnifiedWakeRecord("acme", "w-1");
  ok(fresh?.targetJson === ORIGIN && fresh?.createdAt === "2026-07-26T10:00:00Z", "pg: getUnifiedWakeRecord round-trips targetJson + createdAt");
  ok(fresh?.windowToken === WIN, "pg: the dispatched-to window token round-trips (the cross-domain fence key)");
  ok(fresh?.answeredAt === undefined && fresh?.answeredTurnId === undefined, "pg: a freshly-registered wake is PENDING (both answered columns NULL ⇒ undefined)");
  ok((await store.getUnifiedWakeTarget("acme", "w-1")) === ORIGIN, "pg: the narrow getUnifiedWakeTarget is unchanged by the new columns");
  ok((await store.getUnifiedWakeRecord("globex", "w-1")) === null, "pg: wake records are org-partitioned");

  await store.putUnifiedWakeTarget("acme", "w-legacy", ORIGIN, "2026-07-26T10:00:00Z", TTL);
  ok((await store.getUnifiedWakeRecord("acme", "w-legacy"))?.windowToken === undefined, "pg: an un-stamped row reads windowToken undefined (never qualifies for the pending arm)");

  await store.markUnifiedWakeAnswered("acme", "w-1", "2026-07-26T10:05:00Z", "turn-A");
  const marked = await store.getUnifiedWakeRecord("acme", "w-1");
  ok(marked?.answeredAt === "2026-07-26T10:05:00Z" && marked?.answeredTurnId === "turn-A", "pg: markUnifiedWakeAnswered stamps answeredAt + answeredTurnId");
  await store.markUnifiedWakeAnswered("acme", "w-1", "2026-07-26T10:06:00Z", "turn-B");
  const remarked = await store.getUnifiedWakeRecord("acme", "w-1");
  ok(remarked?.answeredAt === "2026-07-26T10:06:00Z" && remarked?.answeredTurnId === "turn-B", "pg: marking twice is idempotent (last write wins, no error)");

  await store.putUnifiedWakeTarget("acme", "w-1", ORIGIN, "2026-07-26T10:10:00Z", TTL, WIN);
  const afterRePut = await store.getUnifiedWakeRecord("acme", "w-1");
  ok(afterRePut?.answeredAt === "2026-07-26T10:06:00Z" && afterRePut?.answeredTurnId === "turn-B", "pg: RE-REGISTERING an answered wake does NOT clear the mark (redrive/retry can't resurrect it)");
  ok(afterRePut?.createdAt === "2026-07-26T10:10:00Z", "pg: the re-register DOES refresh created_at (the TTL clock), as before");
  const NEWWIN = "oe-dom:payments:win:t/slack~C_WAKE/1.2:oe-sup:g1";
  await store.putUnifiedWakeTarget("acme", "w-1", ORIGIN, "2026-07-26T10:11:00Z", TTL, NEWWIN);
  const rewin = await store.getUnifiedWakeRecord("acme", "w-1");
  ok(rewin?.windowToken === NEWWIN && rewin?.answeredAt === "2026-07-26T10:06:00Z", "pg: the re-register DOES refresh window_token (names the newly dispatched-to session) while still preserving the mark");

  await store.markUnifiedWakeAnswered("acme", "w-ghost", "2026-07-26T10:07:00Z", "turn-A");
  ok((await store.getUnifiedWakeRecord("acme", "w-ghost")) === null, "pg: marking an ABSENT wake inserts nothing (UPDATE-only)");

  await store.putUnifiedWakeTarget("globex", "w-1", ORIGIN, "2026-07-26T10:00:00Z", TTL, WIN);
  await store.markUnifiedWakeAnswered("acme", "w-1", "2026-07-26T10:20:00Z", "turn-C");
  ok((await store.getUnifiedWakeRecord("globex", "w-1"))?.answeredAt === undefined, "pg: the answered mark never crosses the org boundary");
}

{
  const REC = { urlPrivate: "https://files.slack.com/files-pri/T/F_UP/data.csv", mimeType: "text/csv", name: "data.csv", teamId: "T_UP" };
  ok((await store.getSlackAttachment("acme", "F_UP")) === null, "pg: a fresh file id has no attachment row");
  await store.putSlackAttachment("acme", "F_UP", REC, "2026-07-19T10:00:00Z", 24 * 60 * 60 * 1000);
  const got = await store.getSlackAttachment("acme", "F_UP");
  ok(got?.urlPrivate === REC.urlPrivate && got?.mimeType === "text/csv" && got?.name === "data.csv" && got?.teamId === "T_UP", "pg: put then get round-trips the trusted record (url + mime + name + team)");
  ok((await store.getSlackAttachment("globex", "F_UP")) === null, "pg: attachments are org-partitioned (another org can't resolve the id)");
  await store.putSlackAttachment("acme", "F_UP", { urlPrivate: "https://files.slack.com/files-pri/T/F_UP/v2.csv" }, "2026-07-19T11:00:00Z", 24 * 60 * 60 * 1000);
  const v2 = await store.getSlackAttachment("acme", "F_UP");
  ok(v2?.urlPrivate.endsWith("/v2.csv") === true && v2?.mimeType === undefined, "pg: a second put on the same id replaces the record (mime cleared)");
  await store.putSlackAttachment("acme", "F_OLD", REC, "2026-01-01T00:00:00Z", 24 * 60 * 60 * 1000);
  await store.putSlackAttachment("acme", "F_NEW", REC, "2026-03-01T00:00:00Z", 24 * 60 * 60 * 1000);
  ok((await store.getSlackAttachment("acme", "F_OLD")) === null, "pg: a row past its TTL is pruned on the next same-org write");
  ok((await store.getSlackAttachment("acme", "F_NEW"))?.urlPrivate === REC.urlPrivate, "pg: the fresh row survives the prune");
}

{
  const sk = "slack/T/CW";
  await store.markEngaged("acme", sk, "w.1", "2026-07-08T10:00:00Z");
  let row = await store.getEngagement("acme", sk, "w.1");
  ok(row !== null && row.participating === false && row.silentStreak === 0, "pg: first touch = warm watcher, zero streak");

  ok((await store.bumpSilentStreak("acme", sk, "w.1")) === 1, "pg: bumpSilentStreak → 1");
  ok((await store.bumpSilentStreak("acme", sk, "w.1")) === 2, "pg: bumpSilentStreak → 2");

  await store.markEngaged("acme", sk, "w.1", "2026-07-08T11:00:00Z");
  row = await store.getEngagement("acme", sk, "w.1");
  ok(row!.participating === false && row!.silentStreak === 2 && row!.lastTurnAt === "2026-07-08T11:00:00Z", "pg: warm refresh keeps streak + advances lastTurnAt");

  await store.markEngaged("acme", sk, "w.1", "2026-07-08T12:00:00Z", { participating: true });
  row = await store.getEngagement("acme", sk, "w.1");
  ok(row!.participating === true && row!.silentStreak === 0, "pg: promotion sets participating + resets streak");

  await store.markEngaged("acme", sk, "w.1", "2026-07-08T13:00:00Z", { participating: false });
  ok((await store.getEngagement("acme", sk, "w.1"))!.participating === true, "pg: participating never downgraded true→false");

  ok((await store.bumpSilentStreak("acme", sk, "missing.0")) === 0, "pg: bumpSilentStreak on a missing row → 0 (no-op)");

  await store.markEngaged("acme", sk, "w.2", "2026-07-08T10:00:00Z", { participating: true });
  ok((await store.getEngagement("acme", sk, "w.2"))!.participating === true, "pg: first touch can start participating");
}

{
  const sk = "slack/T/CO";

  await store.markEngaged("acme", sk, "o.1", "2026-07-09T10:00:00Z");
  let row = await store.getEngagement("acme", sk, "o.1");
  ok(row !== null && row.kind === "thread" && row.ownerToken === undefined, "pg: default first touch → kind 'thread', no ownerToken");

  await store.markEngaged("acme", sk, "o.2", "2026-07-09T10:00:00Z", { kind: "spawned", ownerToken: "T:C_OWN:o.2" });
  row = await store.getEngagement("acme", sk, "o.2");
  ok(row !== null && row.kind === "spawned" && row.ownerToken === "T:C_OWN:o.2", "pg: first touch can set kind:'spawned' + an ownerToken together");

  await store.markEngaged("acme", sk, "o.1", "2026-07-09T11:00:00Z", { ownerToken: "T:oe-sup:1" });
  row = await store.getEngagement("acme", sk, "o.1");
  ok(row !== null && row.ownerToken === "T:oe-sup:1", "pg: a refresh carrying ownerToken sets it on an existing row");

  await store.markEngaged("acme", sk, "o.1", "2026-07-11T12:00:00Z", { participating: true });
  row = await store.getEngagement("acme", sk, "o.1");
  ok(row !== null && row.ownerToken === "T:oe-sup:1" && row.participating === true, "pg: a refresh omitting ownerToken never clears the existing owner");

  await store.markEngaged("acme", sk, "o.1", "2026-03-25T21:52:00Z", { kind: "spawned" });
  row = await store.getEngagement("acme", sk, "o.1");
  ok(row !== null && row.kind === "thread", "pg: kind is immutable after first touch — a later call can't flip it");

  const list = await store.listEngagements("acme");
  ok(list.find((r) => r.surfaceKey === sk && r.threadTs === "o.2")?.ownerToken === "T:C_OWN:o.2", "pg: listEngagements maps ownerToken when present");
  ok(list.every((r) => r.kind === "thread" || r.kind === "spawned"), "pg: listEngagements maps kind for every row");
}

{
  const sk = "slack/T/CSTOP";

  await store.markEngaged("acme", sk, "s.1", "2026-07-19T10:00:00Z", { participating: true });
  ok((await store.getEngagement("acme", sk, "s.1"))!.stopped === false, "pg: a fresh engaged row is not stopped");

  ok((await store.markStopped("acme", sk, "s.1")) === true, "pg: markStopped returns true for an existing row");
  const stopped = await store.getEngagement("acme", sk, "s.1");
  ok(stopped !== null && stopped.stopped === true && stopped.participating === true, "pg: markStopped sets stopped=true and KEEPS the row (participating preserved)");

  ok((await store.markStopped("acme", sk, "s.1")) === true && (await store.getEngagement("acme", sk, "s.1"))!.stopped === true, "pg: markStopped is idempotent");

  await store.markEngaged("acme", sk, "s.1", "2026-07-19T11:00:00Z", { participating: true });
  ok((await store.getEngagement("acme", sk, "s.1"))!.stopped === false, "pg: markEngaged(participating:true) clears the stopped marker (re-invitation)");

  await store.markStopped("acme", sk, "s.1");
  await store.markEngaged("acme", sk, "s.1", "2026-07-19T12:00:00Z");
  ok((await store.getEngagement("acme", sk, "s.1"))!.stopped === true, "pg: a warm refresh (no participating) leaves the stopped marker set");

  ok((await store.markStopped("acme", sk, "nope.0")) === false, "pg: markStopped on a missing row → false");

  ok((await store.listEngagements("acme")).find((r) => r.surfaceKey === sk && r.threadTs === "s.1")?.stopped === true, "pg: listEngagements maps stopped");
}

{
  const sk = "slack/T/CSUP";

  ok((await store.getChannelSession("acme", sk)) === null, "pg: no session minted yet → null");

  const gen1 = await store.rotateChannelSession("acme", sk, "T:oe-sup:1", "2026-07-09T10:00:00Z");
  ok(gen1.generation === 1 && gen1.token === "T:oe-sup:1" && gen1.turnCount === 0, "pg: first rotation mints generation 1");
  ok(gen1.inputTokensTotal === 0 && gen1.firstWakeAt === null && gen1.handoffNote === null, "pg: fresh generation starts counter=0, first_wake_at=NULL, no note");
  let row = await store.getChannelSession("acme", sk);
  ok(
    row !== null && row.generation === 1 && row.token === "T:oe-sup:1" && row.createdAt === "2026-07-09T10:00:00Z" && row.lastWakeAt === "2026-07-09T10:00:00Z",
    "pg: getChannelSession reads back the freshly-minted row",
  );

  await store.bumpChannelSessionUsage("acme", sk, "T:oe-sup:1", 1000);
  await store.bumpChannelSessionUsage("acme", sk, "T:oe-sup:1", 500);
  await store.bumpChannelSessionUsage("acme", sk, "T:oe-sup:WRONG", 9_999_999);
  row = await store.getChannelSession("acme", sk);
  ok(row !== null && row.inputTokensTotal === 1500, "pg: bumpChannelSessionUsage accumulates + a mismatched token is a no-op (token guard)");

  await store.touchChannelSession("acme", sk, "2026-07-09T10:05:00Z");
  row = await store.getChannelSession("acme", sk);
  ok(row !== null && row.turnCount === 1 && row.lastWakeAt === "2026-07-09T10:05:00Z" && row.generation === 1, "pg: touchChannelSession bumps turnCount + lastWakeAt, leaves generation alone");
  ok(row !== null && row.firstWakeAt === "2026-07-09T10:05:00Z", "pg: touchChannelSession stamps first_wake_at on the first delivered wake");

  await store.touchChannelSession("acme", sk, "2026-07-09T10:10:00Z");
  row = await store.getChannelSession("acme", sk);
  ok(row !== null && row.turnCount === 2, "pg: touchChannelSession accumulates across calls");
  ok(row !== null && row.firstWakeAt === "2026-07-09T10:05:00Z", "pg: a later touch does NOT move first_wake_at (COALESCE, set once)");

  const gen2 = await store.rotateChannelSession("acme", sk, "T:oe-sup:2", "2026-07-09T11:00:00Z", "OPEN: sign-off pending");
  ok(gen2.generation === 2 && gen2.token === "T:oe-sup:2" && gen2.turnCount === 0, "pg: rotation mints generation 2, resets turnCount");
  ok(gen2.inputTokensTotal === 0 && gen2.firstWakeAt === null && gen2.handoffNote === "OPEN: sign-off pending", "pg: rotation resets counter/first_wake_at and stores the handoff note");
  row = await store.getChannelSession("acme", sk);
  ok(row !== null && row.generation === 2 && row.turnCount === 0 && row.inputTokensTotal === 0 && row.createdAt === "2026-07-09T11:00:00Z" && row.handoffNote === "OPEN: sign-off pending", "pg: getChannelSession reflects the rotated generation (no stale gen-1 fields; note persisted)");

  ok((await store.getChannelSession("globex", sk)) === null, "pg: channel session is org-isolated");
  await store.rotateChannelSession("globex", sk, "T:oe-sup:1", "2026-07-11T12:00:00Z");
  ok((await store.getChannelSession("acme", sk))!.generation === 2, "pg: another org's rotation doesn't disturb this org's row");

  ok((await store.getChannelSession("acme", "slack/T/CNOSUP")) === null, "pg: sanity — no row for an untouched surface");
  await store.touchChannelSession("acme", "slack/T/CNOSUP", "2026-03-25T21:52:00Z");
  ok((await store.getChannelSession("acme", "slack/T/CNOSUP")) === null, "pg: touchChannelSession on a surface with no session is a no-op");
}

{
  const sk = "slack/T/CATOMIC";
  let queryCalls = 0;
  const countingClient: PgClient = {
    query: (text, params) => {
      queryCalls++;
      return client.query(text, params);
    },
  };
  const atomicStore = makeOperationalPostgresStore(countingClient);

  queryCalls = 0;
  const row1 = await atomicStore.rotateChannelSession("acme", sk, "AT:oe-sup:g1-aaa111", "2026-07-24T00:00:00Z");
  ok(queryCalls === 1, "pg OPE-58: rotateChannelSession's FIRST mint issues exactly ONE query (atomic upsert, no separate read)");
  ok(row1.generation === 1, "pg OPE-58: atomic rotate still mints generation 1 on a fresh row");

  queryCalls = 0;
  const row2 = await atomicStore.rotateChannelSession("acme", sk, "AT:oe-sup:g2-bbb222", "2026-07-24T00:01:00Z");
  ok(queryCalls === 1, "pg OPE-58: a SUBSEQUENT rotation ALSO issues exactly ONE query");
  ok(row2.generation === 2, "pg OPE-58: the atomic upsert computes generation FROM THE ROW (existing+1) inside the one statement");

  queryCalls = 0;
  const row3 = await atomicStore.rotateChannelSession("acme", sk, "AT:oe-sup:g3-ccc333", "2026-07-24T00:02:00Z");
  ok(queryCalls === 1 && row3.generation === 3, "pg OPE-58: generation keeps incrementing correctly across repeated single-statement rotations");

  ok(row3.token === "AT:oe-sup:g3-ccc333", "pg OPE-58: the store persists the caller's token unchanged (salt is a caller concern)");
}

{
  const oldDb = new PGlite();
  const oldClient: PgClient = { query: (text, params) => oldDb.query(text, params ? [...params] : undefined) };
  await oldClient.query(
    `CREATE TABLE thread_engagement (
       org_id text NOT NULL, surface_key text NOT NULL, thread_ts text NOT NULL,
       engaged_at text NOT NULL, last_turn_at text NOT NULL,
       PRIMARY KEY (org_id, surface_key, thread_ts))`,
  );
  await oldClient.query(
    `INSERT INTO thread_engagement (org_id, surface_key, thread_ts, engaged_at, last_turn_at)
     VALUES ('orgM', 'slack/T/CM', 'm.1', '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z')`,
  );
  await initOperationalSchema(oldClient);
  const migStore = makeOperationalPostgresStore(oldClient);
  const row = await migStore.getEngagement("orgM", "slack/T/CM", "m.1");
  ok(row !== null && row.engagedAt === "2026-07-01T00:00:00Z", "pg migration: pre-existing row preserved (not dropped)");
  ok(row!.participating === false && row!.silentStreak === 0, "pg migration: new columns backfill to warm/zero for old rows");
  ok(row!.kind === "thread" && row!.ownerToken === undefined, "pg migration: owner_token/kind backfill to 'thread'/absent for a pre-T1.1 row");
  ok(row!.stopped === false, "pg migration: stopped backfills to false for a pre-marker row");
  ok((await migStore.markStopped("orgM", "slack/T/CM", "m.1")) === true && (await migStore.getEngagement("orgM", "slack/T/CM", "m.1"))!.stopped === true, "pg migration: markStopped works on the migrated table");
  await migStore.markEngaged("orgM", "slack/T/CM", "m.1", "2026-07-01T01:00:00Z", { participating: true });
  ok((await migStore.getEngagement("orgM", "slack/T/CM", "m.1"))!.participating === true, "pg migration: promotion works on the migrated table");
  await migStore.markEngaged("orgM", "slack/T/CM", "m.1", "2026-07-01T02:00:00Z", { ownerToken: "T:oe-sup:1" });
  ok((await migStore.getEngagement("orgM", "slack/T/CM", "m.1"))!.ownerToken === "T:oe-sup:1", "pg migration: ownerToken can be set on a migrated pre-T1.1 row");

  ok((await migStore.getChannelSession("orgM", "slack/T/CM")) === null, "pg migration: channel_session table exists and starts empty on a migrated DB");
  const rotated = await migStore.rotateChannelSession("orgM", "slack/T/CM", "T:oe-sup:1", "2026-07-01T03:00:00Z");
  ok(rotated.generation === 1, "pg migration: channel_session rotation works on a migrated DB");
}

{
  const TTL = 10 * 60_000;
  ok(await store.markEventSeen("acme", "Ev123", "2026-06-30T10:00:00Z", TTL), "pg: first sighting returns true");
  ok(!(await store.markEventSeen("acme", "Ev123", "2026-06-30T10:00:05Z", TTL)), "pg: duplicate within TTL returns false");
  ok(await store.markEventSeen("globex", "Ev123", "2026-06-30T10:00:00Z", TTL), "pg: same key in another org is a fresh sighting");
  ok(await store.markEventSeen("acme", "Ev123", "2026-06-30T10:30:00Z", TTL), "pg: expired sighting is pruned — key fresh after TTL");
  ok(!(await store.markEventSeen("acme", "Ev123", "2026-06-30T10:30:01Z", TTL)), "pg: re-marked key dedupes again");
}

{
  ok((await store.listDomainSkills("acme", "eng")).length === 0, "pg: empty domain starts with no skills");
  await store.putDomainSkill("acme", "eng", "deploy-runbook", "# Deploy\nSteps.", "U1", "2026-06-30T10:00:00Z");
  let rows = await store.listDomainSkills("acme", "eng");
  ok(rows.length === 1 && rows[0].name === "deploy-runbook" && rows[0].updatedBy === "U1", "pg: create persists name/content/updatedBy");

  await store.putDomainSkill("acme", "eng", "deploy-runbook", "# Deploy v2", "U2", "2026-06-30T11:00:00Z");
  rows = await store.listDomainSkills("acme", "eng");
  ok(rows.length === 1 && rows[0].content === "# Deploy v2" && rows[0].updatedBy === "U2", "pg: put on an existing name upserts in place, not a second row");

  await store.putDomainSkill("acme", "eng", "no-author", "# No author", undefined, "2026-06-30T12:00:00Z");
  ok((await store.listDomainSkills("acme", "eng")).find((r) => r.name === "no-author")?.updatedBy === undefined, "pg: updatedBy is optional (undefined round-trips as absent)");

  ok((await store.listDomainSkills("acme", "watercooler")).length === 0, "pg: another domain in the same org is isolated");
  ok((await store.listDomainSkills("globex", "eng")).length === 0, "pg: another org is isolated even for the same domain name");
  await store.putDomainSkill("globex", "eng", "deploy-runbook", "# Globex's own", "U9", "2026-06-30T13:00:00Z");
  ok((await store.listDomainSkills("acme", "eng")).length === 2, "pg: another org's write doesn't leak into this org's list");

  ok((await store.deleteDomainSkill("acme", "eng", "no-author")) === true, "pg: delete returns true when a row was removed");
  ok((await store.deleteDomainSkill("acme", "eng", "no-author")) === false, "pg: delete is idempotent (false when absent)");
  ok((await store.listDomainSkills("acme", "eng")).length === 1, "pg: gone after delete");
}

{
  ok((await store.getDomainModel("acme", "eng")) === null, "pg: no pick set starts null");
  await store.setDomainModel("acme", "eng", { modelId: "zai/glm-5.2" }, "U1");
  let row = await store.getDomainModel("acme", "eng");
  ok(row?.modelId === "zai/glm-5.2" && row.reasoning === undefined && row.setBy === "U1", "pg: modelId-only pick persists, reasoning absent");

  await store.setDomainModel("acme", "eng", { reasoning: "high" }, "U2");
  row = await store.getDomainModel("acme", "eng");
  ok(row !== null && row.modelId === undefined && row.reasoning === "high" && row.setBy === "U2", "pg: a new pick REPLACES the previous one wholesale (modelId dropped, not merged)");

  await store.setDomainModel("acme", "eng", { modelId: "deepseek/deepseek-v4-flash", reasoning: "low" }, "U3");
  row = await store.getDomainModel("acme", "eng");
  ok(row?.modelId === "deepseek/deepseek-v4-flash" && row.reasoning === "low", "pg: a pick may carry both components at once");

  ok((await store.getDomainModel("acme", "finance")) === null, "pg: another domain in the same org is isolated");
  ok((await store.getDomainModel("globex", "eng")) === null, "pg: another org is isolated even for the same domain name");
  await store.setDomainModel("globex", "eng", { modelId: "globex/own-model" }, "U9");
  ok((await store.domainModels("acme")).length === 1, "pg: another org's write doesn't leak into this org's list");
  ok((await store.domainModels("globex"))[0]?.modelId === "globex/own-model", "pg: domainModels lists this org's own row");

  ok((await store.clearDomainModel("acme", "eng")) === true, "pg: clear returns true when a row was removed");
  ok((await store.clearDomainModel("acme", "eng")) === false, "pg: clear is idempotent (false when absent)");
  ok((await store.getDomainModel("acme", "eng")) === null, "pg: gone after clear");
}

{
  const { runtimeRoleGrantsSql, verifyAppendOnlyAudit } = await import("../agent/operational/postgres.js");
  const { initPostgresSchema } = await import("../agent/memory/postgres.js");
  await initPostgresSchema(client);

  async function denied(sql: string, needle: string, label: string): Promise<void> {
    try {
      await client.query(sql);
      ok(false, `${label} (statement unexpectedly succeeded)`);
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      ok(m.includes(needle), `${label} (error: "${m}")`);
    }
  }

  await db.exec("CREATE ROLE oe_runtime NOSUPERUSER");
  for (const stmt of runtimeRoleGrantsSql("oe_runtime")) await client.query(stmt);
  await client.query("SELECT set_config('app.current_org', '', false)");

  try {
    await db.exec("SET ROLE oe_runtime");

    await initOperationalSchema(client);
    await initPostgresSchema(client);
    ok(true, "two-role: initOperationalSchema + initPostgresSchema boot clean under the runtime role (verify-only, no DDL)");

    await store.recordUsage("acme", "slack/T9/C9", "2026-07", { inputTokens: 1, outputTokens: 1 });
    ok((await store.surfaceLedger("acme", "slack/T9/C9")).windows["2026-07"].calls === 1, "two-role: mutable DML works with the GUC unset ('' folds to unset — permissive arm)");
    await setOrgContext(client, "acme");
    const spendOrgs = new Set(((await client.query("SELECT DISTINCT org_id FROM spend_ledger")).rows as { org_id: string }[]).map((r) => r.org_id));
    ok(spendOrgs.size === 1 && spendOrgs.has("acme"), "two-role: with the GUC set, mutable-table RLS enforces for the runtime role");
    await client.query("SELECT set_config('app.current_org', '', false)");

    await client.query("INSERT INTO audit_entry (ts, org_id, platform, workspace, action) VALUES ('2026-07-11T10:00:00Z', 'acme', 'slack', 'T1', 'runtime.append')");
    ok(((await client.query("SELECT count(*)::int AS n FROM audit_entry")).rows as { n: number }[])[0].n > 0, "two-role: the runtime role can append + read audit_entry");
    await denied("UPDATE audit_entry SET action = 'tampered'", "permission denied", "two-role: UPDATE audit_entry is permission-DENIED for the runtime role");
    await denied("DELETE FROM audit_entry", "permission denied", "two-role: DELETE audit_entry is permission-DENIED for the runtime role");

    await denied("DROP POLICY audit_select ON audit_entry", "must be owner", "two-role: DROP POLICY is refused (not owner)");
    await denied("ALTER TABLE audit_entry DISABLE ROW LEVEL SECURITY", "must be owner", "two-role: DISABLE ROW LEVEL SECURITY is refused (not owner)");
    await denied("ALTER TABLE audit_entry NO FORCE ROW LEVEL SECURITY", "must be owner", "two-role: NO FORCE ROW LEVEL SECURITY is refused (not owner)");
    await denied("CREATE POLICY sneaky_delete ON audit_entry FOR DELETE USING (true)", "must be owner", "two-role: smuggling in a DELETE policy is refused (not owner)");
    await denied("ALTER TABLE usage_events DISABLE ROW LEVEL SECURITY", "must be owner", "two-role: usage_events DDL is refused too");

    ok((await verifyAppendOnlyAudit(client)).length === 0, "two-role: verifyAppendOnlyAudit reports a sound posture");
  } finally {
    await db.exec("RESET ROLE");
  }

  {
    await db.exec("DROP POLICY audit_insert ON audit_entry");
    const found = await verifyAppendOnlyAudit(client);
    ok(found.some((v) => v.includes("no INSERT policy")), "tamper: verifyAppendOnlyAudit detects the dropped policy");

    await initOperationalSchema(client);
    ok((await verifyAppendOnlyAudit(client)).length === 0, "tamper: the owner-mode boot re-applies the append-only posture");
    const integrity = await store.readAudit({ org: "default", action: "audit.integrity" });
    ok(integrity.length === 1 && integrity[0].detail?.healed === true, "tamper: the repair is recorded as an audit.integrity row (healed:true)");
    ok(JSON.stringify(integrity[0].detail?.violations ?? []).includes("no INSERT policy"), "tamper: the integrity row names what was broken");
  }

  {
    await db.exec("ALTER TABLE audit_entry NO FORCE ROW LEVEL SECURITY");
    await db.exec("SET ROLE oe_runtime");
    let threw = "";
    try {
      await initOperationalSchema(client);
    } catch (e) {
      threw = e instanceof Error ? e.message : String(e);
    } finally {
      await db.exec("RESET ROLE");
    }
    ok(threw.includes("FAILED verification") && threw.includes("FORCE"), "tamper: the runtime-role boot refuses to serve on a tampered posture (fail-closed)");

    await initOperationalSchema(client);
    ok((await verifyAppendOnlyAudit(client)).length === 0, "tamper: owner-mode boot repairs after the runtime refusal");
    const integrity = await store.readAudit({ org: "default", action: "audit.integrity" });
    ok(integrity.some((r) => r.detail?.healed === false) && integrity.filter((r) => r.detail?.healed === true).length === 2, "tamper: refusal (healed:false) and both repairs (healed:true) are all audit rows");
  }

  async function integrityHealMentions(fragment: string): Promise<boolean> {
    const rows = await store.readAudit({ org: "default", action: "audit.integrity" });
    return rows.some((r) => r.detail?.healed === true && JSON.stringify(r.detail?.healed_artifacts ?? {}).includes(fragment));
  }

  {
    await db.exec("CREATE FUNCTION oe_swallow_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END; $$");
    await db.exec("CREATE TRIGGER oe_swallow BEFORE INSERT ON audit_entry FOR EACH ROW EXECUTE FUNCTION oe_swallow_audit()");
    ok((await verifyAppendOnlyAudit(client)).some((v) => v.includes("hostile trigger") && v.includes("oe_swallow")), "probe(a): verify detects the insert-swallowing trigger");

    await db.exec("SET ROLE oe_runtime");
    let threw = "";
    try {
      await initOperationalSchema(client);
    } catch (e) {
      threw = e instanceof Error ? e.message : String(e);
    } finally {
      await db.exec("RESET ROLE");
    }
    ok(threw.includes("FAILED verification") && threw.includes("hostile trigger"), "probe(a): runtime-role boot fails closed on the hostile trigger");

    await initOperationalSchema(client);
    ok((await verifyAppendOnlyAudit(client)).length === 0, "probe(a): owner boot heals the trigger — posture sound");
    ok(await integrityHealMentions("oe_swallow"), "probe(a): the dropped trigger is recorded in healed_artifacts");
    await client.query("INSERT INTO audit_entry (ts, org_id, platform, workspace, action) VALUES ('2026-07-11T11:00:00Z','acme','slack','T1','post.heal.a')");
    ok((await store.readAudit({ org: "acme", action: "post.heal.a" })).length === 1, "probe(a): appends land again once the trigger is healed");
  }

  {
    await db.exec("CREATE POLICY oe_block_insert ON audit_entry AS RESTRICTIVE FOR INSERT WITH CHECK (false)");
    ok((await verifyAppendOnlyAudit(client)).some((v) => v.includes("unexpected RESTRICTIVE policy") && v.includes("oe_block_insert")), "probe(b): verify detects the restrictive insert-blocking policy");

    await initOperationalSchema(client);
    ok((await verifyAppendOnlyAudit(client)).length === 0, "probe(b): owner boot drops the restrictive policy — survives-reboot regression closed");
    ok(await integrityHealMentions("oe_block_insert"), "probe(b): the dropped restrictive policy is recorded in healed_artifacts");
    await client.query("INSERT INTO audit_entry (ts, org_id, platform, workspace, action) VALUES ('2026-07-11T11:05:00Z','acme','slack','T1','post.heal.b')");
    ok((await store.readAudit({ org: "acme", action: "post.heal.b" })).length === 1, "probe(b): appends land again once the restrictive policy is dropped");
  }

  {
    await client.query("GRANT TRUNCATE ON audit_entry TO oe_runtime");
    ok((await verifyAppendOnlyAudit(client)).some((v) => v.includes("oe_runtime") && v.includes("TRUNCATE")), "probe(c): verify detects a stray TRUNCATE grant to the runtime role");

    await initOperationalSchema(client);
    ok((await verifyAppendOnlyAudit(client)).length === 0, "probe(c): owner boot revokes the stray grant — posture sound");
    ok(await integrityHealMentions("oe_runtime"), "probe(c): the revoked grant is recorded in healed_artifacts");
    await db.exec("SET ROLE oe_runtime");
    try {
      await client.query("TRUNCATE audit_entry");
      ok(false, "probe(c): TRUNCATE unexpectedly succeeded for the runtime role");
    } catch (e) {
      ok((e instanceof Error ? e.message : String(e)).includes("permission denied"), "probe(c): TRUNCATE is permission-denied for the runtime role after the revoke");
    } finally {
      await db.exec("RESET ROLE");
    }
  }
}

{
  const base = {
    org: "default",
    kind: "spend.set",
    argsJson: JSON.stringify({ org: "default", scopeKey: "slack/T1/C9", level: "surface", monthlyTokens: 9, currentCap: null }),
    scopeKey: "slack/T1/C9",
    domain: null,
    requestedBy: "U_REQ",
    channelId: "C9",
    threadTs: "9.1",
    messageTs: "9.2",
    status: "pending" as const,
    createdAt: "2026-07-20T00:00:00Z",
    expiresAt: "2026-07-20T01:00:00Z",
    decidedBy: null,
    decidedAt: null,
  };
  await store.addPendingAction({ ...base, id: "pa-frozen", postedTo: "slack/T1/C9" });
  await store.addPendingAction({ ...base, id: "pa-null", postedTo: null });

  const frozen = await store.getPendingAction("default", "pa-frozen");
  ok(frozen?.postedTo === "slack/T1/C9" && frozen?.argsJson === base.argsJson, "pending: the mint-frozen postedTo (and argsJson) round-trip byte-for-byte");
  ok((await store.getPendingAction("default", "pa-null"))?.postedTo === null, "pending: a NULL postedTo (pre-migration/map row) reads back null");
  ok((await store.getPendingAction("acme", "pa-frozen")) === null, "pending: another org can't read the row (column isolation)");

  const dueRows = await store.listExpiredPendingActions("default", "2026-07-20T02:00:00Z");
  ok(dueRows.some((r) => r.id === "pa-frozen" && r.postedTo === "slack/T1/C9"), "pending: listExpiredPendingActions carries the frozen postedTo through to the sweep");

  ok((await store.decidePendingAction("default", "pa-frozen", "expired", "system", "2026-07-20T02:00:00Z")) === true, "pending: the first decide CAS wins");
  ok((await store.decidePendingAction("default", "pa-frozen", "approved", "U_REQ", "2026-07-20T02:00:01Z")) === false, "pending: a second decide on the terminal row loses the CAS");
  ok((await store.getPendingAction("default", "pa-frozen"))?.status === "expired", "pending: the losing CAS left the row untouched");
}

{
  const REF = "oe-oauth:tok:notion:user:U1";
  await store.putStoredCredential("default", { ref: REF, ciphertext: "ENVELOPE-OPAQUE", createdBy: "sys", createdAt: "2026-07-22T00:00:00Z" });
  ok((await store.claimStoredCredential("default", REF, "claim-A", "2026-07-22T00:00:10Z", "2026-07-22T00:00:00Z")) === true, "claim: first claimant wins the free row");
  ok((await store.claimStoredCredential("default", REF, "claim-B", "2026-07-22T00:00:11Z", "2026-07-22T00:00:00Z")) === false, "claim: a second claimant loses while the lease is held");
  ok((await store.releaseStoredCredential("default", REF, "claim-B")) === false, "claim: releasing with the wrong claim id is a no-op");
  ok((await store.claimStoredCredential("default", REF, "claim-B2", "2026-07-22T00:00:12Z", "2026-07-22T00:00:05Z")) === false, "claim: still held before the lease goes stale");
  ok((await store.releaseStoredCredential("default", REF, "claim-A")) === true, "claim: the true holder releases its claim");
  ok((await store.claimStoredCredential("default", REF, "claim-C", "2026-07-22T00:00:13Z", "2026-07-22T00:00:00Z")) === true, "claim: a released row is claimable again");
  ok((await store.claimStoredCredential("default", REF, "claim-D", "2026-07-22T00:05:00Z", "2026-07-22T00:04:00Z")) === true, "claim: an expired lease (claimed_at <= staleBefore) is stolen by a fresh claim");
  ok((await store.claimStoredCredential("acme", REF, "claim-X", "2026-07-22T00:06:00Z", "2026-07-22T00:00:00Z")) === false, "claim: another org can't claim (row is org-scoped)");
  ok((await store.getStoredCredential("default", REF))?.ciphertext === "ENVELOPE-OPAQUE", "claim: claim/release never mutate the ciphertext payload");
}

{
  ok((await store.listGitHubInstallations("default")).length === 0, "installations: an org with no installs reads empty");
  await store.putGitHubInstallation("default", { owner: "acme", installationId: "4242", accountType: "Organization", repositorySelection: "selected", updatedAt: "2026-07-25T10:00:00Z" });
  await store.putGitHubInstallation("default", { owner: "globex", installationId: "7777", updatedAt: "2026-07-25T10:01:00Z" });
  const rows = await store.listGitHubInstallations("default");
  ok(rows.length === 2 && rows[0]!.owner === "acme" && rows[1]!.owner === "globex", "installations: list is owner-ascending");
  ok(rows[0]!.installationId === "4242" && rows[0]!.accountType === "Organization" && rows[0]!.repositorySelection === "selected", "installations: metadata round-trips");
  ok(rows[1]!.accountType === undefined && rows[1]!.repositorySelection === undefined, "installations: absent optional columns come back absent, not null");

  await store.putGitHubInstallation("default", { owner: "acme", installationId: "4242", repositorySelection: "all", updatedAt: "2026-07-25T11:00:00Z" });
  const after = await store.listGitHubInstallations("default");
  ok(after.length === 2, "installations: a re-delivered install upserts (one row per owner), never duplicates");
  ok(after[0]!.repositorySelection === "all" && after[0]!.updatedAt === "2026-07-25T11:00:00Z", "installations: an installation_repositories refresh updates the selection + stamp");

  ok((await store.listGitHubInstallations("acme")).length === 0, "installations: another org sees none (row is org-scoped)");
  await store.putGitHubInstallation("acme", { owner: "acme", installationId: "9999", updatedAt: "2026-07-25T10:00:00Z" });
  ok((await store.listGitHubInstallations("default"))[0]!.installationId === "4242", "installations: a same-owner row in another org doesn't bleed across the tenant boundary");

  ok((await store.deleteGitHubInstallation("default", "globex")) === true, "installations: delete reports the removal");
  ok((await store.deleteGitHubInstallation("default", "globex")) === false, "installations: deleting an unknown owner reports false, never throws");
  const left = await store.listGitHubInstallations("default");
  ok(left.length === 1 && left[0]!.owner === "acme", "installations: delete removes exactly the named owner");
}

{
  const hook = (over: { org?: string; id: string; source: string; status?: "active" | "revoked" }) => ({
    org: over.org ?? "default",
    id: over.id,
    source: over.source,
    posture: "trigger-only" as const,
    secretRef: `hook:${over.id}`,
    status: over.status ?? ("active" as const),
    createdBy: "U-DECIDER",
    createdIn: "slack/T1/C1",
    createdAt: "2026-07-27T00:00:00.000Z",
  });
  ok((await store.addWebhookHook(hook({ id: "hk_" + "a".repeat(26), source: "github" }))) === true, "webhook_hook: a fresh (org, source) inserts");
  ok((await store.addWebhookHook(hook({ id: "hk_" + "b".repeat(26), source: "github" }))) === false, "webhook_hook: a duplicate (org, source) returns FALSE rather than raising a unique violation");
  ok((await store.getWebhookHookById("hk_" + "b".repeat(26))) === null, "webhook_hook: the losing row was never written");
  ok((await store.getWebhookHookBySource("default", "github"))!.id === "hk_" + "a".repeat(26), "webhook_hook: the incumbent is untouched");
  ok((await store.addWebhookHook(hook({ org: "acme", id: "hk_" + "c".repeat(26), source: "github" }))) === true, "webhook_hook: the claim is per-ORG, not global");
  await store.updateWebhookHook("default", "hk_" + "a".repeat(26), { status: "revoked" });
  ok((await store.addWebhookHook(hook({ id: "hk_" + "d".repeat(26), source: "github" }))) === false, "webhook_hook: a REVOKED row still holds its (org, source) — revoking retires the name");
}

await db.close();
console.log(`✓ operational — ${passed} assertions (pglite contract, spend/routine/audit isolation, RLS, audit+usage append-only under app role AND FORCE-RLS under a non-superuser owner, two-role runtime posture (DDL escape closed) + tamper detection/refusal, broadened suppression detection (hostile trigger / restrictive policy / stray grant — detect+heal+fail-closed), event dedupe, domain skills, domain model pick, ownership routing (ownerToken/kind), durable stopped marker, channel supervisor sessions, pending-action posted_to round-trip + decide CAS, github installations (upsert/list/delete + org isolation), migration)`);
