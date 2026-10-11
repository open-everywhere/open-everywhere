import { z } from "zod";
import { DATASETS, DATASET_NAMES, type DatasetName, type DatasetSpec, type TsBucket } from "./registry.js";
import type { AnalyticsScope } from "../access/analytics-scope.js";
import type { CompiledAnalyticsQuery } from "../operational/store.js";
import { domainForChannel, criteriaDomain, domainRoster, type Domain } from "../memory/domain.js";

export type { CompiledAnalyticsQuery } from "../operational/store.js";

const ALL_DIMS = [...new Set(DATASET_NAMES.flatMap((d) => Object.keys(DATASETS[d].dims)))] as [string, ...string[]];
const ALL_MEASURES = [...new Set(DATASET_NAMES.flatMap((d) => Object.keys(DATASETS[d].measures)))] as [string, ...string[]];

export const analyticsQuerySchema = z.object({
  dataset: z.enum(DATASET_NAMES as [DatasetName, ...DatasetName[]]),
  scope: z.enum(["org", "domain", "self"]),
  mode: z.enum(["aggregate", "rows"]).default("aggregate"),
  select: z.array(z.enum(ALL_MEASURES)).optional().describe("measures (aggregate mode)"),
  groupBy: z.array(z.enum(ALL_DIMS)).optional(),
  filters: z
    .array(
      z.object({
        dim: z.enum(ALL_DIMS),
        op: z.enum(["eq", "in", "prefix"]),
        value: z.union([z.string(), z.array(z.string())]),
      }),
    )
    .optional(),
  since: z.string().optional().describe("ISO-8601 lower bound on ts (audit/usage/tools)"),
  until: z.string().optional().describe("ISO-8601 upper bound on ts (audit/usage/tools)"),
  tsBucket: z.enum(["hour", "day", "week", "month"]).optional().describe('bucket for the "ts" group dimension (default day)'),
  orderBy: z.object({ by: z.enum([...ALL_DIMS, ...ALL_MEASURES] as [string, ...string[]]), dir: z.enum(["asc", "desc"]) }).optional(),
  limit: z.number().int().positive().optional(),
});

export type AnalyticsQuery = z.infer<typeof analyticsQuerySchema>;

const AGGREGATE_LIMIT_MAX = 200;
export const ROWS_LIMIT_MAX = 100;
export const AGGREGATE_SCAN_CAP = 5000;
const MAX_WINDOW_DAYS = 365;

export type OutputDimKind = "column" | "ts" | "domain";
export interface OutputDim {
  readonly name: string;
  readonly kind: OutputDimKind;
  readonly column?: string;
  readonly tsBucket?: TsBucket;
}

export interface AnalyticsPlan {
  readonly mode: "aggregate" | "rows";
  readonly dataset: DatasetName;
  readonly outputDims: readonly OutputDim[];
  readonly measures: readonly string[];
  readonly wantsEstUsd: boolean;
  readonly dmUnmasked: boolean;
  readonly rowColumns: readonly string[];
  readonly outputLimit: number;
  readonly surfaceColumn: string | null;
  readonly surfaceParts: readonly string[] | null;
  readonly surfaceModeColumn: string;
  readonly surfaceKindColumn: string | null;
  readonly orderBy?: { readonly by: string; readonly dir: "asc" | "desc" };
}

export interface CompiledAnalytics {
  readonly sql: CompiledAnalyticsQuery;
  readonly plan: AnalyticsPlan;
}

function tsSubstrLen(bucket: TsBucket): number {
  switch (bucket) {
    case "hour":
      return 13;
    case "month":
      return 7;
    case "day":
    case "week":
      return 10;
  }
}

function domainChannels(domainName: string, domains: readonly Domain[]): string[] {
  const d = domains.find((x) => x.name === domainName);
  return d ? domainRoster(d) : [];
}

function channelScopeConjunct(spec: DatasetSpec, channels: readonly string[], params: unknown[]): string {
  if (channels.length === 0) return "1 = 0";
  if (spec.surfaceColumn) {
    const placeholders = channels.map(() => "?").join(", ");
    params.push(...channels);
    return `${spec.surfaceColumn} IN (${placeholders})`;
  }
  const parts = spec.surfaceParts!;
  const ors = channels.map((key) => {
    const seg = key.split("/");
    const platform = seg[0] ?? "";
    const workspace = seg[1] ?? "";
    const surface = seg.slice(2).join("/");
    params.push(platform, workspace, surface);
    return `(${parts[0]} = ? AND ${parts[1]} = ? AND ${parts[2]} = ?)`;
  });
  return `(${ors.join(" OR ")})`;
}

