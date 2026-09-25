import type { OperationalStore } from "../operational/store.js";
import type { Domain } from "../memory/domain.js";
import { type AnalyticsPlan, type CompiledAnalytics, domainOfRow, isoWeekStart } from "./compile.js";
import { DATASETS, type DatasetName } from "./registry.js";
import { rowCostUsd, type AssumedModelPricing } from "../spend/reporting.js";
import { maskSurfaceKey, surfaceDisclosureOf } from "../spend/dm-mask.js";

export interface AnalyticsResult {
  readonly mode: "aggregate" | "rows";
  readonly dataset: string;
  readonly rows: readonly Record<string, unknown>[];
  readonly rowCount: number;
  readonly truncated: boolean;
}

export interface AnalyticsExecuteDeps {
  readonly store: Pick<OperationalStore, "runAnalyticsQuery">;
  readonly domains: readonly Domain[];
  readonly assumed: AssumedModelPricing;
}

function isSummableMeasure(dataset: string, measure: string): boolean {
  return DATASETS[dataset as DatasetName]?.measures[measure]?.kind === "sql";
}

function maskSurface(value: unknown, row: Record<string, unknown>, plan: AnalyticsPlan, dmUnmasked: boolean): unknown {
  if (dmUnmasked || typeof value !== "string") return value;
  const mode = row[plan.surfaceModeColumn];
  const kind = plan.surfaceKindColumn ? row[plan.surfaceKindColumn] : undefined;
  return maskSurfaceKey(
    value,
    surfaceDisclosureOf({
      surfaceKey: value,
      ...(typeof mode === "string" ? { surfaceMode: mode } : {}),
      ...(typeof kind === "string" ? { kind } : {}),
    }),
  );
}

function num(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

export async function executeAnalytics(compiled: CompiledAnalytics, deps: AnalyticsExecuteDeps): Promise<AnalyticsResult> {
  const { sql, plan } = compiled;
  const raw = await deps.store.runAnalyticsQuery(sql);

  if (plan.mode === "rows") {
    const rows = raw.slice(0, plan.outputLimit).map((r) => shapeRow(r, plan));
    return { mode: "rows", dataset: plan.dataset, rows, rowCount: rows.length, truncated: raw.length >= plan.outputLimit };
  }

  const groups = new Map<string, Record<string, unknown>>();
  for (const r of raw) {
    const dimValues: Record<string, unknown> = {};
    const keyParts: string[] = [];
    for (const d of plan.outputDims) {
      let value: unknown;
      if (d.kind === "domain") value = domainOfRow(r, plan, deps.domains);
      else if (d.kind === "ts") value = d.tsBucket === "week" ? isoWeekStart(String(r.ts ?? "")) : r.ts;
      else value = maskSurface(r[d.column!], r, plan, plan.dmUnmasked || d.name !== "surface");
      dimValues[d.name] = value ?? null;
      keyParts.push(`${d.name}=${String(value)}`);
    }
    const key = keyParts.join("\u0000");
    let acc = groups.get(key);
    if (!acc) {
      acc = { ...dimValues };
      for (const m of plan.measures) if (m !== "est_usd") acc[m] = 0;
      groups.set(key, acc);
    }
    for (const m of plan.measures) {
      if (m === "est_usd") continue;
      if (isSummableMeasure(plan.dataset, m)) acc[m] = num(acc[m]) + num(r[m]);
    }
    if (plan.wantsEstUsd) {
      const cost = rowCostUsd(
        { inputTokens: num(r.input_tokens), outputTokens: num(r.output_tokens), cacheReadTokens: num(r.cache_read_tokens), model: typeof r.model === "string" ? r.model : undefined },
        deps.assumed,
        "one-call",
      );
      if (cost !== undefined) acc.est_usd = num(acc.est_usd) + cost;
    }
  }

  let out = [...groups.values()];
  const sortKey = plan.orderBy?.by ?? plan.measures.find((m) => m !== "est_usd" || plan.wantsEstUsd) ?? plan.measures[0];
  const dir = plan.orderBy?.dir === "asc" ? 1 : -1;
  if (sortKey) {
    out.sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      if (typeof av === "number" && typeof bv === "number") return (av - bv) * dir;
      return String(av ?? "").localeCompare(String(bv ?? "")) * dir;
    });
  }
  const truncated = raw.length >= sql.limit || out.length > plan.outputLimit;
  out = out.slice(0, plan.outputLimit);
  return { mode: "aggregate", dataset: plan.dataset, rows: out, rowCount: out.length, truncated };
}

function shapeRow(r: Record<string, unknown>, plan: AnalyticsPlan): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const c of plan.rowColumns) {
    let v = r[c];
    if (v === null || v === undefined) continue;
    if (c === "surface_key" || c === "surface") v = maskSurface(v, r, plan, plan.dmUnmasked);
    out[c] = v;
  }
  if ("detail" in r && r.detail != null) {
    try {
      out.detail = typeof r.detail === "string" ? JSON.parse(r.detail) : r.detail;
    } catch {
      out.detail = r.detail;
    }
  }
  return out;
}
