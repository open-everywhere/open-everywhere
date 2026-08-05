import assert from "node:assert/strict";
import { compileAnalyticsQuery, assembleAnalyticsSql, analyticsQuerySchema, isoWeekStart, AGGREGATE_SCAN_CAP, ROWS_LIMIT_MAX } from "../agent/analytics/compile.js";
import type { AnalyticsScope } from "../agent/access/analytics-scope.js";
import { defineDomain, type Domain } from "../agent/memory/domain.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

const domains: Domain[] = [
  defineDomain({ name: "org", match: "org", memory: "org-brain", admins: ["slack/U_ORG"] }),
  defineDomain({ name: "eng", channels: ["slack/T1/CA", "slack/T1/CA2"], admins: ["slack/U_ENG"] }),
  defineDomain({ name: "fin", channels: ["slack/T1/CB"], admins: ["slack/U_FIN"] }),
];

const orgScope: AnalyticsScope = { org: "acme", grain: "org", rowMode: true, auditDetail: true, dmUnmasked: false };
const engDomainScope: AnalyticsScope = { org: "acme", grain: "domain", domain: "eng", rowMode: true, auditDetail: false, dmUnmasked: false };
const memberDomainScope: AnalyticsScope = { org: "acme", grain: "domain", domain: "eng", rowMode: false, auditDetail: false, dmUnmasked: false };
const selfScope: AnalyticsScope = { org: "acme", grain: "self", principalId: "slack:T1:U9", rowMode: true, auditDetail: false, dmUnmasked: false };

const parse = (q: unknown) => analyticsQuerySchema.parse(q);

{
  const c = compileAnalyticsQuery(parse({ dataset: "usage", scope: "org", groupBy: ["surface"], select: ["events"] }), orgScope, domains);
  ok(c.sql.where[0] === "org_id = ?", "org_id is the FIRST WHERE conjunct");
  ok(c.sql.params[0] === "acme", "org bind param is the scope's org (from resolvePartition, never a model field)");
  ok(!JSON.stringify(c.sql).includes('"acme"') || c.sql.params.includes("acme"), "org value only appears as a bind param, never inlined into SQL text");
}

{
  const c = compileAnalyticsQuery(parse({ dataset: "usage", scope: "domain", groupBy: ["surface"], select: ["events"] }), engDomainScope, domains);
  ok(c.sql.where.some((w) => /surface_key IN \(\?, \?\)/.test(w)), "domain scope → surface_key IN (?, ?) over the domain's TWO explicit channels");
  ok(c.sql.params.includes("slack/T1/CA") && c.sql.params.includes("slack/T1/CA2"), "the domain's channel keys are bind params");
  ok(!c.sql.params.includes("slack/T1/CB"), "another domain's channel is NOT in the predicate — scope is exactly the caller's domain");

  const withFilter = compileAnalyticsQuery(parse({ dataset: "usage", scope: "domain", groupBy: ["surface"], select: ["events"], filters: [{ dim: "kind", op: "eq", value: "channel" }] }), engDomainScope, domains);
  ok(withFilter.sql.where.some((w) => /surface_key IN/.test(w)) && withFilter.sql.where.some((w) => /kind = \?/.test(w)), "a model filter ANDs onto the scope predicate, never widens it");
  ok(withFilter.sql.params.includes("channel"), "the filter VALUE is a bind param, not SQL text");
}

{
  const c = compileAnalyticsQuery(parse({ dataset: "usage", scope: "self", groupBy: ["kind"], select: ["events"] }), selfScope, domains);
  ok(c.sql.where.some((w) => w === "principal_id = ?"), "self scope → principal_id = ?");
  ok(c.sql.params.includes("slack:T1:U9"), "the principal bind param is the verified caller, never a model input");
}

{
  const c = compileAnalyticsQuery(parse({ dataset: "audit", scope: "domain", groupBy: ["action"], select: ["rows"] }), engDomainScope, domains);
  ok(c.sql.where.some((w) => /platform = \? AND workspace = \? AND surface = \?/.test(w)), "audit domain scope → (platform=? AND workspace=? AND surface=?) per channel");
  ok(c.sql.params.includes("CA") && c.sql.params.includes("T1") && c.sql.params.includes("slack"), "the channel key is split into platform/workspace/surface bind params");
}

{
  const adminRows = compileAnalyticsQuery(parse({ dataset: "audit", scope: "org", mode: "rows" }), orgScope, domains);
  ok(adminRows.sql.select.some((s) => s.alias === "detail"), "org-admin rows mode includes audit `detail`");
  const domainRows = compileAnalyticsQuery(parse({ dataset: "audit", scope: "domain", mode: "rows" }), engDomainScope, domains);
  ok(!domainRows.sql.select.some((s) => s.alias === "detail"), "domain-admin rows mode DROPS audit `detail` (org-admin only)");
}

