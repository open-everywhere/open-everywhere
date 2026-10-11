export type DatasetName = "audit" | "usage" | "spend" | "tools";

export type TsBucket = "hour" | "day" | "week" | "month";

export type DimensionSpec =
  | { readonly kind: "column"; readonly column: string }
  | { readonly kind: "ts"; readonly column: string }
  | { readonly kind: "domain" };

export type MeasureSpec =
  | { readonly kind: "sql"; readonly expr: string }
  | { readonly kind: "est_usd" };

export interface DatasetSpec {
  readonly table: "audit_entry" | "usage_events" | "spend_ledger" | "tool_usage";
  readonly dims: Readonly<Record<string, DimensionSpec>>;
  readonly measures: Readonly<Record<string, MeasureSpec>>;
  readonly rowColumns: readonly string[];
  readonly surfaceColumn: string | null;
  readonly surfaceModeColumn: string;
  readonly surfaceKindColumn: string | null;
  readonly surfaceParts: readonly string[] | null;
  readonly principalColumn: string;
  readonly platformColumn: string | null;
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
  rowColumns: ["ts", "platform", "workspace", "surface", "surface_mode", "principal_id", "action"],
  surfaceColumn: null,
  surfaceModeColumn: "surface_mode",
  surfaceKindColumn: null,
  surfaceParts: ["platform", "workspace", "surface"],
  principalColumn: "principal_id",
  platformColumn: "platform",
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
    depth: { kind: "column", column: "delegation_depth" },
    root_session: { kind: "column", column: "root_session_id" },
    cost_source: { kind: "column", column: "cost_source" },
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
    measured_usd: { kind: "sql", expr: "SUM(COALESCE(usd_micros_measured, 0)) / 1000000.0" },
    reasoning_tokens: { kind: "sql", expr: "SUM(COALESCE(reasoning_tokens, 0))" },
    reasoning_reported_calls: { kind: "sql", expr: "COUNT(reasoning_tokens)" },
    cache_reported_calls: { kind: "sql", expr: "SUM(CASE WHEN cache_tokens_reported THEN 1 ELSE 0 END)" },
  },
  rowColumns: [
    "ts",
    "surface_key",
    "principal_id",
    "kind",
    "surface_mode",
    "routine_id",
    "model",
    "session_id",
    "input_tokens",
    "output_tokens",
    "cache_read_tokens",
    "cache_write_tokens",
    "cache_tokens_reported",
    "reasoning_tokens",
    "usd_micros_measured",
    "cost_source",
    "delegation_depth",
    "root_session_id",
  ],
  surfaceColumn: "surface_key",
  surfaceModeColumn: "surface_mode",
  surfaceKindColumn: "kind",
  surfaceParts: null,
  principalColumn: "principal_id",
  platformColumn: null,
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
    cost_source: { kind: "column", column: "cost_source" },
    domain: { kind: "domain" },
  },
  measures: {
    input_tokens: { kind: "sql", expr: "SUM(input_tokens)" },
    output_tokens: { kind: "sql", expr: "SUM(output_tokens)" },
    cache_read_tokens: { kind: "sql", expr: "SUM(cache_read_tokens)" },
    cache_write_tokens: { kind: "sql", expr: "SUM(cache_write_tokens)" },
    calls: { kind: "sql", expr: "SUM(calls)" },
    usd: { kind: "sql", expr: "SUM(usd_micros) / 1000000.0" },
    usd_measured: { kind: "sql", expr: "SUM(usd_micros_measured) / 1000000.0" },
    reasoning_tokens: { kind: "sql", expr: "SUM(reasoning_tokens)" },
  },
  rowColumns: [
    "period",
    "surface_key",
    "principal_id",
    "surface_mode",
    "routine_id",
    "model",
    "cost_source",
    "input_tokens",
    "output_tokens",
    "cache_read_tokens",
    "cache_write_tokens",
    "reasoning_tokens",
    "usd_micros",
    "usd_micros_measured",
    "calls",
  ],
  surfaceColumn: "surface_key",
  surfaceModeColumn: "surface_mode",
  surfaceKindColumn: null,
  surfaceParts: null,
  principalColumn: "principal_id",
  platformColumn: null,
  rowOrderColumn: "period",
};

const TOOLS: DatasetSpec = {
  table: "tool_usage",
  dims: {
    ts: { kind: "ts", column: "ts" },
    surface: { kind: "column", column: "surface_key" },
    principal: { kind: "column", column: "principal_id" },
    session: { kind: "column", column: "session_id" },
    connector: { kind: "column", column: "connector" },
    tool: { kind: "column", column: "tool" },
    outcome: { kind: "column", column: "outcome" },
    model: { kind: "column", column: "model" },
    domain: { kind: "domain" },
  },
  measures: {
    calls: { kind: "sql", expr: "SUM(CASE WHEN event = 'call' THEN 1 ELSE 0 END)" },
    errors: { kind: "sql", expr: "SUM(CASE WHEN event = 'call' AND outcome = 'error' THEN 1 ELSE 0 END)" },
    rejected: { kind: "sql", expr: "SUM(CASE WHEN event = 'call' AND outcome = 'rejected' THEN 1 ELSE 0 END)" },
    cards: { kind: "sql", expr: "SUM(CASE WHEN event = 'card' THEN 1 ELSE 0 END)" },
    input_tokens: { kind: "sql", expr: "SUM(input_tokens)" },
    output_tokens: { kind: "sql", expr: "SUM(output_tokens)" },
    cache_read_tokens: { kind: "sql", expr: "SUM(cache_read_tokens)" },
    est_usd: { kind: "est_usd" },
  },
  rowColumns: ["ts", "surface_key", "surface_mode", "principal_id", "session_id", "event", "connector", "tool", "outcome", "model", "input_tokens", "output_tokens", "cache_read_tokens"],
  surfaceColumn: "surface_key",
  surfaceModeColumn: "surface_mode",
  surfaceKindColumn: null,
  surfaceParts: null,
  principalColumn: "principal_id",
  platformColumn: null,
  rowOrderColumn: "ts",
};

export const DATASETS: Readonly<Record<DatasetName, DatasetSpec>> = { audit: AUDIT, usage: USAGE, spend: SPEND, tools: TOOLS };

export const DATASET_NAMES = Object.keys(DATASETS) as DatasetName[];

function dimNames(dataset: DatasetName): string[] {
  return Object.keys(DATASETS[dataset].dims);
}

function measureNames(dataset: DatasetName): string[] {
  return Object.keys(DATASETS[dataset].measures);
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
