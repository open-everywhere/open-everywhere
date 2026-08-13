import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { getConfig } from "../access/config.js";
import { resolveAnalyticsScope, isAmbientNonAddressedTurn } from "../access/analytics-scope.js";
import { analyticsQuerySchema, compileAnalyticsQuery, type AnalyticsQuery } from "../analytics/compile.js";
import { schemaCard } from "../analytics/registry.js";
import { executeAnalytics } from "../analytics/execute.js";
import { resolveAssumedModel } from "../spend/reporting.js";
import { getOperationalStore } from "../operational/provider.js";
import { auditToolAction } from "../audit/tool-action.js";
import { z } from "zod";

export default defineTool({
  description:
    "Query your org's own operational analytics in natural language — you form a STRUCTURED query object (never SQL) over a fixed schema, the host compiles + scopes it, and returns the answer. Restricted to what your access lets you see: scope=\"self\" (your own rows), scope=\"domain\" (anyone in a memory domain — aggregates; domain/org admins also get raw rows), scope=\"org\" (org admins). Datasets/dimensions/measures:\n" +
    schemaCard() +
    "\nmode \"aggregate\" (default) returns grouped measures; mode \"rows\" returns a raw listing (admins only). filters: [{dim, op:\"eq\"|\"in\"|\"prefix\", value}]. since/until are ISO-8601 (audit/usage). tsBucket buckets the \"ts\" group dim (hour|day|week|month). Note: DM usage is bucketed as \"(dms)\", $ figures are estimates, and audit records ACTIONS only (silences aren't rows).",
  inputSchema: analyticsQuerySchema,
  outputSchema: z.object({
    dataset: z.string(),
    scope: z.enum(["org", "domain", "self"]),
    mode: z.enum(["aggregate", "rows"]),
    rowCount: z.number(),
    truncated: z.boolean(),
    rows: z.array(z.record(z.string(), z.unknown())),
    notes: z.array(z.string()),
  }),
  approval: never(),
  async execute(input: AnalyticsQuery, ctx) {
    const notes: string[] = [];
    let scope;
    try {
      scope = resolveAnalyticsScope(ctx, input.scope);
    } catch (err) {
      await auditToolAction(ctx, "analytics.refused", { dataset: input.dataset, scope: input.scope, mode: input.mode, reason: String(err instanceof Error ? err.message : err) });
      throw err;
    }

    const ambient = isAmbientNonAddressedTurn(ctx);
    let effective: AnalyticsQuery = input;
    let ambientDegraded = false;

    if (effective.mode === "rows" && ambient) {
      effective = { ...effective, mode: "aggregate" };
      ambientDegraded = true;
      notes.push("Degraded to aggregates: rows mode requires a directly-addressed turn (this was an ambient supervisor wake).");
    }

    let result;
    try {
      const domains = getConfig().loadDomains();
      const compiled = compileAnalyticsQuery(effective, scope, domains);
      result = await executeAnalytics(compiled, { store: getOperationalStore(), domains, assumed: resolveAssumedModel() });
    } catch (err) {
      await auditToolAction(ctx, "analytics.refused", { dataset: input.dataset, scope: input.scope, mode: effective.mode, reason: String(err instanceof Error ? err.message : err) });
      throw err;
    }

    await auditToolAction(ctx, "analytics.query", {
      dataset: effective.dataset,
      grain: scope.grain,
      mode: result.mode,
      ...(effective.groupBy && effective.groupBy.length ? { groupBy: effective.groupBy } : {}),
      ...(effective.filters && effective.filters.length ? { filterDims: effective.filters.map((f) => f.dim) } : {}),
      ...(effective.since ? { since: effective.since } : {}),
      ...(effective.until ? { until: effective.until } : {}),
      rowCount: result.rowCount,
      ...(ambientDegraded ? { ambientDegraded: true } : {}),
    });

    if (result.truncated) notes.push("Result truncated to the row cap — narrow the window or add filters for a complete answer.");
    if (effective.dataset === "audit") notes.push('audit records ACTIONS only — a low reply/no-reply rate is NOT derivable here (silence isn\'t a row); ask about the session transcript for "why quiet".');
    if (result.rows.some((r) => "est_usd" in r)) notes.push(resolveAssumedModel().note);

    return { dataset: result.dataset, scope: scope.grain, mode: result.mode, rowCount: result.rowCount, truncated: result.truncated, rows: result.rows as Record<string, unknown>[], notes };
  },
});