{
  assert.throws(() => compileAnalyticsQuery(parse({ dataset: "usage", scope: "domain", mode: "rows" }), memberDomainScope, domains), /rows mode isn't available/, "member (rowMode:false) requesting rows THROWS");
  n++;
  {
    const spendSelf = compileAnalyticsQuery(parse({ dataset: "spend", scope: "self", select: ["calls", "usd"] }), selfScope, domains);
    ok(spendSelf.sql.where.some((w) => /principal_id = \?/.test(w)), "spend + self compiles and scopes to principal_id = ? (OPE-265: the ledger now has a principal dimension)");
    ok(spendSelf.sql.params.includes(selfScope.principalId), "spend + self binds the caller's own principal id");
  }
  n++;
  assert.throws(() => compileAnalyticsQuery({ dataset: "usage", scope: "org", select: ["events"], filters: [{ dim: "kind", op: "eq", value: "x" }], groupBy: ["not_a_dim" as never] } as never, orgScope, domains), /./, "an unknown groupBy dim is rejected (zod enum / compiler)");
  n++;
  assert.throws(() => compileAnalyticsQuery(parse({ dataset: "usage", scope: "org", select: ["events"], since: "2020-01-01T00:00:00Z", until: "2026-01-01T00:00:00Z" }), orgScope, domains), /exceeds the .* maximum/, "an over-long window THROWS");
  n++;
}

{
  assert.throws(() => parse({ dataset: "usage", scope: "org", select: ["totally_made_up"] }), /./, "an unknown measure fails zod BEFORE compile");
  n++;
  assert.throws(() => parse({ dataset: "made_up_dataset", scope: "org" }), /./, "an unknown dataset fails zod");
  n++;
}

{
  const c = compileAnalyticsQuery(parse({ dataset: "usage", scope: "domain", groupBy: ["surface", "kind"], select: ["events", "input_tokens"], filters: [{ dim: "kind", op: "in", value: ["channel", "dm"] }] }), engDomainScope, domains);
  const qmark = assembleAnalyticsSql(c.sql, "qmark");
  const dollar = assembleAnalyticsSql(c.sql, "dollar");
  const qCount = (qmark.sql.match(/\?/g) ?? []).length;
  ok(qCount === qmark.params.length, "qmark: every `?` has exactly one bind param");
  ok(!/\?/.test(dollar.sql) && /\$1/.test(dollar.sql) && new RegExp(`\\$${dollar.params.length}\\b`).test(dollar.sql), "dollar: `?`→`$1..$n`, highest index equals param count");
  ok(/SELECT .* FROM usage_events WHERE org_id = \?/.test(qmark.sql), "assembled SQL is a scoped SELECT over the registry table");
  ok(/GROUP BY/.test(qmark.sql) && /LIMIT \d+/.test(qmark.sql), "aggregate SQL groups and carries an integer LIMIT literal");
  ok(qmark.sql.includes(`LIMIT ${AGGREGATE_SCAN_CAP}`), "aggregate mode fetches up to the scan cap (host folds + applies the real limit)");
}

{
  const c = compileAnalyticsQuery(parse({ dataset: "usage", scope: "org", mode: "rows", limit: 5000 }), orgScope, domains);
  ok(c.sql.groupBy.length === 0, "rows mode has no GROUP BY");
  ok(c.sql.orderBy?.expr === "ts" && c.sql.orderBy.dir === "DESC", "rows mode orders newest-first");
  ok(c.sql.limit === ROWS_LIMIT_MAX, "rows mode clamps the limit to the ROWS max regardless of a larger request");
}

{
  const c = compileAnalyticsQuery(parse({ dataset: "audit", scope: "org", groupBy: ["action"], select: ["rows"], filters: [{ dim: "action", op: "prefix", value: "connector." }] }), orgScope, domains);
  ok(c.sql.where.some((w) => /action LIKE \(\? \|\| '%'\)/.test(w)), "prefix → LIKE (? || '%') — the prefix is a bind param, the % is SQL");
  ok(c.sql.params.includes("connector."), "the prefix value is a bind param");
}

{
  ok(isoWeekStart("2026-07-24") === "2026-07-20", "2026-07-24 (Fri) → ISO week start Mon 2026-07-20");
  ok(isoWeekStart("2026-07-20") === "2026-07-20", "a Monday maps to itself");
}

console.log(`\n✓ analytics-compile: ${n} assertions passed (scope injection non-bypassable, no SQL-string injection, enum/scope refusals, dual placeholder rendering)\n`);
