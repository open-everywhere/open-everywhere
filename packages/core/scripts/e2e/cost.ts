import { modelPricing, estimateCostUsd } from "../../agent/spend/pricing.js";

export interface UsageSlice {
  readonly surfaceKey: string;
  readonly model: string;
  readonly calls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly estimatedUsd: number | undefined;
}

export interface RunCostReport {
  readonly slices: readonly UsageSlice[];
  readonly totalUsd: number;
  readonly unpricedModels: readonly string[];
}

interface UsageRow {
  surface_key: string;
  model: string | null;
  calls: string | number;
  input_tokens: string | number;
  output_tokens: string | number;
  cache_read_tokens: string | number;
  cache_write_tokens: string | number;
}

const n = (v: string | number): number => (typeof v === "number" ? v : Number(v) || 0);

export function buildCostReport(rows: readonly UsageRow[]): RunCostReport {
  const slices: UsageSlice[] = [];
  const unpriced = new Set<string>();
  let total = 0;
  for (const r of rows) {
    const model = r.model ?? "(unstamped)";
    const usage = {
      inputTokens: n(r.input_tokens),
      outputTokens: n(r.output_tokens),
      cacheReadTokens: n(r.cache_read_tokens),
      cacheWriteTokens: n(r.cache_write_tokens),
    };
    const usd = estimateCostUsd(usage, modelPricing(model));
    if (usd === undefined) unpriced.add(model);
    else total += usd;
    slices.push({
      surfaceKey: r.surface_key,
      model,
      calls: n(r.calls),
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
      estimatedUsd: usd,
    });
  }
  return { slices, totalUsd: total, unpricedModels: [...unpriced].sort() };
}

export async function fetchRunUsage(
  dbUrl: string,
  sinceIso: string,
  workspacePrefixes: readonly string[],
): Promise<readonly UsageRow[]> {
  const { neon } = await import("@neondatabase/serverless");
  const sql = neon(dbUrl);
  const like = workspacePrefixes.map((p) => `${p}/%`);
  const rows = (await sql.query(
    `SELECT surface_key, model,
            count(*)                 AS calls,
            sum(input_tokens)        AS input_tokens,
            sum(output_tokens)       AS output_tokens,
            sum(cache_read_tokens)   AS cache_read_tokens,
            sum(cache_write_tokens)  AS cache_write_tokens
       FROM usage_events
      WHERE ts >= $1
        AND surface_key LIKE ANY($2)
      GROUP BY surface_key, model
      ORDER BY surface_key, model`,
    [sinceIso, like],
  )) as UsageRow[];
  return rows;
}

const fmtUsd = (v: number): string => `$${v.toFixed(4)}`;

export function renderCostReport(report: RunCostReport): string[] {
  const lines: string[] = [];
  for (const s of report.slices) {
    const usd = s.estimatedUsd === undefined ? "unpriced" : fmtUsd(s.estimatedUsd);
    lines.push(
      `  ${s.surfaceKey} ${s.model}: ${s.calls} calls, ${s.inputTokens}in/${s.outputTokens}out` +
        `${s.cacheReadTokens ? `/${s.cacheReadTokens}cr` : ""} → ${usd}`,
    );
  }
  lines.push(
    `e2e run cost: ${fmtUsd(report.totalUsd)}` +
      (report.unpricedModels.length ? ` (+ unpriced: ${report.unpricedModels.join(", ")})` : ""),
  );
  return lines;
}
