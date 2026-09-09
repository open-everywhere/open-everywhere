
import { readFileSync } from "node:fs";
import { initOperationalSchema, makeOperationalPostgresStore, setOrgContext, type PgClient } from "../agent/operational/postgres.js";
import { PROMOTER_LIST_MAX } from "../agent/operational/store.js";
import type { Routine } from "../agent/routines/routine.js";
import { openTestPg, closeAllTestPg } from "./test-pg-driver.js";
import {
  deploymentOrg,
  registeredDeploymentIdentity,
  _setDeploymentIdentityForTest,
} from "../agent/identity/deployment-identity.js";

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

const pg = await openTestPg();
const client: PgClient = pg.client;
await initOperationalSchema(client);
const store = makeOperationalPostgresStore(client);

{
  await store.recordSpend("default", { surfaceKey: "slack/T1/C1", principalId: "U1", model: "m-1", period: "2026-06", inputTokens: 100, outputTokens: 100, cacheReadTokens: 5, usdMicros: 150 });
  await store.recordSpend("default", { surfaceKey: "slack/T1/C1", principalId: "U1", model: "m-1", period: "2026-06", outputTokens: 50, usdMicros: 50 });
  await store.recordSpend("default", { surfaceKey: "slack/T1/C1", principalId: "U2", model: "m-1", period: "2026-06", inputTokens: 30, usdMicros: 10 });
  await store.recordSpend("default", { surfaceKey: "slack/T1/C2", period: "2026-06", inputTokens: 200 });

  const c1 = await store.spendTotals("default", { surfaceKey: "slack/T1/C1", period: "2026-06" });
  ok(c1.inputTokens === 130 && c1.outputTokens === 150 && c1.cacheReadTokens === 5 && c1.usdMicros === 210 && c1.calls === 3, "spend: totals sum atomically across writes + dimensions");
  const u1 = await store.spendTotals("default", { surfaceKey: "slack/T1/C1", principalId: "U1", period: "2026-06" });
  ok(u1.inputTokens === 100 && u1.usdMicros === 200 && u1.calls === 2, "spend: a principal filter isolates that principal's rows");
  ok((await store.spendTotals("default", { surfaceKey: "slack/T1/C1", period: "2026-07" })).calls === 0, "spend: other period is empty (zero totals)");
  const rows = await store.listSpendLedger("default");
  ok(rows.length === 3, "spend: one ledger row per (org, surface, principal, routine, model, period) key");
  const wsTotals = await store.spendTotals("default", { surfaceKeyPrefix: "slack/T1/", period: "2026-06" });
  ok(wsTotals.inputTokens === 330 && wsTotals.calls === 4, "spend: a surfaceKeyPrefix filter rolls up the workspace");
  ok((await store.spendTotals("default", { surfaceKey: "slack/T1/C", period: "2026-06" })).calls === 0, "spend: surfaceKey is an exact match, never a prefix");

  await store.recordSpend("acme", { surfaceKey: "slack/T1/C1", principalId: "U1", model: "m-1", period: "2026-06", inputTokens: 777 });
  ok((await store.spendTotals("default", { surfaceKey: "slack/T1/C1", period: "2026-06" })).inputTokens === 130, "spend: another org's usage doesn't bleed into this org");
  ok((await store.spendTotals("acme", { surfaceKey: "slack/T1/C1", period: "2026-06" })).inputTokens === 777, "spend: the other org has its own isolated ledger");

  {
    const key = { surfaceKey: "slack/T1/C_MEASURED", principalId: "U1", model: "m-1", period: "2026-06" } as const;
    await store.recordSpend("default", { ...key, inputTokens: 1000, usdMicros: 300, usdMicrosMeasured: 250, costSource: "measured" });
    await store.recordSpend("default", { ...key, inputTokens: 1000, usdMicros: 300, usdMicrosMeasured: 250, costSource: "measured" });
    await store.recordSpend("default", { ...key, inputTokens: 500, usdMicros: 150 });

    const measuredRows = (await store.listSpendLedger("default")).filter((r) => r.surfaceKey === "slack/T1/C_MEASURED");
    ok(measuredRows.length === 2, "🔴 OPE-369(pg): one key, two cost paths -> TWO rows — cost_source is part of the PK, so a measured call can never be summed into a derived bucket");
    const measured = measuredRows.find((r) => r.costSource === "measured");
    const derived = measuredRows.find((r) => r.costSource === "derived");
    ok(measured?.usdMicros === 600 && measured.usdMicrosMeasured === 500 && measured.calls === 2, "OPE-369(pg): the measured row upsert-and-adds BOTH money columns (derived shadow kept beside the gateway's own figure)");
    ok(derived?.usdMicrosMeasured === 0 && derived.calls === 1, "OPE-369(pg): a derived row defaults its measured column to 0 — it claims no measurement it didn't get");

    const all = await store.spendTotals("default", { surfaceKey: "slack/T1/C_MEASURED", period: "2026-06" });
    ok(all.usdMicros === 750 && all.usdMicrosMeasured === 500 && all.calls === 3, "🔴 OPE-369(pg): an UNFILTERED total still sums every derived micro — the caps' denomination is unchanged by measurement being available");
    const onlyMeasured = await store.spendTotals("default", { surfaceKey: "slack/T1/C_MEASURED", period: "2026-06", costSource: "measured" });
    ok(onlyMeasured.usdMicros === 600 && onlyMeasured.usdMicrosMeasured === 500 && onlyMeasured.calls === 2, "OPE-369(pg): the costSource filter isolates the comparable pair (600 derived vs 500 measured over the same 2 calls)");
  }
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
  await store.addRoutine(routine("acme", "local/dev/hist", "r-hist", { prompt: "first instruction", createdBy: "U_MAKER", createdAt: "2026-06-20T08:00:00Z", promptGeneration: 1 }));
  ok((await store.listRoutinePromptRevisions("acme", "local/dev/hist", "r-hist")).length === 0, "pg revisions: a routine nobody has edited has NO rows — nothing was destroyed, so there is nothing to have kept (this is what keeps a never-pruned table off the traffic path)");

  await store.updateRoutine("acme", "local/dev/hist", "r-hist", { lastRunAt: "2026-06-21T08:00:00Z", consecutiveFailures: 1 });
  ok((await store.listRoutinePromptRevisions("acme", "local/dev/hist", "r-hist")).length === 0, "pg revisions: a fire's patch (lastRunAt/counters) records nothing — the log grows with approved edits, never with fires");

  await store.updateRoutine("acme", "local/dev/hist", "r-hist", { prompt: "second instruction", promptGeneration: 2 }, { authoredBy: "U_ASKER", armedBy: "U_ARMER", approvalId: "pa_r1" });
  const revs = await store.listRoutinePromptRevisions("acme", "local/dev/hist", "r-hist");
  ok(
    revs.some((r) => r.prompt === "first instruction"),
    `pg revisions: THE SUPERSEDED INSTRUCTION SURVIVES the patch that overwrote it (recorded prompts: ${JSON.stringify(revs.map((r) => r.prompt))})`,
  );
  ok(revs.length === 2 && revs[0]!.seq < revs[1]!.seq, `pg revisions: the first edit records the destroyed text AND its replacement, oldest-first by the identity seq (got ${revs.length})`);
  ok(revs[0]!.generation === 1 && revs[1]!.generation === 2, "pg revisions: each row carries the generation its text ran under — the join back to routinePermissionKey()");
  ok(revs[0]!.authoredBy === "U_MAKER" && revs[0]!.recordedAt === "2026-06-20T08:00:00Z", "pg revisions: the GENESIS row is attributed from the row (createdBy/createdAt), not from the edit that retired it");
  ok(revs[0]!.armedBy === undefined && revs[0]!.approvalId === undefined, "pg revisions: the genesis row claims no approver — crediting this edit's clicker for the OLD text would be the most misleading thing this table could say");
  ok(revs[1]!.authoredBy === "U_ASKER" && revs[1]!.armedBy === "U_ARMER" && revs[1]!.approvalId === "pa_r1", "pg revisions: asker, armer and the arming card's id all round-trip");

  await store.updateRoutine("acme", "local/dev/hist", "r-hist", { prompt: "third instruction", promptGeneration: 3 }, { armedBy: "U_ARMER2", approvalId: "pa_r2" });
  const three = await store.listRoutinePromptRevisions("acme", "local/dev/hist", "r-hist");
  ok(three.length === 3 && three.map((r) => r.prompt).join("|") === "first instruction|second instruction|third instruction", `pg revisions: the log reads as the routine's whole spoken history, oldest first (got ${JSON.stringify(three.map((r) => r.prompt))})`);
  ok((await store.getRoutine("acme", "local/dev/hist", "r-hist"))!.prompt === "third instruction", "pg revisions: the LIVE row is the latest text — the log is what it USED to say");

  await store.updateRoutine("acme", "local/dev/hist", "r-hist", { prompt: "third instruction" });
  ok((await store.listRoutinePromptRevisions("acme", "local/dev/hist", "r-hist")).length === 3, "pg revisions: re-writing the SAME prompt records nothing — a no-op is not a supersession");

  await store.addRoutine(routine("globex", "local/dev/hist", "r-hist", { prompt: "other org first" }));
  await store.updateRoutine("globex", "local/dev/hist", "r-hist", { prompt: "other org second" });
  ok((await store.listRoutinePromptRevisions("acme", "local/dev/hist", "r-hist")).length === 3, "pg revisions: another org's edits to the SAME surfaceKey and routine id never leak into this org's log");
  ok((await store.listRoutinePromptRevisions("acme", "local/dev/other")).length === 0, "pg revisions: another surface in the same org is isolated");
  ok((await store.removeRoutine("acme", "local/dev/hist", "r-hist")) === true, "pg revisions: the routine is cancelled");
  ok((await store.listRoutinePromptRevisions("acme", "local/dev/hist")).length === 3, "pg revisions: cancelling does NOT un-record what was armed — the surface sweep reaches a routine whose row is gone");
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

  await store.appendUsageEvent({ org: "acme", surfaceKey: "slack/T1/C5", sessionId: "sess-attr", ts: "2026-06-24T10:30:00Z", kind: "channel", model: "m-attr", inputTokens: 90, outputTokens: 9, cacheReadTokens: 40, cacheWriteTokens: 0, cacheTokensReported: true, reasoningTokens: 0 });
  await store.appendUsageEvent({ org: "acme", surfaceKey: "slack/T1/C5", sessionId: "sess-attr", ts: "2026-06-24T10:31:00Z", kind: "channel", model: "m-attr", inputTokens: 90, outputTokens: 9, cacheReadTokens: 0, cacheWriteTokens: 0, cacheTokensReported: false });
  const attrRows = await store.usageForSession("acme", "sess-attr");
  ok(attrRows[0].cacheTokensReported === true && attrRows[0].reasoningTokens === 0, "pg attribution: a REPORTED zero reasoning count survives the read back as 0, not as absent");
  ok(attrRows[1].cacheTokensReported === false && attrRows[1].reasoningTokens === undefined, "pg attribution: an unreported dimension reads back ABSENT — the row never claims a zero it was not given");
  const attrGroup = (await store.usageSummary("acme", { surfaceKeyPrefix: "slack/T1/C5" })).find((r) => r.model === "m-attr");
  ok(attrGroup?.events === 2 && attrGroup.cacheReportedCalls === 1, "pg attribution: the rollup counts how many calls REPORTED a cache split, so an all-zero group cannot read as 'no caching'");
  ok(attrGroup?.reasoningTokens === 0 && attrGroup.reasoningReportedCalls === 1, "pg attribution: the rollup separates the reasoning SUM from how many calls contributed to it");

  ok((await store.pruneUsageEvents("acme", "2099-01-01T00:00:00Z")) === 0, "usage events: pruneUsageEvents is a no-op on Postgres (append-only)");
  ok((await store.usageForSession("acme", "sess-1")).length === 2, "usage events: rows survive the no-op prune untouched");

  await store.appendUsageEvent({
    ...base,
    sessionId: "sess-measured",
    ts: "2026-06-24T11:00:00Z",
    inputTokens: 1000,
    outputTokens: 100,
    model: "m-1",
    usdMicrosMeasured: 250,
    costSource: "measured",
    delegationDepth: 1,
    rootSessionId: "sess-root",
    detail: { generationId: "gen_pg_1" },
  });
  await store.appendUsageEvent({ ...base, sessionId: "sess-zero", ts: "2026-06-24T11:01:00Z", usdMicrosMeasured: 0, costSource: "measured", delegationDepth: 0, rootSessionId: "sess-zero" });

  const [m] = await store.usageForSession("acme", "sess-measured");
  ok(m.usdMicrosMeasured === 250 && m.costSource === "measured", "OPE-369(pg): the gateway-measured micros + cost_source round-trip on usage_events");
  ok(m.delegationDepth === 1 && m.rootSessionId === "sess-root", "OPE-369(pg): delegation depth + root session round-trip as columns, so query_analytics can group by them");
  ok(m.detail?.generationId === "gen_pg_1", "OPE-369(pg): the gateway generation id round-trips in detail — the join key to the gateway's own billing record");

  const [z] = await store.usageForSession("acme", "sess-zero");
  ok(z.usdMicrosMeasured === 0, "🔴 OPE-369(pg): a MEASURED ZERO survives the read (the gateway answered and said $0) — a truthiness read would have demoted it to 'nothing measured it'");
  ok(z.delegationDepth === 0, "🔴 OPE-369(pg): a ROOT turn's depth 0 survives the read — same trap, same fix");

  const [legacy] = await store.usageForSession("acme", "sess-2");
  ok(legacy.usdMicrosMeasured === undefined && legacy.costSource === undefined && legacy.delegationDepth === undefined && legacy.rootSessionId === undefined, "OPE-369(pg): a row written without the new fields reads them back ABSENT — nothing is backfilled or invented");

  await store.appendUsageEvent({ ...base, sessionId: "sess-late", ts: "2026-06-24T09:00:00Z", principalId: "U1", kind: "channel", inputTokens: 7, outputTokens: 1 });
  await store.appendUsageEvent({ ...base, sessionId: "sess-late", ts: "2026-06-24T10:20:00Z", principalId: "U1", kind: "channel", inputTokens: 3, outputTokens: 1 });
  const boundIso = "2026-06-24T10:00:00Z";
  const unbounded = await store.usageSummary("acme", { sinceTs: boundIso });
  const unboundedChan = unbounded.find((r) => r.kind === "channel");
  ok(unboundedChan?.events === 3 && unboundedChan.sessions === 2, "OPE-402(pg): absent sessionStartedAfter, sess-late's in-window write still counts (unchanged default behaviour)");
  const bounded = await store.usageSummary("acme", { sinceTs: boundIso, sessionStartedAfter: boundIso });
  const boundedChan = bounded.find((r) => r.kind === "channel");
  ok(boundedChan?.events === 2 && boundedChan.sessions === 1, "OPE-402(pg): with sessionStartedAfter set, sess-late is excluded wholesale (leak closed)");
  ok(!bounded.some((r) => r.kind === "channel" && r.sessions !== 1), "OPE-402(pg): the bounded read carries no trace of sess-late's rows");
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

  const USER_SCOPE = "user:slack/T1/U0EXOWNER";
  await store.setSpendLimit("default", USER_SCOPE, "user", { monthlyTokens: 4000, monthlyUsd: 12 }, { reason: "sprint", setBy: "admin#1" });
  const userRow = (await store.spendLimits("default")).find((l) => l.scopeKey === USER_SCOPE && l.level === "user");
  ok(userRow?.monthlyTokens === 4000 && userRow?.monthlyUsd === 12, "setSpendLimit round-trips a user-level override in BOTH denominations, scoped by principal key");
  ok(userRow?.reason === "sprint" && userRow?.setBy === "admin#1", "…with the same bridge metadata every other level carries (a per-person allowance is reconcilable like any other override)");
  await store.setSpendLimit("default", "slack/T1", "workspace", { monthlyTokens: 1 });
  const bothLevels = await store.spendLimits("default");
  ok(bothLevels.some((l) => l.scopeKey === USER_SCOPE && l.level === "user") && bothLevels.some((l) => l.scopeKey === "slack/T1" && l.level === "workspace"), "a person's allowance and a workspace override for the same underlying id coexist as distinct rows");
  ok((await store.clearSpendLimit("default", USER_SCOPE, "user")) === true, "clearSpendLimit removes a user-level override");
  ok((await store.spendLimits("default")).every((l) => l.level !== "user"), "the cleared user-level override is gone");
  await store.clearSpendLimit("default", "slack/T1", "workspace");

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
  await pg.exec(`DROP ROLE IF EXISTS open_everywhere_app;
                 CREATE ROLE open_everywhere_app NOSUPERUSER;
                 GRANT SELECT, INSERT, UPDATE, DELETE ON spend_ledger, routine, audit_entry, usage_events TO open_everywhere_app;`);
  try {
    await pg.exec("SET ROLE open_everywhere_app");
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
    await pg.exec("RESET ROLE");
  }
  await pg.exec("REVOKE UPDATE, DELETE ON audit_entry, usage_events FROM open_everywhere_app");
}

