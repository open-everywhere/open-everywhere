import type { AuditEntry } from "../../operational/store.js";

export const FAILURE_ACTIONS = [
  "surface.quiet_fail",
  "turn.bare_stop",
  "webhook.rejected",
  "spend.cap_bypassed",
  "approval.failed",
  "unified.supervisor_turn_failed",
  "unified.supervisor_session_failed",
] as const;

export type FailureAction = (typeof FAILURE_ACTIONS)[number];

const FAILURE_ACTION_SET: ReadonlySet<string> = new Set(FAILURE_ACTIONS);

export function isFailureAction(action: string): action is FailureAction {
  return FAILURE_ACTION_SET.has(action);
}

export interface FailureCluster {
  readonly action: string;
  readonly count: number;
  readonly examples: readonly string[];
}

export interface BucketOptions {
  readonly maxClusters?: number;
  readonly maxExamplesPerCluster?: number;
  readonly surfaceName?: SurfaceNamer;
  readonly cluster?: FailureClusterer;
}

export type FailureClusterer = (rows: readonly AuditEntry[], opts: BucketOptions) => FailureCluster[];

export type SurfaceNamer = (row: AuditEntry) => string | undefined;

export function exampleLine(row: AuditEntry, name?: SurfaceNamer): string {
  const resolved = name?.(row);
  const where = resolved
    ? `${row.platform} ${resolved}${row.surface ? ` (${row.surface})` : ""}`
    : `${row.platform} ${row.surface ? `${row.workspace}/${row.surface}` : row.workspace}`;
  const d = row.detail ?? {};
  switch (row.action) {
    case "surface.quiet_fail":
      return `${where}: ${String(d["event"] ?? "quiet-fail")} — ${String(d["message"] ?? "(no message)")}`;
    case "turn.bare_stop":
      return `${where}: turn ended with no reply, no react, and no no_reply (thread ${String(d["threadTs"] ?? "?")})`;
    case "webhook.rejected":
      return `${where}: hook "${String(d["hookId"] ?? "?")}" rejected (${String(d["status"] ?? "?")} — ${String(d["reason"] ?? "unknown reason")})`;
    case "spend.cap_bypassed":
      return `${where}: spend cap bypassed (${String(d["standing"] ?? "?")})${d["reason"] ? ` — ${String(d["reason"])}` : ""}`;
    case "approval.failed":
      return `${where}: "${String(d["kind"] ?? "?")}" approval execute() failed — ${String(d["error"] ?? "(no error)")}`;
    case "unified.supervisor_turn_failed":
    case "unified.supervisor_session_failed":
      return `${where}: ${row.action === "unified.supervisor_turn_failed" ? "supervisor turn failed" : "supervisor session failed"} — ${String(d["message"] ?? "(no message)")}${failureDiagSuffix(d)}`;
    default:
      return `${where}: ${row.action}`;
  }
}

const FAILURE_DIAG_KEYS = [
  "code",
  "errorId",
  "name",
  "statusCode",
  "generationId",
  "gatewayName",
  "gatewayType",
  "upstreamType",
  "upstreamStatusCode",
  "upstreamMessage",
] as const;

function failureDiagSuffix(d: Record<string, unknown>): string {
  const parts = FAILURE_DIAG_KEYS.filter((k) => d[k] !== undefined).map((k) => `${k}=${String(d[k])}`);
  return parts.length > 0 ? ` [${parts.join(" ")}]` : "";
}

export function groupFailuresByAction(rows: readonly AuditEntry[]): Map<string, AuditEntry[]> {
  const byAction = new Map<string, AuditEntry[]>();
  for (const row of rows) {
    if (!isFailureAction(row.action)) continue;
    const list = byAction.get(row.action);
    if (list) list.push(row);
    else byAction.set(row.action, [row]);
  }
  return byAction;
}

