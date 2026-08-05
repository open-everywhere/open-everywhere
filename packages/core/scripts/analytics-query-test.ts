process.env.OE_SQLITE_PATH = ":memory:";

import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { sqliteOperationalStore } from "../agent/operational/sqlite.js";
import { initOperationalSchema, makeOperationalPostgresStore, type PgClient } from "../agent/operational/postgres.js";
import type { OperationalStore } from "../agent/operational/store.js";
import { compileAnalyticsQuery, analyticsQuerySchema } from "../agent/analytics/compile.js";
import { executeAnalytics } from "../agent/analytics/execute.js";
import type { AnalyticsScope } from "../agent/access/analytics-scope.js";
import { resolveAssumedModel } from "../agent/spend/reporting.js";
import { defineDomain, type Domain } from "../agent/memory/domain.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

const domains: Domain[] = [
  defineDomain({ name: "org", match: "org", memory: "org-brain", admins: ["slack/U_ORG"] }),
  defineDomain({ name: "eng", channels: ["slack/T1/CA"], admins: ["slack/U_ENG"] }),
  defineDomain({ name: "fin", channels: ["slack/T1/CB"], admins: ["slack/U_FIN"] }),
];

const ORG = "acme";
const parse = (q: unknown) => analyticsQuerySchema.parse(q);
const assumed = resolveAssumedModel();

const pg = new PGlite();
const pgClient: PgClient = { query: (text, params) => pg.query(text, params ? [...params] : undefined) };
await initOperationalSchema(pgClient);
const pgStore = makeOperationalPostgresStore(pgClient);
const sqlStore = sqliteOperationalStore;

const seedUsage = [
  { surfaceKey: "slack/T1/CA", sessionId: "s1", principalId: "U_A", ts: "2026-07-01T10:00:00Z", kind: "channel", inputTokens: 100, outputTokens: 20 },
  { surfaceKey: "slack/T1/CA", sessionId: "s2", principalId: "U_A", ts: "2026-07-02T10:00:00Z", kind: "channel", inputTokens: 50, outputTokens: 10 },
  { surfaceKey: "slack/T1/CB", sessionId: "s3", principalId: "U_B", ts: "2026-07-01T10:00:00Z", kind: "channel", inputTokens: 999, outputTokens: 999 },
  { surfaceKey: "slack/T1/D01ABCDEF", sessionId: "s4", principalId: "U_A", ts: "2026-07-03T10:00:00Z", kind: "dm", inputTokens: 7, outputTokens: 3 },
];
for (const e of seedUsage) {
  await sqlStore.appendUsageEvent({ org: ORG, cacheReadTokens: 0, cacheWriteTokens: 0, ...e });
  await pgStore.appendUsageEvent({ org: ORG, cacheReadTokens: 0, cacheWriteTokens: 0, ...e });
}
await sqlStore.appendUsageEvent({ org: "other", surfaceKey: "slack/T1/CA", sessionId: "sx", principalId: "U_A", ts: "2026-07-01T10:00:00Z", kind: "channel", inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 });
await pgStore.appendUsageEvent({ org: "other", surfaceKey: "slack/T1/CA", sessionId: "sx", principalId: "U_A", ts: "2026-07-01T10:00:00Z", kind: "channel", inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 });

for (const a of [
  { platform: "slack", workspace: "T1", surface: "CA", principalId: "U_A", action: "reply.post", detail: { note: "eng row" } },
  { platform: "slack", workspace: "T1", surface: "CB", principalId: "U_B", action: "reply.post", detail: { note: "fin row" } },
]) {
  await sqlStore.appendAudit({ org: ORG, ts: `2026-07-01T10:00:00Z`, ...a });
  await pgStore.appendAudit({ org: ORG, ts: `2026-07-01T10:00:00Z`, ...a });
}

const orgScope: AnalyticsScope = { org: ORG, grain: "org", rowMode: true, auditDetail: true, dmUnmasked: false };
const orgScopeDmUnmasked: AnalyticsScope = { org: ORG, grain: "org", rowMode: true, auditDetail: true, dmUnmasked: true };
const engScope: AnalyticsScope = { org: ORG, grain: "domain", domain: "eng", rowMode: true, auditDetail: false, dmUnmasked: false };
const engMemberScope: AnalyticsScope = { org: ORG, grain: "domain", domain: "eng", rowMode: false, auditDetail: false, dmUnmasked: false };
const selfAScope: AnalyticsScope = { org: ORG, grain: "self", principalId: "U_A", rowMode: true, auditDetail: false, dmUnmasked: false };

async function runBoth(input: unknown, scope: AnalyticsScope) {
  const compiled = compileAnalyticsQuery(parse(input), scope, domains);
  const s = await executeAnalytics(compiled, { store: sqlStore as OperationalStore, domains, assumed });
  const p = await executeAnalytics(compiled, { store: pgStore, domains, assumed });
  return { s, p };
}

