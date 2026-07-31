export type DatasetName = "audit" | "usage" | "spend";

export type TsBucket = "hour" | "day" | "week" | "month";

export type DimensionSpec =
  | { readonly kind: "column"; readonly column: string }
  | { readonly kind: "ts"; readonly column: string }
  | { readonly kind: "domain" };

export type MeasureSpec =
  | { readonly kind: "sql"; readonly expr: string }
  | { readonly kind: "est_usd" };

export interface DatasetSpec {
  readonly table: "audit_entry" | "usage_events" | "spend_ledger";
  readonly dims: Readonly<Record<string, DimensionSpec>>;
  readonly measures: Readonly<Record<string, MeasureSpec>>;
  readonly rowColumns: readonly string[];
  readonly surfaceColumn: string | null;
  readonly surfaceParts: readonly string[] | null;
  readonly principalColumn: string;
  readonly rowOrderColumn: string;
}

const AUDIT: DatasetSpec = {
  table: "audit_entry",
  dims: {
    ts: { kind: "ts", column: "ts" },
    platform: { kind: "column", column: "platform" },
    workspace: { kind: "column", column: "workspace" },
    surface: { kind: "column", column: "surface" },
    action: { kind: "column", column: "action" },
    principal: { kind: "column", column: "principal_id" },
    domain: { kind: "domain" },
  },
  measures: {
    rows: { kind: "sql", expr: "COUNT(*)" },
  },
  rowColumns: ["ts", "platform", "workspace", "surface", "principal_id", "action"],
  surfaceColumn: null,
  surfaceParts: ["platform", "workspace", "surface"],
  principalColumn: "principal_id",
  rowOrderColumn: "ts",
};

const USAGE: DatasetSpec = {
  table: "usage_events",
  dims: {
    ts: { kind: "ts", column: "ts" },
    surface: { kind: "column", column: "surface_key" },
    principal: { kind: "column", column: "principal_id" },
    kind: { kind: "column", column: "kind" },
    model: { kind: "column", column: "model" },
    session: { kind: "column", column: "session_id" },
    routine: { kind: "column", column: "routine_id" },
    domain: { kind: "domain" },
  },
  measures: {
    events: { kind: "sql", expr: "COUNT(*)" },
    input_tokens: { kind: "sql", expr: "SUM(input_tokens)" },
    output_tokens: { kind: "sql", expr: "SUM(output_tokens)" },
    cache_read_tokens: { kind: "sql", expr: "SUM(cache_read_tokens)" },
    cache_write_tokens: { kind: "sql", expr: "SUM(cache_write_tokens)" },
    sessions: { kind: "sql", expr: "COUNT(DISTINCT session_id)" },
    est_usd: { kind: "est_usd" },
  },
  rowColumns: ["ts", "surface_key", "principal_id", "kind", "routine_id", "model", "session_id", "input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens"],
  surfaceColumn: "surface_key",
  surfaceParts: null,
  principalColumn: "principal_id",
  rowOrderColumn: "ts",
};

const SPEND: DatasetSpec = {
  table: "spend_ledger",
  dims: {
    period: { kind: "column", column: "period" },
    surface: { kind: "column", column: "surface_key" },
    principal: { kind: "column", column: "principal_id" },
    routine: { kind: "column", column: "routine_id" },
    model: { kind: "column", column: "model" },
    domain: { kind: "domain" },
  },
  measures: {
    input_tokens: { kind: "sql", expr: "SUM(input_tokens)" },
    output_tokens: { kind: "sql", expr: "SUM(output_tokens)" },
    cache_read_tokens: { kind: "sql", expr: "SUM(cache_read_tokens)" },
    cache_write_tokens: { kind: "sql", expr: "SUM(cache_write_tokens)" },
    calls: { kind: "sql", expr: "SUM(calls)" },
    usd: { kind: "sql", expr: "SUM(usd_micros) / 1000000.0" },
  },
  rowColumns: ["period", "surface_key", "principal_id", "routine_id", "model", "input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens", "usd_micros", "calls"],
  surfaceColumn: "surface_key",
  surfaceParts: null,
  principalColumn: "principal_id",
  rowOrderColumn: "period",
};

export const DATASETS: Readonly<Record<DatasetName, DatasetSpec>> = { audit: AUDIT, usage: USAGE, spend: SPEND };

export const DATASET_NAMES = Object.keys(DATASETS) as DatasetName[];

export function dimNames(dataset: DatasetName): string[] {
  return Object.keys(DATASETS[dataset].dims);
}

export function measureNames(dataset: DatasetName): string[] {
  return Object.keys(DATASETS[dataset].measures);
}

export function hasTsDimension(dataset: DatasetName): boolean {
  return Object.values(DATASETS[dataset].dims).some((d) => d.kind === "ts");
}

export function schemaCard(): string {
  const lines: string[] = [];
  for (const name of DATASET_NAMES) {
    const spec = DATASETS[name];
    lines.push(`dataset ${name} (table ${spec.table})`);
    lines.push(`  dims:     ${dimNames(name).join(", ")}`);
    lines.push(`  measures: ${measureNames(name).join(", ")}`);
  }
  return lines.join("\n");
}