export function bucketFailures(rows: readonly AuditEntry[], opts: BucketOptions = {}): FailureCluster[] {
  const maxClusters = opts.maxClusters ?? 3;
  const maxExamples = opts.maxExamplesPerCluster ?? 3;
  return Array.from(groupFailuresByAction(rows).entries())
    .map(([action, entries]) => ({
      action,
      count: entries.length,
      examples: entries.slice(0, maxExamples).map((row) => exampleLine(row, opts.surfaceName)),
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, maxClusters);
}

export const FACET_LABEL_MAX = 120;
export const FACET_SKETCH_MAX = 300;

export interface FailureFacet {
  readonly label: string;
  readonly fixSketch: string;
}

const STATIC_FACET: Record<FailureAction, FailureFacet> = {
  "surface.quiet_fail": {
    label: "Uninvited-turn failures suppressed on-surface",
    fixSketch: "Check upstream model/gateway reliability for uninvited (name-drop) turns; consider whether that surface's retry/backoff needs tightening.",
  },
  "turn.bare_stop": {
    label: "Turn ended with no reply, react, or no_reply",
    fixSketch: "Usually a missing judgment call, not a deliberate one — review NO_REPLY/no_reply tool coverage or clarify the dispatch prompt for this case.",
  },
  "webhook.rejected": {
    label: "Inbound webhook deliveries rejected",
    fixSketch: "Check the failing hook id's HMAC secret provisioning and trusted-host allow-list.",
  },
  "spend.cap_bypassed": {
    label: "Admin spend-cap bypasses",
    fixSketch: "Review whether the surface's spend cap is sized correctly, or whether the bypass rate signals a cap that's too tight for normal usage.",
  },
  "approval.failed": {
    label: "Approved actions failing at execute()",
    fixSketch: "Inspect the failing ActionKind's execute() error — likely an external dependency hiccup (GitHub/Slack) or a stale frozen arg.",
  },
  "unified.supervisor_turn_failed": {
    label: "Unified-supervisor turn failures",
    fixSketch: "Check the example's statusCode/gatewayType/upstreamType — a gateway 4xx/5xx names the failing provider; an EmptyModelResponse has no provider to attribute and may instead need a retry/backoff tweak.",
  },
  "unified.supervisor_session_failed": {
    label: "Unified-supervisor session failures",
    fixSketch:
      "Same diagnostic fields as a turn failure. Nothing rotates the seat in response — read the row's `unresumable` label first: TRUE names a session the runtime can never resume (rotate the window), FALSE points at a bad delegated route or a persistently unhealthy provider.",
  },
};

function staticFacet(action: string): FailureFacet {
  return (STATIC_FACET as Record<string, FailureFacet>)[action] ?? {
    label: action,
    fixSketch: "No static fix-sketch on file for this action — inspect the example occurrences directly.",
  };
}

function extractJSON(text: string): unknown | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

export function facetPrompt(cluster: FailureCluster): string {
  return [
    "You are triaging a week of recorded failures from an AI agent harness (not memory content — a",
    "code-level reliability review).",
    `Failure action: "${cluster.action}" — ${cluster.count} occurrence(s) this week.`,
    "Example occurrences:",
    ...cluster.examples.map((e) => `- ${e}`),
    "",
    "Write a short label (<=8 words) naming the failure pattern, and ONE concrete sentence",
    "suggesting a harness/prompt/skill/config change a human could investigate or make.",
    'Reply with STRICT JSON only, no prose: {"label": "…", "fixSketch": "…"}',
  ].join("\n");
}

export function parseFailureFacet(text: string): FailureFacet | null {
  const raw = extractJSON(text);
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o["label"] !== "string" || o["label"].trim().length === 0) return null;
  if (typeof o["fixSketch"] !== "string" || o["fixSketch"].trim().length === 0) return null;
  return { label: o["label"].trim().slice(0, FACET_LABEL_MAX), fixSketch: o["fixSketch"].trim().slice(0, FACET_SKETCH_MAX) };
}

export type FacetCompletion = (scope: string, prompt: string) => Promise<string>;

export interface FailureFacetJudge {
  facet(scope: string, cluster: FailureCluster): Promise<FailureFacet | null>;
}

export function facetJudgeFromCompletion(complete: FacetCompletion): FailureFacetJudge {
  return {
    async facet(scope, cluster) {
      try {
        return parseFailureFacet(await complete(scope, facetPrompt(cluster)));
      } catch {
        return null;
      }
    },
  };
}

let registeredFacetJudge: FailureFacetJudge | null = null;

export function registerFailureFacetJudge(judge: FailureFacetJudge): void {
  registeredFacetJudge = judge;
}

function failureFacetJudge(): FailureFacetJudge | null {
  return registeredFacetJudge;
}

export interface Mode3ClusterReport extends FailureCluster {
  readonly label: string;
  readonly fixSketch: string;
  readonly judged: boolean;
}

export interface Mode3Report {
  readonly org: string;
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly totalFailures: number;
  readonly clusters: readonly Mode3ClusterReport[];
}

export async function buildMode3Report(
  org: string,
  rows: readonly AuditEntry[],
  windowStart: string,
  windowEnd: string,
  opts: BucketOptions = {},
): Promise<Mode3Report | null> {
  const clusters = (opts.cluster ?? bucketFailures)(rows, opts);
  if (clusters.length === 0) return null;

  const judge = failureFacetJudge();
  const shaped: Mode3ClusterReport[] = [];
  for (const c of clusters) {
    let facet: FailureFacet | null = null;
    if (judge) {
      try {
        facet = await judge.facet(org, c);
      } catch {
        facet = null;
      }
    }
    const chosen = facet ?? staticFacet(c.action);
    shaped.push({ ...c, label: chosen.label.slice(0, FACET_LABEL_MAX), fixSketch: chosen.fixSketch.slice(0, FACET_SKETCH_MAX), judged: facet !== null });
  }

  const totalFailures = rows.filter((r) => isFailureAction(r.action)).length;
  return { org, windowStart, windowEnd, totalFailures, clusters: shaped };
}

const DISCOVERY_ONLY_FOOTER =
  "_Discovery only — no PR opened this run. A human picks which fix sketch, if any, to act on._";

export function formatMode3Report(report: Mode3Report, footer: string = DISCOVERY_ONLY_FOOTER): string {
  const lines = [
    `:microscope: *Weekly failure digest* (${report.windowStart.slice(0, 10)} → ${report.windowEnd.slice(0, 10)}) — ` +
      `${report.totalFailures} failure event(s), top ${report.clusters.length} cluster(s):`,
  ];
  report.clusters.forEach((c, i) => {
    lines.push(`${i + 1}. *${c.label}* (\`${c.action}\`, ${c.count}×) — ${c.fixSketch}`);
    if (c.examples[0]) lines.push(`   e.g. ${c.examples[0]}`);
  });
  lines.push(footer);
  return lines.join("\n");
}