function selfPlatformConjunct(spec: DatasetSpec, platform: string, params: unknown[]): string {
  if (spec.platformColumn) {
    params.push(platform);
    return `${spec.platformColumn} = ?`;
  }
  if (spec.surfaceColumn) {
    params.push(`${platform}/`);
    return `${spec.surfaceColumn} LIKE (? || '%')`;
  }
  return "1 = 0";
}

export function compileAnalyticsQuery(input: AnalyticsQuery, scope: AnalyticsScope, domains: readonly Domain[]): CompiledAnalytics {
  const dataset = input.dataset;
  const spec = DATASETS[dataset];
  const mode = input.mode;

  if (mode === "rows" && !scope.rowMode) {
    throw new Error(`rows mode isn't available at your standing for this scope (aggregates only). Use mode "aggregate", or ask an org/domain admin. (scope=${scope.grain})`);
  }

  const where: string[] = [];
  const params: unknown[] = [];

  where.push("org_id = ?");
  params.push(scope.org);
  if (scope.grain === "domain") {
    where.push(channelScopeConjunct(spec, domainChannels(scope.domain!, domains), params));
  } else if (scope.grain === "self") {
    if (!scope.platform) {
      throw new Error('analytics scope "self" carries no platform — a bare principal id names no namespace, so the read cannot be compiled (access/analytics-scope.ts).');
    }
    where.push(`${spec.principalColumn} = ?`);
    params.push(scope.principalId);
    where.push(selfPlatformConjunct(spec, scope.platform, params));
  }

  const tsCol = Object.values(spec.dims).find((d) => d.kind === "ts")?.kind === "ts" ? (spec.dims.ts as { column: string } | undefined)?.column : undefined;
  if (tsCol) {
    if (input.since !== undefined && input.until !== undefined) {
      const spanMs = Date.parse(input.until) - Date.parse(input.since);
      if (Number.isFinite(spanMs) && spanMs > MAX_WINDOW_DAYS * 86_400_000) {
        throw new Error(`the query window exceeds the ${MAX_WINDOW_DAYS}-day maximum — narrow "since"/"until".`);
      }
    }
    if (input.since !== undefined) {
      where.push(`${tsCol} >= ?`);
      params.push(input.since);
    }
    if (input.until !== undefined) {
      where.push(`${tsCol} <= ?`);
      params.push(input.until);
    }
  }

  for (const f of input.filters ?? []) {
    const dim = spec.dims[f.dim];
    if (!dim) throw new Error(`filter dimension "${f.dim}" isn't available on dataset "${dataset}" (valid: ${Object.keys(spec.dims).join(", ")}).`);
    if (dim.kind === "domain") {
      const names = Array.isArray(f.value) ? f.value : [f.value];
      const chans = names.flatMap((n) => domainChannels(n, domains));
      where.push(channelScopeConjunct(spec, chans, params));
      continue;
    }
    const col = dim.column!;
    if (f.op === "eq") {
      const v = Array.isArray(f.value) ? f.value[0] : f.value;
      where.push(`${col} = ?`);
      params.push(v);
    } else if (f.op === "in") {
      const vals = Array.isArray(f.value) ? f.value : [f.value];
      if (vals.length === 0) {
        where.push("1 = 0");
      } else {
        where.push(`${col} IN (${vals.map(() => "?").join(", ")})`);
        params.push(...vals);
      }
    } else {
      const v = Array.isArray(f.value) ? f.value[0] : f.value;
      where.push(`${col} LIKE (? || '%')`);
      params.push(v);
    }
  }

  if (mode === "rows") {
    const cols = [...spec.rowColumns];
    if (dataset === "audit" && scope.auditDetail) cols.push("detail");
    const select = cols.map((c) => ({ expr: c, alias: c }));
    return {
      sql: {
        table: spec.table,
        select,
        groupBy: [],
        where,
        params,
        orderBy: { expr: spec.rowOrderColumn, dir: "DESC" },
        limit: Math.min(input.limit ?? ROWS_LIMIT_MAX, ROWS_LIMIT_MAX),
      },
      plan: {
        mode,
        dataset,
        outputDims: [],
        measures: [],
        wantsEstUsd: false,
        dmUnmasked: scope.dmUnmasked,
        rowColumns: cols,
        outputLimit: Math.min(input.limit ?? ROWS_LIMIT_MAX, ROWS_LIMIT_MAX),
        surfaceColumn: spec.surfaceColumn,
        surfaceParts: spec.surfaceParts,
        surfaceModeColumn: spec.surfaceModeColumn,
        surfaceKindColumn: spec.surfaceKindColumn,
      },
    };
  }

  const groupDims = input.groupBy ?? [];
  const measures = input.select && input.select.length > 0 ? input.select : [Object.keys(spec.measures)[0]!];
  for (const m of measures) {
    if (!spec.measures[m]) throw new Error(`measure "${m}" isn't available on dataset "${dataset}" (valid: ${Object.keys(spec.measures).join(", ")}).`);
  }
  for (const g of groupDims) {
    if (!spec.dims[g]) throw new Error(`dimension "${g}" isn't available on dataset "${dataset}" (valid: ${Object.keys(spec.dims).join(", ")}).`);
  }

  const tsBucket: TsBucket = input.tsBucket ?? "day";
  const wantsEstUsd = measures.includes("est_usd");

  const sqlGroup: { expr: string; alias: string }[] = [];
  const outputDims: OutputDim[] = [];
  const seen = new Set<string>();
  const addGroup = (expr: string, alias: string) => {
    if (seen.has(alias)) return;
    seen.add(alias);
    sqlGroup.push({ expr, alias });
  };

  for (const g of groupDims) {
    const dim = spec.dims[g];
    if (dim.kind === "column") {
      addGroup(dim.column, dim.column);
      outputDims.push({ name: g, kind: "column", column: dim.column });
    } else if (dim.kind === "ts") {
      addGroup(`substr(${dim.column}, 1, ${tsSubstrLen(tsBucket)})`, "ts");
      outputDims.push({ name: g, kind: "ts", column: dim.column, tsBucket });
    } else {
      if (spec.surfaceColumn) addGroup(spec.surfaceColumn, spec.surfaceColumn);
      else for (const p of spec.surfaceParts!) addGroup(p, p);
      outputDims.push({ name: g, kind: "domain", column: spec.surfaceColumn ?? undefined });
    }
  }
  if (wantsEstUsd && spec.dims.model?.kind === "column") addGroup((spec.dims.model as { column: string }).column, "model");
  if (groupDims.includes("surface")) addGroup(spec.surfaceModeColumn, spec.surfaceModeColumn);

  const sqlMeasureNames = new Set(measures.filter((m) => spec.measures[m]?.kind === "sql"));
  if (wantsEstUsd) for (const t of ["input_tokens", "output_tokens", "cache_read_tokens"]) if (spec.measures[t]) sqlMeasureNames.add(t);
  const sqlMeasures = [...sqlMeasureNames].map((m) => ({ expr: (spec.measures[m] as { expr: string }).expr, alias: m }));

  const select = [...sqlGroup, ...sqlMeasures];
  return {
    sql: {
      table: spec.table,
      select,
      groupBy: sqlGroup.map((g) => g.expr),
      where,
      params,
      orderBy: null,
      limit: AGGREGATE_SCAN_CAP,
    },
    plan: {
      mode,
      dataset,
      outputDims,
      measures,
      wantsEstUsd,
      dmUnmasked: scope.dmUnmasked,
      rowColumns: spec.rowColumns,
      outputLimit: Math.min(input.limit ?? AGGREGATE_LIMIT_MAX, AGGREGATE_LIMIT_MAX),
      surfaceColumn: spec.surfaceColumn,
      surfaceParts: spec.surfaceParts,
      surfaceModeColumn: spec.surfaceModeColumn,
      surfaceKindColumn: spec.surfaceKindColumn,
      ...(input.orderBy ? { orderBy: input.orderBy } : {}),
    },
  };
}