{
  await pg.exec(`DROP ROLE IF EXISTS oe_table_owner;
                 CREATE ROLE oe_table_owner NOSUPERUSER;
                 GRANT CREATE ON SCHEMA public TO oe_table_owner;
                 GRANT SELECT, INSERT, UPDATE, DELETE ON audit_entry, usage_events TO oe_table_owner;
                 ALTER TABLE audit_entry OWNER TO oe_table_owner;
                 ALTER TABLE usage_events OWNER TO oe_table_owner;`);
  try {
    await pg.exec("SET ROLE oe_table_owner");
    ok(((await client.query("SELECT count(*)::int AS n FROM audit_entry")).rows as { n: number }[])[0].n > 0, "FORCE: the non-superuser OWNER can still SELECT audit_entry");
    await client.query("INSERT INTO audit_entry (ts, org_id, platform, workspace, action) VALUES ('2026-06-24T14:00:00Z', 'acme', 'slack', 'T1', 'owner.append')");
    ok((await client.query("DELETE FROM audit_entry RETURNING seq")).rows.length === 0, "FORCE: DELETE on audit_entry affects 0 rows for the NON-SUPERUSER OWNER (owner-bypass closed)");
    ok((await client.query("UPDATE audit_entry SET action = 'tampered' RETURNING seq")).rows.length === 0, "FORCE: UPDATE on audit_entry affects 0 rows for the owner (immutable)");
    ok((await client.query("DELETE FROM usage_events RETURNING seq")).rows.length === 0, "FORCE: DELETE on usage_events affects 0 rows for the owner (append-only)");
    ok((await client.query("UPDATE usage_events SET kind = 'tampered' RETURNING seq")).rows.length === 0, "FORCE: UPDATE on usage_events affects 0 rows for the owner (immutable)");
  } finally {
    await pg.exec("RESET ROLE");
    await pg.exec("ALTER TABLE audit_entry OWNER TO CURRENT_USER; ALTER TABLE usage_events OWNER TO CURRENT_USER;");
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
  const TTL = 6 * 60 * 60 * 1000;
  const ORIGIN = JSON.stringify({ platform: "slack", channelId: "C_PEND" });
  const WIN = "oe-dom:payments:oe-sup:gPEND";
  const OTHERWIN = "oe-dom:treasury:oe-sup:gPEND";
  const ids = async (rows: readonly { readonly wakeId: string }[]): Promise<string[]> => rows.map((r) => r.wakeId);

  await store.putUnifiedWakeTarget("acme", "p-old", ORIGIN, "2026-07-26T10:00:00Z", TTL, WIN, true);
  await store.putUnifiedWakeTarget("acme", "p-mid", ORIGIN, "2026-07-26T10:05:00Z", TTL, WIN, true);
  await store.putUnifiedWakeTarget("acme", "p-new", ORIGIN, "2026-07-26T10:09:00Z", TTL, WIN, true);
  await store.putUnifiedWakeTarget("acme", "p-answered", ORIGIN, "2026-07-26T10:07:00Z", TTL, WIN, true);
  await store.markUnifiedWakeAnswered("acme", "p-answered", "2026-07-26T10:08:00Z", "turn-X");
  await store.putUnifiedWakeTarget("acme", "p-foreign", ORIGIN, "2026-07-26T10:06:00Z", TTL, OTHERWIN, true);
  await store.putUnifiedWakeTarget("globex", "p-otherorg", ORIGIN, "2026-07-26T10:06:00Z", TTL, WIN, true);
  await store.putUnifiedWakeTarget("acme", "p-internal", ORIGIN, "2026-07-26T10:06:00Z", TTL, WIN);
  await store.putUnifiedWakeTarget("acme", "p-legacy", ORIGIN, "2026-07-26T10:06:30Z", TTL, WIN, undefined);

  const after = await store.listPendingUnifiedWakes("acme", WIN, "2026-07-26T10:00:00Z", 50);
  ok((await ids(after)).join(",") === "p-mid,p-new", "pg: listPendingUnifiedWakes returns only rows AFTER the anchor, oldest-first");
  ok(after[0].targetJson === ORIGIN && after[0].createdAt === "2026-07-26T10:05:00Z", "pg: …carrying the opaque origin JSON and the stamp the caller's TTL bound needs");
  ok(!(await ids(after)).includes("p-answered"), "pg: an ANSWERED row is not pending — the room already heard about it");
  ok(!(await ids(after)).includes("p-foreign"), "pg: a row on ANOTHER window token never appears (the same cross-domain fence the answerable-reply arm applies)");
  ok(!(await ids(after)).includes("p-otherorg"), "pg: the listing never crosses the org boundary");
  ok(!(await ids(after)).includes("p-old"), "pg: the anchor bound is STRICT — a row stamped AT the anchor is one the model was shown");
  ok(!(await ids(after)).includes("p-internal"), "🔴 pg: a NON-INBOUND wake (one the deployment minted for itself) never appears — counting one would refuse every delegating turn's hand-off note");
  ok(!(await ids(after)).includes("p-legacy"), "pg: a pre-migration row reads as NOT inbound and never appears (a missed refusal, never a false one)");

  await store.putUnifiedWakeTarget("acme", "p-mid", ORIGIN, "2026-07-26T10:05:00Z", TTL, WIN, false);
  ok((await ids(await store.listPendingUnifiedWakes("acme", WIN, "2026-07-26T10:00:00Z", 50))).includes("p-mid"), "🔴 pg: an INTERNAL re-register does NOT clear `inbound` (sticky-true) — the redrive cannot silence the freshness gate");

  const capped = await store.listPendingUnifiedWakes("acme", WIN, "2026-07-26T10:00:00Z", 1);
  ok((await ids(capped)).join(",") === "p-mid", "pg: the limit caps the read, keeping the oldest — a burst can never load an unbounded set onto the reply path");
  const none = await store.listPendingUnifiedWakes("acme", WIN, "2026-07-26T23:00:00Z", 50);
  ok(none.length === 0, "pg: an anchor past every row lists nothing (the fast path costs one empty read)");

  const stampOf = async (id: string): Promise<string | undefined> => (await store.getUnifiedWakeRecord("acme", id))?.auditedAt;
  const unaudited = async (): Promise<string[]> => ids(await store.listUnauditedUnifiedWakes("acme", WIN, 50));

  ok((await stampOf("p-mid")) === undefined, "pg: a wake row carries NO audited stamp until the accounting audit considers it");
  ok((await unaudited()).join(",") === "p-old,p-mid,p-new", "pg: listUnauditedUnifiedWakes returns every pending, inbound, unaudited row oldest-first — and NO time bound below");
  ok(!(await unaudited()).includes("p-answered"), "pg: an ANSWERED row is not in the accounting listing either");
  ok(!(await unaudited()).includes("p-foreign") && !(await unaudited()).includes("p-internal"), "pg: the accounting listing keeps the window fence and the inbound-only rule");

  await store.markUnifiedWakesAudited("acme", ["p-mid"], "2026-07-26T10:30:00Z");
  ok((await stampOf("p-mid")) === "2026-07-26T10:30:00Z", "pg: markUnifiedWakesAudited stamps audited_at and getUnifiedWakeRecord reads it back");
  ok((await unaudited()).join(",") === "p-old,p-new", "🔴 pg: the audited row LEAVES the accounting listing — the cap bounds only wakes still to consider");
  await store.markUnifiedWakesAudited("acme", ["p-mid"], "2026-07-26T10:45:00Z");
  ok((await stampOf("p-mid")) === "2026-07-26T10:30:00Z", "pg: FIRST STAMP WINS — a re-run cannot move the horizon");
  ok((await ids(await store.listPendingUnifiedWakes("acme", WIN, "2026-07-26T10:00:00Z", 50))).includes("p-mid"),
    "🔴 pg: an AUDITED row is STILL PENDING in the freshness gate's own listing — the horizon never changes what that gate counts");
  await store.markUnifiedWakesAudited("globex", ["p-new"], "2026-07-26T10:50:00Z");
  ok((await stampOf("p-new")) === undefined, "🔴 pg: the audited mark never crosses the org boundary");
  await store.markUnifiedWakesAudited("acme", ["p-ghost-audit"], "2026-07-26T10:55:00Z");
  ok((await store.getUnifiedWakeRecord("acme", "p-ghost-audit")) === null, "pg: marking an ABSENT wake audited inserts nothing (UPDATE-only)");
  await store.markUnifiedWakesAudited("acme", [], "2026-07-26T10:56:00Z");
  ok((await stampOf("p-new")) === undefined, "pg: an EMPTY batch writes nothing");
  const cappedAudit = await store.listUnauditedUnifiedWakes("acme", WIN, 1);
  ok((await ids(cappedAudit)).join(",") === "p-old", "pg: the limit caps the accounting listing, keeping the oldest");
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
  const sk = "teams/T/CE";
  const promoters = async (thread: string): Promise<string[]> => [...((await store.getEngagement("acme", sk, thread))!.recentPromoters ?? [])];

  await store.markEngaged("acme", sk, "e.1", "2026-09-08T10:00:00Z", { participating: true, engagedBy: "act-1" });
  ok((await promoters("e.1")).join(",") === "act-1", "pg: a promotion records the promoting event id");
  ok(await store.markStopped("acme", sk, "e.1"), "pg: …and the row can then be stopped");

  await store.markEngaged("acme", sk, "e.1", "2026-09-08T11:00:00Z", { participating: true, engagedBy: "act-1" });
  const replayed = (await store.getEngagement("acme", sk, "e.1"))!;
  ok(replayed.stopped === true, "🔴 pg: a promotion REPEATING the recorded id does NOT clear `stopped` — a replay cannot lift a stand-down");
  ok(replayed.lastTurnAt === "2026-09-08T11:00:00Z", "pg: …while the rest of the upsert still applies, so the guard is on the clear alone");

  await store.markEngaged("acme", sk, "e.1", "2026-09-08T12:00:00Z", { participating: true, engagedBy: "act-2" });
  const fresh = (await store.getEngagement("acme", sk, "e.1"))!;
  ok(fresh.stopped === false, "🔴 pg: a NEW id clears the stop");
  ok((await promoters("e.1")).join(",") === "act-1,act-2", "pg: …and joins the promoter list, most recent LAST — it does not replace what was there");

  ok(await store.markStopped("acme", sk, "e.1"), "pg: stopped again");
  await store.markEngaged("acme", sk, "e.1", "2026-09-08T13:00:00Z", { participating: true });
  const unknown = (await store.getEngagement("acme", sk, "e.1"))!;
  ok(unknown.stopped === false, "🔴 pg: a promotion with NO id clears the stop — the pre-OPE-1527 rule, kept for every caller that opts out");
  ok((await promoters("e.1")).join(",") === "act-1,act-2", "pg: …and it does not erase the list, so an id-less refresh cannot blind the guard");

  ok(await store.markStopped("acme", sk, "e.1"), "pg: stopped once more");
  await store.markEngaged("acme", sk, "e.1", "2026-09-08T14:00:00Z", { participating: false, engagedBy: "act-9" });
  const warm = (await store.getEngagement("acme", sk, "e.1"))!;
  ok(warm.stopped === true, "🔴 pg: a WARM refresh carrying an id does not clear the stop");
  ok((await promoters("e.1")).join(",") === "act-1,act-2", "pg: …and does not record its id either — the list only ever grows on a promotion");

  await store.markEngaged("acme", sk, "e.2", "2026-09-08T15:00:00Z", { participating: true, engagedBy: "act-A" });
  await store.markEngaged("acme", sk, "e.2", "2026-09-08T15:01:00Z", { participating: true, engagedBy: "act-B" });
  ok(await store.markStopped("acme", sk, "e.2"), "pg: two mentions, then a stand-down");
  await store.markEngaged("acme", sk, "e.2", "2026-09-08T16:00:00Z", { participating: true, engagedBy: "act-B" });
  ok((await store.getEngagement("acme", sk, "e.2"))!.stopped === true, "pg: replaying the LATEST mention leaves the stop — the OPE-1527 guard");
  await store.markEngaged("acme", sk, "e.2", "2026-09-08T16:01:00Z", { participating: true, engagedBy: "act-A" });
  ok(
    (await store.getEngagement("acme", sk, "e.2"))!.stopped === true,
    "🔴 pg OPE-1562: replaying a SUPERSEDED mention leaves the stop TOO — the list guards every promoter it still holds",
  );
  ok((await promoters("e.2")).join(",") === "act-B,act-A", "pg: a repeat promotion RE-ORDERS the list rather than duplicating the id — it stays a set");

  await store.markEngaged("acme", sk, "e.2", "2026-09-08T16:02:00Z", { participating: true, engagedBy: "act-C" });
  ok((await store.getEngagement("acme", sk, "e.2"))!.stopped === false, "🔴 pg NEGATIVE CONTROL: a THIRD, genuine mention still clears the stop — the list is not a one-way door");

  await store.markEngaged("acme", sk, "e.3", "2026-09-08T17:00:00Z", { participating: true, engagedBy: "old-1" });
  ok((await promoters("e.3")).join(",") === "old-1", "precondition: `old-1` IS on the list before the fill — otherwise 'it was dropped' proves nothing");
  for (let i = 0; i < PROMOTER_LIST_MAX; i++) {
    await store.markEngaged("acme", sk, "e.3", `2026-09-08T17:${String(i).padStart(2, "0")}:01Z`, { participating: true, engagedBy: `fill-${i}` });
  }
  const bounded = await promoters("e.3");
  ok(bounded.length === PROMOTER_LIST_MAX, `🔴 pg: the promoter list is BOUNDED at ${PROMOTER_LIST_MAX} — an unbounded list on a hot row is its own defect`);
  ok(!bounded.includes("old-1") && bounded[0] === "fill-0" && bounded[bounded.length - 1] === `fill-${PROMOTER_LIST_MAX - 1}`, "pg: …and it drops the OLDEST id, keeping the most recent — the window slid by exactly one");
  ok(await store.markStopped("acme", sk, "e.3"), "pg: the bounded row is stood down");
  await store.markEngaged("acme", sk, "e.3", "2026-09-08T18:00:00Z", { participating: true, engagedBy: "old-1" });
  ok((await store.getEngagement("acme", sk, "e.3"))!.stopped === false, "🔴 pg RESIDUAL, pinned not claimed: a promoter the BOUND dropped can be replayed again — the guard reaches exactly as far as the list");

  await store.markEngaged("acme", sk, "e.4", "2026-09-08T19:00:00Z", { participating: true, engagedBy: "act-bare" });
  await client.query(`UPDATE thread_engagement SET engaged_by = 'act-bare' WHERE org_id = 'acme' AND surface_key = $1 AND thread_ts = 'e.4'`, [sk]);
  ok(await store.markStopped("acme", sk, "e.4"), "precondition: an UNMIGRATED bare-id row, stood down");
  await store.markEngaged("acme", sk, "e.4", "2026-09-08T19:01:00Z", { participating: true, engagedBy: "act-bare" });
  ok((await store.getEngagement("acme", sk, "e.4"))!.stopped === true, "🔴 pg: a redelivery cannot lift the stand-down on a row the boot reframe never reached — markEngaged frames the stored value itself");
  ok((await promoters("e.4")).join(",") === "act-bare", "🔴 pg: …and the bare id is NOT concatenated onto the new one — one entry, not a junk `act-bareact-bare`");
  await store.markEngaged("acme", sk, "e.4", "2026-09-08T19:02:00Z", { participating: true, engagedBy: "act-new" });
  ok((await store.getEngagement("acme", sk, "e.4"))!.stopped === false, "🔴 pg NEGATIVE CONTROL: a genuine new mention still clears it on the same unmigrated row");
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
  ok(gen1.inputTokensTotal === 0 && gen1.firstWakeAt === null && gen1.lastInputTokens === null, "pg: fresh generation starts counter=0, first_wake_at=NULL, last_input_tokens=NULL");
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
  ok(row !== null && row.lastInputTokens === 500, "pg: the same write SETS last_input_tokens to the LATEST request (500), not the running total (1500)");

  await store.touchChannelSession("acme", sk, "2026-07-09T10:05:00Z");
  row = await store.getChannelSession("acme", sk);
  ok(row !== null && row.turnCount === 1 && row.lastWakeAt === "2026-07-09T10:05:00Z" && row.generation === 1, "pg: touchChannelSession bumps turnCount + lastWakeAt, leaves generation alone");
  ok(row !== null && row.firstWakeAt === "2026-07-09T10:05:00Z", "pg: touchChannelSession stamps first_wake_at on the first delivered wake");

  await store.touchChannelSession("acme", sk, "2026-07-09T10:10:00Z");
  row = await store.getChannelSession("acme", sk);
  ok(row !== null && row.turnCount === 2, "pg: touchChannelSession accumulates across calls");
  ok(row !== null && row.firstWakeAt === "2026-07-09T10:05:00Z", "pg: a later touch does NOT move first_wake_at (COALESCE, set once)");

  const gen2 = await store.rotateChannelSession("acme", sk, "T:oe-sup:2", "2026-07-09T11:00:00Z");
  ok(gen2.generation === 2 && gen2.token === "T:oe-sup:2" && gen2.turnCount === 0, "pg: rotation mints generation 2, resets turnCount");
  ok(gen2.inputTokensTotal === 0 && gen2.firstWakeAt === null && gen2.lastInputTokens === null, "pg: rotation resets counter, first_wake_at AND last_input_tokens (a new generation has run no request)");
  row = await store.getChannelSession("acme", sk);
  ok(row !== null && row.generation === 2 && row.turnCount === 0 && row.inputTokensTotal === 0 && row.createdAt === "2026-07-09T11:00:00Z" && row.lastInputTokens === null, "pg: getChannelSession reflects the rotated generation (no stale gen-1 fields)");

  ok((await store.getChannelSession("acme", sk))!.rotateMarkedAt === null, "pg: a live generation starts unmarked");
  ok((await store.markChannelSessionRotation("acme", sk, "2026-07-09T11:30:00Z")) === true, "pg: markChannelSessionRotation returns true when it marked a row");
  ok((await store.getChannelSession("acme", sk))!.rotateMarkedAt === "2026-07-09T11:30:00Z", "pg: …and the stamp reads back on the row");
  await store.markChannelSessionRotation("acme", sk, "2026-07-09T23:00:00Z");
  ok((await store.getChannelSession("acme", sk))!.rotateMarkedAt === "2026-07-09T11:30:00Z", "pg: a second mark keeps the FIRST stamp (COALESCE) — a re-run of the sweep is idempotent");
  ok((await store.markChannelSessionRotation("acme", "slack/T/CNEVER", "2026-07-09T11:30:00Z")) === false, "pg: marking a surface with no row returns false");
  ok((await store.getChannelSession("acme", "slack/T/CNEVER")) === null, "pg: …and creates nothing — the mark is an UPDATE, never an upsert");
  await store.touchChannelSession("acme", sk, "2026-07-09T11:35:00Z");
  ok((await store.getChannelSession("acme", sk))!.rotateMarkedAt === "2026-07-09T11:30:00Z", "🔴 pg: a WAKE does not clear the mark — only a rotation spends it");

  await store.appendSessionTail("acme", sk, "T:oe-sup:1", { kind: "wake", at: "2026-07-09T10:01:00Z", from: "human", trust: "peer", author: "alice", text: "first" });
  await store.appendSessionTail("acme", sk, "T:oe-sup:1", { kind: "post", at: "2026-07-09T10:01:30Z", from: "self", trust: "relay", author: "self", text: "second" });
  const ring = await store.readSessionTail("acme", sk, "T:oe-sup:1");
  ok(ring.length === 2 && ring[0]!.text === "first" && ring[1]!.text === "second", "pg: the tail ring reads back OLDEST-FIRST, in insertion order");
  ok((await store.readSessionTail("acme", sk, "T:oe-sup:2")).length === 0, "pg: a DIFFERENT generation's token reads an EMPTY ring — the token is the ring's partition");
  ok((await store.readSessionTail("globex", sk, "T:oe-sup:1")).length === 0, "pg: the tail ring is org-isolated");
  await store.clearSessionTail("acme", sk, "T:oe-sup:1");
  ok((await store.readSessionTail("acme", sk, "T:oe-sup:1")).length === 0, "pg: clearSessionTail drops the ring");

  const TOK3 = "T:oe-sup:3";
  await store.appendSessionTail("acme", sk, TOK3, {
    kind: "post",
    at: "2026-07-09T10:02:00Z",
    from: "self",
    trust: "relay",
    author: "self",
    id: "msg-1",
    text: "Three items: a, b, c.",
  });
  await store.appendSessionTail("acme", sk, TOK3, {
    kind: "wake",
    at: "2026-07-09T10:02:05Z",
    from: "human",
    trust: "peer",
    author: "alice",
    id: "msg-1",
    text: "a wake sharing the same id",
  });

  ok((await store.editSessionTailPost("acme", sk, TOK3, "msg-1", "Four items: a, b, c, d.")) === true, "pg: editSessionTailPost finds and rewrites the matching POST row");
  let ring3 = await store.readSessionTail("acme", sk, TOK3);
  ok(ring3.find((r) => r.kind === "post")!.text === "Four items: a, b, c, d.", "pg: …the post row's text is REWRITTEN");
  ok(ring3.find((r) => r.kind === "wake")!.text === "a wake sharing the same id", "🔴 pg: …and a WAKE row carrying the SAME id is untouched — the match is on kind AND id, never id alone");

  ok((await store.editSessionTailPost("acme", sk, TOK3, "no-such-id", "should not land anywhere")) === false, "pg: a miss — no post row carries this id — returns false, silently");
  ring3 = await store.readSessionTail("acme", sk, TOK3);
  ok(ring3.find((r) => r.kind === "post")!.text === "Four items: a, b, c, d.", "pg: …and the row is UNCHANGED by the miss — never throws, never touches an unrelated row");

  ok((await store.editSessionTailPost("globex", sk, TOK3, "msg-1", "cross-org write")) === false, "pg: org isolation — the same (surfaceKey, token, id) under a DIFFERENT org finds nothing");
  ring3 = await store.readSessionTail("acme", sk, TOK3);
  ok(ring3.find((r) => r.kind === "post")!.text === "Four items: a, b, c, d.", "pg: …confirmed: this org's row was not touched by the cross-org attempt");

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
  const oldPg = await openTestPg();
  const oldClient: PgClient = oldPg.client;
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

  await oldClient.query(
    `INSERT INTO thread_engagement (org_id, surface_key, thread_ts, engaged_at, last_turn_at, participating, silent_streak, kind, stopped, engaged_by)
     VALUES ('orgM', 'teams/T/CL', 'legacy.1', '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z', true, 0, 'thread', true, 'act-legacy')`,
  );
  await initOperationalSchema(oldClient);
  const legacy = await migStore.getEngagement("orgM", "teams/T/CL", "legacy.1");
  ok(legacy !== null && [...(legacy.recentPromoters ?? [])].join(",") === "act-legacy", "pg migration: the id itself survives the reframe");
  const framedRows = (await oldClient.query(`SELECT engaged_by FROM thread_engagement WHERE thread_ts = 'legacy.1'`)).rows as { engaged_by: string }[];
  ok(framedRows[0]?.engaged_by === "\nact-legacy\n", "🔴 pg migration: a bare pre-OPE-1562 promoter id is FRAMED in place — the encoding changes, the id does not");
  await migStore.markEngaged("orgM", "teams/T/CL", "legacy.1", "2026-07-01T04:00:00Z", { participating: true, engagedBy: "act-legacy" });
  ok((await migStore.getEngagement("orgM", "teams/T/CL", "legacy.1"))!.stopped === true, "🔴 pg migration: …so a REDELIVERY of that id still cannot lift the migrated row's stand-down");
  await initOperationalSchema(oldClient);
  ok([...((await migStore.getEngagement("orgM", "teams/T/CL", "legacy.1"))!.recentPromoters ?? [])].join(",") === "act-legacy", "🔴 pg migration: the reframe is IDEMPOTENT — a second boot leaves a framed list alone");

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
  const KEY = "external-silent:join:slack/T1/C_CONNECT";
  ok(await store.claimNotice("acme", KEY, "2026-06-30T10:00:00Z"), "pg: the FIRST claim wins — the caller announces");
  ok(!(await store.claimNotice("acme", KEY, "2026-06-30T10:00:01Z")), "pg: a second claim LOSES — the caller stays quiet");
  ok(await store.noticeClaimed("acme", KEY), "pg: the read-only twin reports the claim without writing");
  ok(!(await store.noticeClaimed("acme", "external-silent:suppressed-wake:slack/T1/C_CONNECT")), "pg: a DIFFERENT kind on the same room is its own claim (=== false)");
  ok(await store.claimNotice("globex", KEY, "2026-06-30T10:00:00Z"), "pg: the same key in another ORG is a fresh claim — the table is org-partitioned");
  ok(
    !(await store.claimNotice("acme", KEY, "2036-06-30T10:00:00Z")),
    "🔴 pg: a claim TEN YEARS LATER still loses — the row NEVER expires, which is what makes the announcement once-ever rather than once-a-day",
  );
  ok(!(await store.noticeClaimed("acme", "external-silent:join:slack/T1/C_NEVER")), "negative control: an unclaimed key reads false, so the twin is not answering true for everything");
}

{
  const row = await store.addMemoryProposal({
    org: "acme",
    kind: "contradiction",
    scope: "payments",
    summary: "conflict on Ada ownership",
    before: "a\nb",
    after: "b",
    detail: { file: "MEMORY.md" },
    principalId: "dream-cycle",
    createdAt: "2026-06-30T10:00:00Z",
  });
  ok(typeof row.id === "number", "pg: addMemoryProposal returns a store-assigned numeric id");
  const acme = await store.listMemoryProposals("acme");
  ok(acme.length === 1, "pg: the proposal round-trips");
  ok(acme[0].id === row.id, "pg: the listed row carries the same id the write returned");
  ok(acme[0].before === "a\nb", "pg: `before` round-trips");
  ok(acme[0].after === "b", "pg: `after` round-trips");
  ok(acme[0].detail?.["file"] === "MEMORY.md", "pg: `detail` JSON round-trips");

  await store.addMemoryProposal({ org: "acme", kind: "skill", scope: "eng", summary: "repeated workflow", principalId: "dream-cycle", createdAt: "2026-06-30T10:05:00Z" });
  const acmeAfter = await store.listMemoryProposals("acme");
  ok(acmeAfter.length === 2, "pg: a second proposal for the same org is a second row");
  const minimal = acmeAfter.find((r) => r.kind === "skill");
  ok(minimal !== undefined && minimal.before === undefined && minimal.detail === undefined, "pg: an omitted before/detail reads back absent, not null-as-string");
  ok(acmeAfter[0].id === minimal?.id, "pg: listMemoryProposals is newest-first");

  ok((await store.listMemoryProposals("globex")).length === 0, "pg: a different org sees no rows — org-isolated (no cross-org bleed)");
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

  const pgRevs = await store.listDomainSkillRevisions("acme", "eng", "deploy-runbook");
  ok(
    pgRevs.some((r) => r.content === "# Deploy\nSteps."),
    `pg revisions: THE OLD BODY SURVIVES the destructive upsert that replaced it (readable bodies: ${JSON.stringify(pgRevs.map((r) => r.content))})`,
  );
  ok(pgRevs.length === 2, `pg revisions: one row per write, the first included (got ${pgRevs.length})`);
  ok(pgRevs[1].content === "# Deploy v2" && pgRevs[0].seq < pgRevs[1].seq, "pg revisions: oldest-first by the identity `seq`");
  ok(pgRevs[0].authoredBy === "U1" && pgRevs[1].authoredBy === "U2", "pg revisions: each row keeps its OWN author");
  ok(pgRevs[0].recordedAt === "2026-06-30T10:00:00Z", "pg revisions: each row keeps the timestamp of its own write");

  await store.putDomainSkill("acme", "eng", "gated", "# Gated body", "U_AUTHOR", "2026-06-30T14:00:00Z", { armedBy: "U_ARMER", approvalId: "pa_abc123" });
  const gated = (await store.listDomainSkillRevisions("acme", "eng", "gated"))[0];
  ok(gated.armedBy === "U_ARMER" && gated.approvalId === "pa_abc123", "pg revisions: armedBy + the arming card's id round-trip");
  ok(pgRevs[0].armedBy === undefined && pgRevs[0].approvalId === undefined, "pg revisions: a write with no provenance is still recorded (absent, not refused)");

  ok((await store.listDomainSkillRevisions("globex", "eng")).length === 1, "pg revisions: another org's log never leaks into this org's");
  ok((await store.listDomainSkillRevisions("acme", "watercooler")).length === 0, "pg revisions: another domain in the same org is isolated");
  const deletedRevs = await store.listDomainSkillRevisions("acme", "eng", "no-author");
  ok(deletedRevs.length === 1 && deletedRevs[0].content === "# No author", "pg revisions: the DELETED skill's armed body is still on the record");
  ok((await store.listDomainSkillRevisions("acme", "eng")).length === 4, "pg revisions: omitting `name` sweeps the whole domain (2 + 1 deleted + 1 gated)");
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

  await pg.exec("DROP ROLE IF EXISTS oe_runtime");
  await pg.exec("CREATE ROLE oe_runtime NOSUPERUSER");
  for (const stmt of runtimeRoleGrantsSql("oe_runtime")) await client.query(stmt);

  {
    const { OPERATIONAL_TABLES } = await import("../agent/operational/store.js");
    const DML = ["SELECT", "INSERT", "UPDATE", "DELETE"] as const;
    const fmt = (s: ReadonlySet<string>): string => DML.filter((v) => s.has(v)).join("+") || "NOTHING";
    const grantRows = (
      await client.query(
        "SELECT table_name, privilege_type FROM information_schema.table_privileges WHERE grantee = 'oe_runtime' AND table_schema = 'public'",
      )
    ).rows as { table_name: string; privilege_type: string }[];
    const granted = new Map<string, Set<string>>();
    for (const r of grantRows) (granted.get(r.table_name) ?? granted.set(r.table_name, new Set()).get(r.table_name)!).add(r.privilege_type);

    const ungranted = OPERATIONAL_TABLES.filter((t) => !granted.has(t));
    ok(ungranted.length === 0, `two-role: the runtime role holds SOME privilege on every table in OPERATIONAL_TABLES (holds NOTHING on: ${ungranted.join(", ") || "none"})`);

    const src = readFileSync(new URL("../agent/operational/postgres.ts", import.meta.url), "utf8");
    const required = new Map<string, Set<string>>();
    const need = (t: string, ...verbs: string[]): void => {
      const s = required.get(t) ?? required.set(t, new Set()).get(t)!;
      for (const v of verbs) s.add(v);
    };
    for (const m of src.matchAll(/\bINSERT\s+INTO\s+([a-z_][a-z0-9_]*)/g)) {
      need(m[1]!, "INSERT", "SELECT");
      const rest = src.slice(m.index ?? 0);
      const end = rest.search(/[`"]/);
      if (/ON\s+CONFLICT[\s\S]*?DO\s+UPDATE/i.test(end === -1 ? rest : rest.slice(0, end))) need(m[1]!, "UPDATE");
    }
    for (const m of src.matchAll(/\bDELETE\s+FROM\s+([a-z_][a-z0-9_]*)/g)) need(m[1]!, "DELETE", "SELECT");
    for (const m of src.matchAll(/\bUPDATE\s+([a-z_][a-z0-9_]*)\s+SET\b/g)) need(m[1]!, "UPDATE", "SELECT");

    const phantom = [...required.keys()].filter((t) => !(OPERATIONAL_TABLES as readonly string[]).includes(t));
    const unscanned = OPERATIONAL_TABLES.filter((t) => !required.has(t));
    ok(phantom.length === 0 && unscanned.length === 0, `two-role: the SQL scan sees a write for exactly OPERATIONAL_TABLES (phantom: ${phantom.join(", ") || "none"}; unscanned: ${unscanned.join(", ") || "none"})`);

    const mismatched = [...required.keys()]
      .sort()
      .filter((t) => DML.some((v) => required.get(t)!.has(v) !== (granted.get(t)?.has(v) ?? false)))
      .map((t) => `${t} (code issues ${fmt(required.get(t)!)}, role holds ${fmt(granted.get(t) ?? new Set())})`);
    ok(mismatched.length === 0, `two-role: every table's granted verbs EQUAL the verbs its SQL issues — ${mismatched.join("; ") || "all match"}`);
  }

  await client.query("SELECT set_config('app.current_org', '', false)");

  try {
    await pg.exec("SET ROLE oe_runtime");

    await initOperationalSchema(client);
    await initPostgresSchema(client);
    ok(true, "two-role: initOperationalSchema + initPostgresSchema boot clean under the runtime role (verify-only, no DDL)");

    await store.recordSpend("acme", { surfaceKey: "slack/T9/C9", period: "2026-07", inputTokens: 1, outputTokens: 1 });
    ok((await store.spendTotals("acme", { surfaceKey: "slack/T9/C9", period: "2026-07" })).calls === 1, "two-role: mutable DML works with the GUC unset ('' folds to unset — permissive arm)");
    await setOrgContext(client, "acme");
    const spendOrgs = new Set(((await client.query("SELECT DISTINCT org_id FROM spend_ledger")).rows as { org_id: string }[]).map((r) => r.org_id));
    ok(spendOrgs.size === 1 && spendOrgs.has("acme"), "two-role: with the GUC set, mutable-table RLS enforces for the runtime role");
    await client.query("SELECT set_config('app.current_org', '', false)");

    await client.query("INSERT INTO audit_entry (ts, org_id, platform, workspace, action) VALUES ('2026-07-11T10:00:00Z', 'acme', 'slack', 'T1', 'runtime.append')");
    ok(((await client.query("SELECT count(*)::int AS n FROM audit_entry")).rows as { n: number }[])[0].n > 0, "two-role: the runtime role can append + read audit_entry");
    await denied("UPDATE audit_entry SET action = 'tampered'", "permission denied", "two-role: UPDATE audit_entry is permission-DENIED for the runtime role");
    await denied("DELETE FROM audit_entry", "permission denied", "two-role: DELETE audit_entry is permission-DENIED for the runtime role");

    await store.putDomainSkill("acme", "eng", "runtime-role-write", "# From the runtime role", "U1", "2026-07-29T10:00:00Z", { armedBy: "U2", approvalId: "pa_rr" });
    ok((await store.listDomainSkillRevisions("acme", "eng", "runtime-role-write")).length === 1, "two-role: the runtime role can append + read domain_skill_revisions");
    await denied("UPDATE domain_skill_revisions SET content = 'tampered'", "permission denied", "two-role: UPDATE domain_skill_revisions is permission-DENIED (the approved body can't be rewritten)");
    await denied("DELETE FROM domain_skill_revisions", "permission denied", "two-role: DELETE domain_skill_revisions is permission-DENIED (the approved body can't be erased)");
    await denied("TRUNCATE domain_skill_revisions", "permission denied", "two-role: TRUNCATE domain_skill_revisions is permission-DENIED (RLS does not filter TRUNCATE)");

    await store.addRoutine(routine("acme", "local/dev/rr", "r-rr", { prompt: "runtime-role genesis" }));
    await store.updateRoutine("acme", "local/dev/rr", "r-rr", { prompt: "runtime-role replacement", promptGeneration: 2 }, { armedBy: "U2", approvalId: "pa_rr2" });
    ok((await store.listRoutinePromptRevisions("acme", "local/dev/rr", "r-rr")).length === 2, "two-role: the runtime role can append + read routine_prompt_revisions");
    await denied("UPDATE routine_prompt_revisions SET prompt = 'tampered'", "permission denied", "two-role: UPDATE routine_prompt_revisions is permission-DENIED (the armed instruction can't be rewritten by the credential that can rewrite the live routine)");
    await denied("DELETE FROM routine_prompt_revisions", "permission denied", "two-role: DELETE routine_prompt_revisions is permission-DENIED (the armed instruction can't be erased)");
    await denied("TRUNCATE routine_prompt_revisions", "permission denied", "two-role: TRUNCATE routine_prompt_revisions is permission-DENIED (RLS does not filter TRUNCATE — one statement would wipe every org's prompt history)");

    await denied("DELETE FROM webhook_capture_window", "permission denied", "two-role: DELETE webhook_capture_window is permission-DENIED (OPE-221 — no delete path exists for an arm-state row)");
    ok(
      ((await client.query("SELECT count(*)::int AS n FROM webhook_capture_window")).rows as { n: number }[])[0].n >= 0,
      "two-role: …while SELECT on webhook_capture_window still works (the narrowing is per-VERB, not a lockout)",
    );
    await denied("UPDATE event_dedupe SET seen_at = '2026-01-01T00:00:00Z'", "permission denied", "two-role: UPDATE event_dedupe is permission-DENIED (a dedupe row is written once, never edited)");
    await client.query("DELETE FROM event_dedupe WHERE org_id = 'nobody'");
    ok(true, "two-role: …while DELETE on event_dedupe is permitted (the org-scoped TTL prune still runs)");
    await denied("DELETE FROM pending_actions", "permission denied", "two-role: DELETE pending_actions is permission-DENIED (a decided action is retained)");
    await denied("DELETE FROM spend_ledger", "permission denied", "two-role: DELETE spend_ledger is permission-DENIED (deleting a period would silently lower spend against a limit)");
    await store.putStoredCredential("acme", { ref: "two-role-purge", ciphertext: "opaque", createdBy: "test", createdAt: "2026-08-07T00:00:00Z" });
    ok((await store.deleteStoredCredential("acme", "two-role-purge")) === true, "two-role: the runtime role can DELETE stored_credential (OPE-287 — offboarding must be able to destroy a credential, not merely unaddress it)");
    ok((await store.getStoredCredential("acme", "two-role-purge")) === null, "two-role: …and the row is really gone under RLS (the FOR ALL policy covers DELETE)");
    await denied("TRUNCATE spend_ledger", "permission denied", "two-role: TRUNCATE on a mutable table is permission-DENIED (RLS does not filter TRUNCATE — privileges are the only gate)");
    await denied("TRUNCATE routine", "permission denied", "two-role: TRUNCATE is denied even where DELETE is granted (routine has full CRUD)");

    await store.putGitHubInstallation("acme", { owner: "acme-org", installationId: "42", updatedAt: "2026-07-28T00:00:00Z" });
    await store.putGitHubInstallation("acme", { owner: "acme-org", installationId: "43", updatedAt: "2026-07-28T00:01:00Z" });
    const installs = await store.listGitHubInstallations("acme");
    ok(installs.length === 1 && installs[0]!.installationId === "43", "two-role: the runtime role can upsert + read github_installation (the App-install delivery path)");
    ok((await store.deleteGitHubInstallation("acme", "acme-org")) === true, "two-role: …and DELETE it (the uninstall delivery revokes for real)");

    await store.setSessionApproval({ org: "acme", sessionId: "sess-1", kind: "pr.open", grantedBy: "U1", createdAt: "2026-07-28T00:00:00Z", expiresAt: "2026-07-29T00:00:00Z" });
    ok((await store.getSessionApproval("acme", "sess-1", "pr.open", "2026-07-28T01:00:00Z"))?.grantedBy === "U1", "two-role: the runtime role can write + read pr_session_approval (the \"Approve for session\" path)");
    ok((await store.revokeSessionApprovals("acme", "sess-1")) === 1, "two-role: …and revoke it (OPE-152 — withdrawing a standing routine grant is a real DELETE)");

    await denied("DROP POLICY audit_select ON audit_entry", "must be owner", "two-role: DROP POLICY is refused (not owner)");
    await denied("ALTER TABLE audit_entry DISABLE ROW LEVEL SECURITY", "must be owner", "two-role: DISABLE ROW LEVEL SECURITY is refused (not owner)");
    await denied("ALTER TABLE audit_entry NO FORCE ROW LEVEL SECURITY", "must be owner", "two-role: NO FORCE ROW LEVEL SECURITY is refused (not owner)");
    await denied("CREATE POLICY sneaky_delete ON audit_entry FOR DELETE USING (true)", "must be owner", "two-role: smuggling in a DELETE policy is refused (not owner)");
    await denied("ALTER TABLE usage_events DISABLE ROW LEVEL SECURITY", "must be owner", "two-role: usage_events DDL is refused too");

    ok((await verifyAppendOnlyAudit(client)).length === 0, "two-role: verifyAppendOnlyAudit reports a sound posture");
  } finally {
    await pg.exec("RESET ROLE");
  }

  {
    await pg.exec("DROP POLICY audit_insert ON audit_entry");
    const found = await verifyAppendOnlyAudit(client);
    ok(found.some((v) => v.includes("no INSERT policy")), "tamper: verifyAppendOnlyAudit detects the dropped policy");

    await initOperationalSchema(client);
    ok((await verifyAppendOnlyAudit(client)).length === 0, "tamper: the owner-mode boot re-applies the append-only posture");
    const integrity = await store.readAudit({ org: "default", action: "audit.integrity" });
    ok(integrity.length === 1 && integrity[0].detail?.healed === true, "tamper: the repair is recorded as an audit.integrity row (healed:true)");
    ok(JSON.stringify(integrity[0].detail?.violations ?? []).includes("no INSERT policy"), "tamper: the integrity row names what was broken");
  }

  {
    await pg.exec("ALTER TABLE audit_entry NO FORCE ROW LEVEL SECURITY");
    await pg.exec("SET ROLE oe_runtime");
    let threw = "";
    try {
      await initOperationalSchema(client);
    } catch (e) {
      threw = e instanceof Error ? e.message : String(e);
    } finally {
      await pg.exec("RESET ROLE");
    }
    ok(threw.includes("FAILED verification") && threw.includes("FORCE"), "tamper: the runtime-role boot refuses to serve on a tampered posture (fail-closed)");

    await initOperationalSchema(client);
    ok((await verifyAppendOnlyAudit(client)).length === 0, "tamper: owner-mode boot repairs after the runtime refusal");
    const integrity = await store.readAudit({ org: "default", action: "audit.integrity" });
    ok(integrity.some((r) => r.detail?.healed === false) && integrity.filter((r) => r.detail?.healed === true).length === 2, "tamper: refusal (healed:false) and both repairs (healed:true) are all audit rows");
  }

  {
    const previousOrg = registeredDeploymentIdentity()?.org;
    _setDeploymentIdentityForTest({ org: "Acme Inc" });
    try {
      const normalised = deploymentOrg();
      ok(normalised === "Acme-Inc", "an org of \"Acme Inc\" is a value the two paths CAN disagree on (deploymentOrg cleans it)");

      await pg.exec("DROP POLICY audit_insert ON audit_entry");
      await initOperationalSchema(client);
      ok((await verifyAppendOnlyAudit(client)).length === 0, "the owner-mode boot healed the posture again");

      const stamped = await store.readAudit({ org: normalised, action: "audit.integrity" });
      ok(stamped.length === 1 && stamped[0].detail?.healed === true, "🔴 the integrity row is readable at deploymentOrg() — the org every other row is stamped with");
      const rawEnv = await store.readAudit({ org: "Acme Inc", action: "audit.integrity" });
      ok(rawEnv.length === 0, "🔴 nothing landed under the RAW declared value — no second spelling of one deployment's org");
      const other = await store.readAudit({ org: "default", action: "audit.integrity" });
      ok(other.length === 3, "negative control: the \"default\" partition is unchanged by a boot under another org");
    } finally {
      _setDeploymentIdentityForTest({ org: previousOrg });
    }
  }

  async function integrityHealMentions(fragment: string): Promise<boolean> {
    const rows = await store.readAudit({ org: "default", action: "audit.integrity" });
    return rows.some((r) => r.detail?.healed === true && JSON.stringify(r.detail?.healed_artifacts ?? {}).includes(fragment));
  }

  {
    await pg.exec("CREATE FUNCTION oe_swallow_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END; $$");
    await pg.exec("CREATE TRIGGER oe_swallow BEFORE INSERT ON audit_entry FOR EACH ROW EXECUTE FUNCTION oe_swallow_audit()");
    ok((await verifyAppendOnlyAudit(client)).some((v) => v.includes("hostile trigger") && v.includes("oe_swallow")), "probe(a): verify detects the insert-swallowing trigger");

    await pg.exec("SET ROLE oe_runtime");
    let threw = "";
    try {
      await initOperationalSchema(client);
    } catch (e) {
      threw = e instanceof Error ? e.message : String(e);
    } finally {
      await pg.exec("RESET ROLE");
    }
    ok(threw.includes("FAILED verification") && threw.includes("hostile trigger"), "probe(a): runtime-role boot fails closed on the hostile trigger");

    await initOperationalSchema(client);
    ok((await verifyAppendOnlyAudit(client)).length === 0, "probe(a): owner boot heals the trigger — posture sound");
    ok(await integrityHealMentions("oe_swallow"), "probe(a): the dropped trigger is recorded in healed_artifacts");
    await client.query("INSERT INTO audit_entry (ts, org_id, platform, workspace, action) VALUES ('2026-07-11T11:00:00Z','acme','slack','T1','post.heal.a')");
    ok((await store.readAudit({ org: "acme", action: "post.heal.a" })).length === 1, "probe(a): appends land again once the trigger is healed");
  }

  {
    await pg.exec("CREATE POLICY oe_block_insert ON audit_entry AS RESTRICTIVE FOR INSERT WITH CHECK (false)");
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
    await pg.exec("SET ROLE oe_runtime");
    try {
      await client.query("TRUNCATE audit_entry");
      ok(false, "probe(c): TRUNCATE unexpectedly succeeded for the runtime role");
    } catch (e) {
      ok((e instanceof Error ? e.message : String(e)).includes("permission denied"), "probe(c): TRUNCATE is permission-denied for the runtime role after the revoke");
    } finally {
      await pg.exec("RESET ROLE");
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

  const wedge = { ...base, id: "pa-wedge", status: "approved" as const, decidedBy: "chain:custom:x", decidedAt: "2026-07-20T01:00:00Z", postedTo: null };
  ok((await store.addPendingActionIfAbsent(wedge)) === true, "pending: addPendingActionIfAbsent reports TRUE when it really inserts");
  ok((await store.getPendingAction("default", "pa-wedge"))?.decidedBy === "chain:custom:x", "pending: and the row is there");
  ok(
    (await store.addPendingActionIfAbsent({ ...wedge, decidedBy: "chain:custom:SECOND", decidedAt: "2026-07-20T09:00:00Z" })) === false,
    "🔴 pending: a second insert on the same id reports FALSE instead of throwing a primary-key violation",
  );
  const kept = await store.getPendingAction("default", "pa-wedge");
  ok(kept?.decidedBy === "chain:custom:x" && kept.decidedAt === "2026-07-20T01:00:00Z", "🔴 pending: and the FIRST row survives untouched — ON CONFLICT DO NOTHING, never an upsert");
  ok((await store.getPendingAction("acme", "pa-wedge")) === null, "pending: the conflict arm is org-scoped like every other pending read");
  ok((await store.addPendingActionIfAbsent({ ...wedge, org: "acme" })) === true, "pending: the same id under a DIFFERENT org still inserts — the key is (org, id)");
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
  ok((await store.getWebhookCaptureWindow("default", "deploy-status")) === null, "capture window: a hook nobody armed has NO row — absence is the closed state, so creation is not consent to retention");

  await store.armWebhookCaptureWindow("default", "deploy-status", "2026-07-28T01:00:00.000Z", "U-ARMER", "2026-07-28T00:00:00.000Z");
  const first = (await store.getWebhookCaptureWindow("default", "deploy-status"))!;
  ok(first.captureUntil === "2026-07-28T01:00:00.000Z" && first.armedBy === "U-ARMER", "capture window: arming stores the deadline and who opened it");

  await store.armWebhookCaptureWindow("default", "deploy-status", "2026-07-28T02:00:00.000Z", "U-OTHER", "2026-07-28T01:30:00.000Z");
  const second = (await store.getWebhookCaptureWindow("default", "deploy-status"))!;
  ok(second.captureUntil === "2026-07-28T02:00:00.000Z" && second.armedBy === "U-OTHER", "🔴 capture window: RE-ARMING REPLACES — one hook has at most one window, so the numbering a human reads is never ambiguous across a boundary they cannot see");

  ok((await store.getWebhookCaptureWindow("acme", "deploy-status")) === null, "capture window: the row is per-ORG — another tenant arming the same hook id is a different row");

  await store.armWebhookCaptureWindow("default", "old-hook", "2020-01-01T00:00:00.000Z", "U-ARMER", "2020-01-01T00:00:00.000Z");
  ok((await store.getWebhookCaptureWindow("default", "old-hook"))?.captureUntil === "2020-01-01T00:00:00.000Z", "capture window: an ELAPSED deadline is returned unchanged, never filtered out by the store");
}

{
  const grant = (id: string): Parameters<typeof store.addCredentialGrant>[1] => ({
    askId: `ask-${id}`,
    connector: "notion",
    createdAt: "2026-07-28T00:00:00.000Z",
    expiresAt: "2026-07-28T01:00:00.000Z",
    id,
    mode: "once",
    ownerPrincipalId: "slack/W1/U-owner",
    ownerSlug: "rowan_hale",
    purpose: "draft the Q3 summary",
    frozenArgs: { page: "abc123" },
    inputSchema: { properties: { page: { const: "abc123", type: "string" } }, required: ["page"], type: "object" },
    mcpTool: "notion-fetch",
    requesterPrincipalId: "slack/W1/U-req",
    resource: "Launch page — notion-fetch({page:abc123})",
    scopeKey: "session-1",
    status: "active",
    tier: "read",
    toolName: "grant__rowan_hale_notion__notion_fetch_launch_page",
    verb: "notion_fetch",
  });
  const CAP = 3;
  await store.addCredentialGrant("default", grant("pg-claim"));
  await store.addCredentialGrant("default", grant("pg-claim-sibling"));

  const burnAt = "2026-07-28T00:10:00.000Z";
  ok((await store.burnCredentialGrant("default", "pg-claim", burnAt)) !== null, "credential grant: a once-mode row burns");
  ok((await store.refundCredentialGrant("default", "pg-claim", burnAt)) === true, "credential grant: the caller that owns the burn stamp refunds it");
  ok((await store.getCredentialGrant("default", "pg-claim"))?.status === "active", "credential grant: …and the row is ACTIVE again on the real engine");

  for (let attempt = 1; attempt <= CAP; attempt++) {
    ok(await store.claimCredentialGrantRefund("default", "pg-claim", "turn_1", CAP), `credential grant: refund claim ${attempt} of ${CAP} lands`);
  }
  ok((await store.claimCredentialGrantRefund("default", "pg-claim", "turn_1", CAP)) === false, "🔴 credential grant: the K+1'th claim on one turn is refused — the count is a column, so it outlives any context a crashed step replayed away");
  ok(await store.claimCredentialGrantRefund("default", "pg-claim", "turn_2", CAP), "🔴 credential grant: a NEW turn key rolls the count — the allowance is per turn, not per row lifetime");
  ok(await store.claimCredentialGrantRefund("default", "pg-claim-sibling", "turn_1", CAP), "credential grant: another row keeps its own budget — the count is keyed by the row it sits on");
  ok((await store.claimCredentialGrantRefund("acme", "pg-claim", "turn_9", CAP)) === false, "credential grant: the claim is org-scoped — another tenant cannot spend or roll this row's allowance");
  ok((await store.claimCredentialGrantRefund("default", "pg-claim-absent", "turn_1", CAP)) === false, "credential grant: a row that does not exist claims nothing");

  await store.addCredentialGrant("default", grant("pg-claim-noturn"));
  for (let attempt = 1; attempt <= CAP; attempt++) {
    ok(await store.claimCredentialGrantRefund("default", "pg-claim-noturn", "turn_1", CAP), `credential grant: the named turn spends allowance ${attempt} of ${CAP}`);
  }
  ok((await store.claimCredentialGrantRefund("default", "pg-claim-noturn", undefined, CAP)) === false, "🔴 credential grant: a claim with NO turn key is refused against a spent allowance — it never rolls the stored key");
  ok(await store.claimCredentialGrantRefund("default", "pg-claim-noturn", "turn_9", CAP), "credential grant: …while a NAMED new turn does roll it, so the keyless refusal is the key's doing and not a dead statement");

  await store.addCredentialGrant("default", grant("pg-claim-race"));
  const claims = await Promise.all([
    store.claimCredentialGrantRefund("default", "pg-claim-race", "turn_1", 1),
    store.claimCredentialGrantRefund("default", "pg-claim-race", "turn_1", 1),
  ]);
  ok(claims.filter((won) => won).length === 1, "credential grant: two overlapping claims of a one-refund allowance — exactly ONE wins");
}

await closeAllTestPg();
console.log(`✓ operational — ${passed} assertions (pglite contract, spend/routine/audit isolation, RLS, audit+usage append-only under app role AND FORCE-RLS under a non-superuser owner, two-role runtime posture (DDL escape closed) + tamper detection/refusal, broadened suppression detection (hostile trigger / restrictive policy / stray grant — detect+heal+fail-closed), event dedupe, domain skills, routine prompt revisions, domain model pick, ownership routing (ownerToken/kind), durable stopped marker, channel supervisor sessions, pending-action posted_to round-trip + decide CAS, github installations (upsert/list/delete + org isolation), migration)`);
