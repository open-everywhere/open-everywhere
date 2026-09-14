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
  defineDomain({ name: "org", match: "org", memory: "org-brain", admins: ["slack/T1/U_ORG"] }),
  defineDomain({ name: "eng", reach: ["slack/T1/CA"], admins: ["slack/T1/U_ENG"] }),
  defineDomain({ name: "fin", reach: ["slack/T1/CB"], admins: ["slack/T1/U_FIN"] }),
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
  { surfaceKey: "slack/T1/CA", sessionId: "s1", principalId: "U_A", ts: "2026-07-01T10:00:00Z", kind: "channel", surfaceMode: "channel" as const, inputTokens: 100, outputTokens: 20 },
  { surfaceKey: "slack/T1/CA", sessionId: "s2", principalId: "U_A", ts: "2026-07-02T10:00:00Z", kind: "channel", surfaceMode: "channel" as const, inputTokens: 50, outputTokens: 10 },
  { surfaceKey: "slack/T1/CB", sessionId: "s3", principalId: "U_B", ts: "2026-07-01T10:00:00Z", kind: "channel", surfaceMode: "channel" as const, inputTokens: 999, outputTokens: 999 },
  { surfaceKey: "slack/T1/D01ABCDEF", sessionId: "s4", principalId: "U_A", ts: "2026-07-03T10:00:00Z", kind: "dm", surfaceMode: "dm" as const, inputTokens: 7, outputTokens: 3 },
  { surfaceKey: "discord/G1/1180000000000000447", sessionId: "s5", principalId: "U_A", ts: "2026-07-03T11:00:00Z", kind: "routine", surfaceMode: "dm" as const, inputTokens: 11, outputTokens: 1 },
  { surfaceKey: "teams/T1/19:meeting_ZmFrZQ==@thread.v2", sessionId: "s6", principalId: "U_B", ts: "2026-07-03T12:00:00Z", kind: "dm", surfaceMode: "dm" as const, inputTokens: 13, outputTokens: 2 },
  { surfaceKey: "discord/G1/1180000000000000913", sessionId: "s7", principalId: "U_B", ts: "2026-07-03T13:00:00Z", kind: "channel", surfaceMode: "channel" as const, inputTokens: 17, outputTokens: 4 },
  { surfaceKey: "slack/T1/D0LEGACY01", sessionId: "s8", principalId: "U_A", ts: "2026-07-03T14:00:00Z", kind: "routine", inputTokens: 19, outputTokens: 5 },
  { surfaceKey: "slack/T1/C0LEGACY02", sessionId: "s10", principalId: "U_A", ts: "2026-07-03T15:00:00Z", kind: "channel", inputTokens: 23, outputTokens: 6 },
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

const orgScope: AnalyticsScope = { org: ORG, platform: "slack", grain: "org", rowMode: true, auditDetail: true, dmUnmasked: false };
const orgScopeDmUnmasked: AnalyticsScope = { org: ORG, platform: "slack", grain: "org", rowMode: true, auditDetail: true, dmUnmasked: true };
const engScope: AnalyticsScope = { org: ORG, platform: "slack", grain: "domain", domain: "eng", rowMode: true, auditDetail: false, dmUnmasked: false };
const engMemberScope: AnalyticsScope = { org: ORG, platform: "slack", grain: "domain", domain: "eng", rowMode: false, auditDetail: false, dmUnmasked: false };
const selfAScope: AnalyticsScope = { org: ORG, platform: "slack", grain: "self", principalId: "U_A", rowMode: true, auditDetail: false, dmUnmasked: false };

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
  ok(total === 100 + 50 + 999 + 7 + 11 + 13 + 17 + 19 + 23, "org total is exactly this org's nine rows — the 'other' org's row is NEVER included (org_id isolation)");
}