const canon = (rows: readonly Record<string, unknown>[]) =>
  JSON.stringify([...rows].map((r) => Object.fromEntries(Object.entries(r).sort())).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));

{
  const { s, p } = await runBoth({ dataset: "usage", scope: "domain", groupBy: ["surface"], select: ["events", "input_tokens"] }, engScope);
  ok(canon(s.rows) === canon(p.rows), "usage domain-scope: SQLite and Postgres return identical rows (dual-engine parity)");
  ok(s.rows.length === 1 && s.rows[0].surface === "slack/T1/CA", "domain 'eng' sees ONLY its own channel CA — never CB, never the DM");
  ok(s.rows[0].input_tokens === 150 && s.rows[0].events === 2, "CA aggregate is correct (100+50 tokens, 2 events)");
  ok(!s.rows.some((r) => String(r.surface).includes("CB")), "SECURITY: domain-A scope cannot read domain-B (CB) rows");
}

{
  const { s, p } = await runBoth({ dataset: "usage", scope: "org", groupBy: ["surface"], select: ["input_tokens"] }, orgScope);
  ok(canon(s.rows) === canon(p.rows), "usage org-scope: dual-engine parity");
  const cb = s.rows.find((r) => r.surface === "slack/T1/CB");
  ok(cb?.input_tokens === 999, "org admin sees domain-B (CB) rows");
  const total = s.rows.reduce((t, r) => t + Number(r.input_tokens), 0);
  ok(total === 100 + 50 + 999 + 7, "org total is exactly this org's four rows — the 'other' org's row is NEVER included (org_id isolation)");
}

{
  const masked = await runBoth({ dataset: "usage", scope: "org", groupBy: ["surface"], select: ["events"] }, orgScope);
  ok(masked.s.rows.some((r) => r.surface === "slack/T1/(dms)") && !masked.s.rows.some((r) => r.surface === "slack/T1/D01ABCDEF"), "DM surface is bucketed to (dms) at org grain in a room");
  const unmasked = await runBoth({ dataset: "usage", scope: "org", groupBy: ["surface"], select: ["events"] }, orgScopeDmUnmasked);
  ok(unmasked.s.rows.some((r) => r.surface === "slack/T1/D01ABCDEF"), "org admin asking from their own DM sees the DM surface unbucketed");
}

{
  const { s, p } = await runBoth({ dataset: "usage", scope: "self", groupBy: ["principal"], select: ["events"] }, selfAScope);
  ok(canon(s.rows) === canon(p.rows), "usage self-scope: dual-engine parity");
  ok(s.rows.length === 1 && s.rows[0].principal === "U_A", "self scope returns ONLY the caller (U_A) — never U_B");
}

{
  assert.throws(() => compileAnalyticsQuery(parse({ dataset: "usage", scope: "domain", mode: "rows" }), engMemberScope, domains), /rows mode isn't available/, "a member (rowMode:false — the tainted/ambient degrade target) CANNOT get raw rows");
  n++;
  const agg = await runBoth({ dataset: "usage", scope: "domain", groupBy: ["kind"], select: ["events"] }, engMemberScope);
  ok(agg.s.rows.length >= 1, "the same member still gets aggregates (degrade, not deny)");
}

{
  const engRows = await runBoth({ dataset: "audit", scope: "domain", mode: "rows" }, engScope);
  ok(engRows.s.rows.length === 1 && engRows.s.rows[0].surface === "CA", "audit domain 'eng' rows: only the CA action row (CB excluded)");
  ok(!("detail" in engRows.s.rows[0]), "domain-admin audit rows carry NO detail");
  const orgRows = await runBoth({ dataset: "audit", scope: "org", mode: "rows" }, orgScope);
  ok(orgRows.s.rows.some((r) => r.surface === "CA") && orgRows.s.rows.some((r) => r.surface === "CB"), "org admin audit rows span both surfaces");
  ok(orgRows.s.rows.every((r) => "detail" in r), "org-admin audit rows include detail (parsed JSON)");
  ok(canon(engRows.s.rows) === canon(engRows.p.rows) && canon(orgRows.s.rows) === canon(orgRows.p.rows), "audit rows: dual-engine parity");
}

{
  const { s, p } = await runBoth({ dataset: "usage", scope: "org", groupBy: ["domain"], select: ["input_tokens", "est_usd"] }, orgScope);
  ok(canon(s.rows) === canon(p.rows), "domain-group + est_usd: dual-engine parity");
  const eng = s.rows.find((r) => r.domain === "eng");
  const fin = s.rows.find((r) => r.domain === "fin");
  ok(eng?.input_tokens === 150 && fin?.input_tokens === 999, "usage folds by computed domain (eng=150, fin=999)");
  ok(s.rows.every((r) => !("est_usd" in r) || typeof r.est_usd === "number"), "est_usd is a number when priced, absent when not — never a fabricated value");
}

console.log(`\n✓ analytics-query: ${n} assertions passed (dual-engine parity, scope isolation A↮B, self-scope, no-rows-for-degraded, audit detail gating, domain fold + est_usd)\n`);