export function assembleAnalyticsSql(q: CompiledAnalyticsQuery, style: "qmark" | "dollar"): { sql: string; params: unknown[] } {
  const selectSql = q.select.map((s) => `${s.expr} AS ${s.alias}`).join(", ");
  const whereSql = q.where.length ? `WHERE ${q.where.join(" AND ")}` : "";
  const groupSql = q.groupBy.length ? `GROUP BY ${q.groupBy.join(", ")}` : "";
  const orderSql = q.orderBy ? `ORDER BY ${q.orderBy.expr} ${q.orderBy.dir}` : "";
  const limit = Math.max(0, Math.trunc(q.limit));
  let sql = `SELECT ${selectSql} FROM ${q.table} ${whereSql} ${groupSql} ${orderSql} LIMIT ${limit}`.replace(/\s+/g, " ").trim();
  if (style === "dollar") {
    let i = 0;
    sql = sql.replace(/\?/g, () => `$${++i}`);
  }
  return { sql, params: [...q.params] };
}

export function isoWeekStart(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return day;
  const dow = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}

export function domainOfRow(row: Record<string, unknown>, plan: AnalyticsPlan, domains: readonly Domain[]): string {
  let key: string | undefined;
  if (plan.surfaceColumn) {
    const v = row[plan.surfaceColumn];
    key = typeof v === "string" ? v : undefined;
  } else if (plan.surfaceParts) {
    const parts = plan.surfaceParts.map((p) => String(row[p] ?? ""));
    key = parts.join("/");
  }
  if (!key) return "(unassigned)";
  const explicit = domainForChannel(key, domains);
  if (explicit) return explicit.name;
  return criteriaDomain("org", domains)?.name ?? "(unassigned)";
}