{
  const masked = await runBoth({ dataset: "usage", scope: "org", groupBy: ["surface"], select: ["events"] }, orgScope);
  ok(masked.s.rows.some((r) => r.surface === "slack/T1/(dms)") && !masked.s.rows.some((r) => r.surface === "slack/T1/D01ABCDEF"), "DM surface is bucketed to (dms) at org grain in a room");
  const unmasked = await runBoth({ dataset: "usage", scope: "org", groupBy: ["surface"], select: ["events"] }, orgScopeDmUnmasked);
  ok(unmasked.s.rows.some((r) => r.surface === "slack/T1/D01ABCDEF"), "org admin asking from their own DM sees the DM surface unbucketed");

  const surfaces = (rows: readonly Record<string, unknown>[]) => rows.map((r) => String(r.surface));
  const grouped = masked.s.rows;
  ok(canon(masked.s.rows) === canon(masked.p.rows), "OPE-1862: the masked grouping is identical on SQLite and Postgres (the mode column is grouped in SQL, so both engines fold the same way)");
  for (const [platform, leaked, bucket] of [
    ["discord", "discord/G1/1180000000000000447", "discord/G1/(dms)"],
    ["teams", "teams/T1/19:meeting_ZmFrZQ==@thread.v2", "teams/T1/(dms)"],
  ] as const) {
    ok(surfaces(grouped).includes(bucket), `🔴 OPE-1862/${platform}: query_analytics groups the DM row under (dms)`);
    ok(!surfaces(grouped).includes(leaked), `🔴 OPE-1862/${platform}: …and never names the individual's surface`);
  }
  ok(surfaces(grouped).includes("discord/G1/1180000000000000913"), "OPE-1862: a Discord CHANNEL is still named — the mask hides DMs, not the dataset");
  ok(surfaces(grouped).includes("slack/T1/(unclassified)") && !surfaces(grouped).includes("slack/T1/D0LEGACY01"), "🔴 OPE-1862: an UNSTAMPED row masks to (unclassified) — fail closed");
  ok(!surfaces(grouped).includes("slack/T1/C0LEGACY02"), "🔴 OPE-1862: an unstamped CHANNEL row masks in aggregate mode too — the grouping may only use a column that cannot split a session, so the legacy tag is not read here");
  const discordDm = grouped.find((r) => r.surface === "discord/G1/(dms)");
  ok(discordDm?.events === 1, "OPE-1862: the masked bucket keeps its measures — masking a key never drops the spend it carried");

  for (const store of [sqlStore, pgStore]) {
    await store.appendUsageEvent({ org: ORG, surfaceKey: "slack/T1/C_SESS", sessionId: "s-sess-1", principalId: "U_SESS", ts: "2026-07-05T10:00:00Z", kind: "channel", surfaceMode: "channel", inputTokens: 5, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 });
    await store.appendUsageEvent({ org: ORG, surfaceKey: "slack/T1/C_SESS", sessionId: "s-sess-1", principalId: "U_SESS", ts: "2026-07-05T10:01:00Z", kind: "sandbox", surfaceMode: "channel", inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
  }
  const sess = await runBoth({ dataset: "usage", scope: "org", groupBy: ["surface"], select: ["sessions", "events"] }, orgScope);
  const sessRow = sess.s.rows.find((r) => r.surface === "slack/T1/C_SESS");
  ok(canon(sess.s.rows) === canon(sess.p.rows), "OPE-1862: the session count folds identically on both engines");
  ok(Number(sessRow?.events) === 2, "fixture control: both rows are in scope — the session assertion below is the DISTINCT count, not an empty group");
  ok(Number(sessRow?.sessions) === 1, "🔴 OPE-1862: two rows of ONE session under two different origin tags still count as ONE session — the mask's grouping never inflates a distinct count");

  const rows = await runBoth({ dataset: "usage", scope: "org", mode: "rows", limit: 50 }, orgScope);
  const rowKeys = rows.s.rows.map((r) => String(r.surface_key));
  ok(rowKeys.includes("discord/G1/(dms)") && !rowKeys.includes("discord/G1/1180000000000000447"), "🔴 OPE-1862: rows mode masks a Discord DM too — the raw key never reaches the caller");
  ok(rowKeys.includes("slack/T1/(unclassified)"), "OPE-1862: rows mode fails closed on an unstamped row");
}

{
  const { s, p } = await runBoth({ dataset: "usage", scope: "self", groupBy: ["principal"], select: ["events"] }, selfAScope);
  ok(canon(s.rows) === canon(p.rows), "usage self-scope: dual-engine parity");
  ok(s.rows.length === 1 && s.rows[0].principal === "U_A", "self scope returns ONLY the caller (U_A) — never U_B");
}

{
  const discordRow = { org: ORG, surfaceKey: "discord/G9/C_DEV", sessionId: "s9", principalId: "U_A", ts: "2026-07-04T10:00:00Z", kind: "channel", surfaceMode: "channel" as const, inputTokens: 4242, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  await sqlStore.appendUsageEvent(discordRow);
  await pgStore.appendUsageEvent(discordRow);
  const discordAudit = { org: ORG, ts: "2026-07-04T10:00:00Z", platform: "discord", workspace: "G9", surface: "C_DEV", principalId: "U_A", action: "reply.post", detail: { note: "discord row" } };
  await sqlStore.appendAudit(discordAudit);
  await pgStore.appendAudit(discordAudit);

  const discordSelf: AnalyticsScope = { org: ORG, platform: "discord", grain: "self", principalId: "U_A", rowMode: true, auditDetail: false, dmUnmasked: false };

  const slackUsage = await runBoth({ dataset: "usage", scope: "self", groupBy: ["surface"], select: ["input_tokens"] }, selfAScope);
  ok(canon(slackUsage.s.rows) === canon(slackUsage.p.rows), "OPE-309: cross-platform self scope keeps dual-engine parity (usage)");
  ok(!slackUsage.s.rows.some((r) => String(r.surface).startsWith("discord/")), "🔴 OPE-309: the SLACK U_A's self scope does not read the DISCORD U_A's usage rows — a bare-id predicate would have returned both");
  ok(
    slackUsage.s.rows.reduce((t, r) => t + Number(r.input_tokens), 0) === 100 + 50 + 7 + 19 + 23,
    "OPE-309: …and still returns every one of the caller's OWN rows, the unstamped legacy one included (the fix narrows the namespace, not the person)",
  );

  const discordUsage = await runBoth({ dataset: "usage", scope: "self", groupBy: ["surface"], select: ["input_tokens"] }, discordSelf);
  ok(
    discordUsage.s.rows.some((r) => r.surface === "discord/G9/C_DEV" && r.input_tokens === 4242),
    "OPE-309: …and the DISCORD U_A sees exactly their own row — the fence cuts both ways, and neither caller is left blind",
  );
  ok(
    discordUsage.s.rows.every((r) => !String(r.surface).includes("1180000000000000447")),
    "OPE-1862: a self-scope read masks the caller's OWN Discord DM too — self grain never unmasks (access/analytics-scope.ts)",
  );

  const slackAudit = await runBoth({ dataset: "audit", scope: "self", groupBy: ["platform"], select: ["rows"] }, selfAScope);
  ok(slackAudit.s.rows.length === 1 && slackAudit.s.rows[0].platform === "slack", "🔴 OPE-309: the audit dataset is namespaced by its own `platform` column — the Slack caller never sees the Discord row");
  const discordAuditRead = await runBoth({ dataset: "audit", scope: "self", groupBy: ["platform"], select: ["rows"] }, discordSelf);
  ok(discordAuditRead.s.rows.length === 1 && discordAuditRead.s.rows[0].platform === "discord", "OPE-309: …and the Discord caller sees only theirs");
}

{
  assert.throws(() => compileAnalyticsQuery(parse({ dataset: "usage", scope: "domain", mode: "rows" }), engMemberScope, domains), /rows mode isn't available/, "a member (rowMode:false — the ambient degrade target) CANNOT get raw rows");
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

{
  const lineage = [
    { surfaceKey: "slack/T1/CA", sessionId: "root-1", principalId: "U_A", ts: "2026-07-04T10:00:00Z", kind: "channel", inputTokens: 10, outputTokens: 1, delegationDepth: 0, rootSessionId: "root-1", usdMicrosMeasured: 100, costSource: "measured" as const },
    { surfaceKey: "slack/T1/CA", sessionId: "root-1", principalId: "U_A", ts: "2026-07-04T10:01:00Z", kind: "subagent", inputTokens: 20, outputTokens: 2, delegationDepth: 1, rootSessionId: "root-1", usdMicrosMeasured: 200, costSource: "measured" as const },
    { surfaceKey: "slack/T1/CA", sessionId: "child-1", principalId: "U_A", ts: "2026-07-04T10:02:00Z", kind: "subagent", inputTokens: 40, outputTokens: 4, delegationDepth: 2, rootSessionId: "root-1" },
  ];
  for (const e of lineage) {
    await sqlStore.appendUsageEvent({ org: ORG, cacheReadTokens: 0, cacheWriteTokens: 0, ...e });
    await pgStore.appendUsageEvent({ org: ORG, cacheReadTokens: 0, cacheWriteTokens: 0, ...e });
  }

  const byDepth = await runBoth({ dataset: "usage", scope: "org", groupBy: ["depth"], select: ["events", "input_tokens"] }, orgScope);
  ok(canon(byDepth.s.rows) === canon(byDepth.p.rows), "OPE-369: grouping by delegation depth is dual-engine identical");
  const depth2 = byDepth.s.rows.find((r) => Number(r.depth) === 2);
  ok(depth2?.input_tokens === 40 && depth2.events === 1, "🔴 OPE-369: `depth` separates a grandchild-or-deeper call from a direct child's — the dimension the ticket asked for");

  const byRoot = await runBoth({ dataset: "usage", scope: "org", groupBy: ["root_session"], select: ["input_tokens"] }, orgScope);
  ok(canon(byRoot.s.rows) === canon(byRoot.p.rows), "OPE-369: grouping by root session is dual-engine identical");
  const tree = byRoot.s.rows.find((r) => r.root_session === "root-1");
  ok(tree?.input_tokens === 70, "🔴 OPE-369: ONE group-by recovers the whole tree (10 root + 20 child + 40 GRANDCHILD) — the grandchild's row files under the child, so a session-keyed read would have missed it entirely");

  const bySource = await runBoth({ dataset: "usage", scope: "org", groupBy: ["cost_source"], select: ["events", "measured_usd"] }, orgScope);
  ok(canon(bySource.s.rows) === canon(bySource.p.rows), "OPE-369: cost_source + measured_usd are dual-engine identical");
  const measured = bySource.s.rows.find((r) => r.cost_source === "measured");
  ok(Math.abs(Number(measured?.measured_usd) - 0.0003) < 1e-9, "OPE-369: measured_usd sums the GATEWAY's own micros as dollars (100 + 200 micros = $0.0003)");
  const unmeasured = bySource.s.rows.find((r) => r.cost_source === null || r.cost_source === undefined);
  ok(Number(unmeasured?.measured_usd ?? 0) === 0, "🔴 OPE-369: rows with NO measured cost sum to 0, not to NULL — the COALESCE keeps a pre-migration row from poisoning the whole sum");
}

{
  await sqlStore.recordSpend(ORG, { surfaceKey: "slack/T1/CA", principalId: "U_A", model: "m-1", period: "2026-07", inputTokens: 100, usdMicros: 2_500_000, surfaceMode: "channel" });
  await pgStore.recordSpend(ORG, { surfaceKey: "slack/T1/CA", principalId: "U_A", model: "m-1", period: "2026-07", inputTokens: 100, usdMicros: 2_500_000, surfaceMode: "channel" });
  await sqlStore.recordSpend(ORG, { surfaceKey: "slack/T1/CA", principalId: "U_A", model: "m-1", period: "2026-07", inputTokens: 50, usdMicros: 1_500_000, usdMicrosMeasured: 1_000_000, costSource: "measured", surfaceMode: "channel" });
  await pgStore.recordSpend(ORG, { surfaceKey: "slack/T1/CA", principalId: "U_A", model: "m-1", period: "2026-07", inputTokens: 50, usdMicros: 1_500_000, usdMicrosMeasured: 1_000_000, costSource: "measured", surfaceMode: "channel" });

  const spendUsd = await runBoth({ dataset: "spend", scope: "org", groupBy: ["surface"], select: ["usd", "usd_measured", "calls"] }, orgScope);
  ok(canon(spendUsd.s.rows) === canon(spendUsd.p.rows), "spend usd: dual-engine parity");
  const ca = spendUsd.s.rows.find((r) => r.surface === "slack/T1/CA");
  ok(Number(ca?.usd) === 4, "🔴 REGRESSION: the spend dataset's `usd` measure returns the real total ($2.50 + $1.50) — it silently reported 0 for every query before this fix");

  const dmLedgerKey = "discord/G1/1180000000000000447";
  for (const store of [sqlStore, pgStore]) {
    await store.recordSpend(ORG, { surfaceKey: dmLedgerKey, principalId: "U_A", model: "m-1", period: "2026-07", inputTokens: 10, usdMicros: 100_000, surfaceMode: "dm" });
    await store.recordSpend(ORG, { surfaceKey: "slack/T1/C_LEDGER_NOMODE", principalId: "U_A", model: "m-1", period: "2026-07", inputTokens: 10, usdMicros: 100_000 });
  }
  const spendSurfaces = await runBoth({ dataset: "spend", scope: "org", groupBy: ["surface"], select: ["usd"] }, orgScope);
  const spendKeys = spendSurfaces.s.rows.map((r) => String(r.surface));
  ok(canon(spendSurfaces.s.rows) === canon(spendSurfaces.p.rows), "OPE-1862: the masked ledger grouping is identical on both engines");
  ok(spendKeys.includes("discord/G1/(dms)") && !spendKeys.includes(dmLedgerKey), "🔴 OPE-1862: a Discord DM LEDGER row groups under (dms) — the ledger case the id-shape mask could never reach");
  ok(spendKeys.includes("slack/T1/(unclassified)") && !spendKeys.includes("slack/T1/C_LEDGER_NOMODE"), "🔴 OPE-1862: an unstamped ledger row masks — fail closed, and into its own bucket");
  ok(Number(ca?.usd_measured) === 1, "OPE-369: `usd_measured` sums the gateway's own figure over the measured rows only");
  ok(Number(ca?.calls) === 2, "…alongside the call count, which was in the old allowlist and is unchanged");

  const measuredOnly = await runBoth({ dataset: "spend", scope: "org", groupBy: ["cost_source"], select: ["usd", "usd_measured"] }, orgScope);
  const m = measuredOnly.s.rows.find((r) => r.cost_source === "measured");
  ok(Number(m?.usd) === 1.5 && Number(m?.usd_measured) === 1, "🔴 OPE-369: grouping by cost_source gives the APPLES-TO-APPLES drift pair — $1.50 derived vs $1.00 measured over the SAME call (the unfiltered $4 total would have overstated the divergence 3x)");
}

{
  const attribution = [
    { surfaceKey: "slack/T1/CATTR", sessionId: "attr-1", principalId: "U_A", ts: "2026-07-05T10:00:00Z", kind: "channel", surfaceMode: "channel" as const, inputTokens: 10, outputTokens: 1, cacheReadTokens: 5, cacheWriteTokens: 2, cacheTokensReported: true, reasoningTokens: 30 },
    { surfaceKey: "slack/T1/CATTR", sessionId: "attr-2", principalId: "U_A", ts: "2026-07-05T10:01:00Z", kind: "channel", surfaceMode: "channel" as const, inputTokens: 10, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, cacheTokensReported: true, reasoningTokens: 0 },
    { surfaceKey: "slack/T1/CATTR", sessionId: "attr-3", principalId: "U_A", ts: "2026-07-05T10:02:00Z", kind: "channel", surfaceMode: "channel" as const, inputTokens: 10, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, cacheTokensReported: false },
  ];
  for (const e of attribution) {
    await sqlStore.appendUsageEvent({ org: ORG, ...e });
    await pgStore.appendUsageEvent({ org: ORG, ...e });
  }

  const attr = await runBoth(
    { dataset: "usage", scope: "org", groupBy: ["surface"], select: ["events", "cache_read_tokens", "cache_reported_calls", "reasoning_tokens", "reasoning_reported_calls"] },
    orgScope,
  );
  ok(canon(attr.s.rows) === canon(attr.p.rows), "🔴 OPE-1611: the attribution measures are dual-engine identical — the boolean column reads the same on pg's real boolean and sqlite's 1/0");
  const cb = attr.s.rows.find((r) => r.surface === "slack/T1/CATTR");
  ok(Number(cb?.events) === 3, "OPE-1611: the fixture's three calls are all in scope (the denominator the coverage counts are read against)");
  ok(Number(cb?.cache_read_tokens) === 5, "OPE-1611: the cache token sum counts only the call that carried tokens");
  ok(Number(cb?.cache_reported_calls) === 2, "🔴 OPE-1611: cache_reported_calls counts the PUBLISHED-ZERO call too (2 of 3) — that is the whole distinction, and a sum alone cannot express it");
  ok(Number(cb?.reasoning_tokens) === 30, "OPE-1611: the reasoning sum COALESCEs the unreported row to 0 rather than going NULL over the group");
  ok(Number(cb?.reasoning_reported_calls) === 2, "🔴 OPE-1611: reasoning_reported_calls counts non-NULL only, so a REPORTED zero (attr-2) counts and an UNREPORTED one (attr-3) does not — the pair a truthiness read would collapse");

  await sqlStore.recordSpend(ORG, { surfaceKey: "slack/T1/CATTR", principalId: "U_A", model: "m-1", period: "2026-07", inputTokens: 10, usdMicros: 1000, reasoningTokens: 30, surfaceMode: "channel" });
  await pgStore.recordSpend(ORG, { surfaceKey: "slack/T1/CATTR", principalId: "U_A", model: "m-1", period: "2026-07", inputTokens: 10, usdMicros: 1000, reasoningTokens: 30, surfaceMode: "channel" });
  const led = await runBoth({ dataset: "spend", scope: "org", groupBy: ["surface"], select: ["usd", "reasoning_tokens"] }, orgScope);
  ok(canon(led.s.rows) === canon(led.p.rows), "OPE-1611: the ledger's reasoning_tokens measure is dual-engine identical");
  const ledCb = led.s.rows.find((r) => r.surface === "slack/T1/CATTR");
  ok(Number(ledCb?.reasoning_tokens) === 30, "🔴 OPE-1611: the spend dataset can READ the reasoning dimension it writes — before this it was summed on every upsert and returnable by nothing");
  ok(Number(ledCb?.usd) === 0.001, "🔴 OPE-1611: the reasoning dimension is ATTRIBUTION only — the row's $ is exactly its usdMicros, unmoved by 30 reasoning tokens");
}

console.log(`\n✓ analytics-query: ${n} assertions passed (dual-engine parity, scope isolation A↮B, self-scope, no-rows-for-degraded, audit detail gating, domain fold + est_usd, OPE-369 depth/root/cost_source dims + measured_usd, OPE-1611 attribution measures + coverage counts)\n`);
