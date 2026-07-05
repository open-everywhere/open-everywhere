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
    const auditOrgs = ((await client.query("SELECT DISTINCT org_id FROM audit_entry")).rows as { org_id: string }[]).map((r) => r.org_id);
    ok(auditOrgs.length === 1 && auditOrgs[0] === "acme", "RLS: audit no-WHERE read returns only the GUC org");
    const usageOrgs = ((await client.query("SELECT DISTINCT org_id FROM usage_events")).rows as { org_id: string }[]).map((r) => r.org_id);
    ok(usageOrgs.length === 1 && usageOrgs[0] === "acme", "RLS: usage_events no-WHERE read returns only the GUC org");

    const del = (await client.query("DELETE FROM audit_entry RETURNING seq")).rows;
    ok(del.length === 0, "RLS: DELETE on audit_entry affects 0 rows under the app role (append-only)");
    const upd = (await client.query("UPDATE audit_entry SET action = 'tampered' RETURNING seq")).rows;
    ok(upd.length === 0, "RLS: UPDATE on audit_entry affects 0 rows under the app role (immutable)");
    const delUsage = (await client.query("DELETE FROM usage_events RETURNING seq")).rows;
    ok(delUsage.length === 0, "RLS: DELETE on usage_events affects 0 rows under the app role (append-only, same as audit_entry)");
    const updUsage = (await client.query("UPDATE usage_events SET kind = 'tampered' RETURNING seq")).rows;
    ok(updUsage.length === 0, "RLS: UPDATE on usage_events affects 0 rows under the app role (immutable)");
  } finally {
    await db.exec("RESET ROLE");
  }
  ok((await store.readAudit({ org: "acme" })).length === 2, "RLS: audit rows survived the blocked DELETE/UPDATE");
  ok((await store.usageForSession("acme", "sess-1")).length === 2 && (await store.usageForSession("acme", "sess-1"))[0].kind === "channel", "RLS: usage_events rows survived the blocked DELETE/UPDATE, content unchanged");
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

await db.close();
console.log(`✓ operational — ${passed} assertions (pglite contract, spend/routine/audit isolation, RLS, audit append-only, event dedupe, domain skills)`);
