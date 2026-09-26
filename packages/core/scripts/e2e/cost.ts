import { importAppModule } from "../../agent/scaffold/app-root.js";

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
  readonly excluded?: UsageWindowExcludedWire;
}

export interface UsageWindowExcludedWire {
  readonly surfaceKeys: readonly string[];
  readonly calls: number;
  readonly estimatedUsd: number;
  readonly unpricedModels: readonly string[];
  readonly sessionsUpperBound: number;
}

export interface UsageWindowWireRow {
  readonly surfaceKey: string;
  readonly model?: string;
  readonly calls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly estimatedUsd?: number;
}

export function buildCostReport(rows: readonly UsageWindowWireRow[], excluded?: UsageWindowExcludedWire): RunCostReport {
  const slices: UsageSlice[] = [];
  const unpriced = new Set<string>();
  let total = 0;
  for (const r of rows) {
    const model = r.model ?? "(unstamped)";
    if (r.estimatedUsd === undefined) unpriced.add(model);
    else total += r.estimatedUsd;
    slices.push({
      surfaceKey: r.surfaceKey,
      model,
      calls: r.calls,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      cacheReadTokens: r.cacheReadTokens,
      cacheWriteTokens: r.cacheWriteTokens,
      estimatedUsd: r.estimatedUsd,
    });
  }
  return { slices, totalUsd: total, unpricedModels: [...unpriced].sort(), ...(excluded ? { excluded } : {}) };
}

export async function fetchRunUsage(
  targetUrl: string,
  readToken: string,
  sinceIso: string,
  workspaceKeys: readonly string[],
  sessionStartedAfter?: string,
): Promise<{ readonly rows: readonly UsageWindowWireRow[]; readonly excluded?: UsageWindowExcludedWire }> {
  const base = targetUrl.replace(/\/+$/, "");
  const qs = new URLSearchParams({ since: sinceIso, workspaces: workspaceKeys.join(",") });
  if (sessionStartedAfter) qs.set("sessionStartedAfter", sessionStartedAfter);
  const res = await fetch(`${base}/control/v1/usage?${qs.toString()}`, {
    headers: { authorization: `Bearer ${readToken}`, accept: "application/json" },
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 200);
    throw new Error(`GET /control/v1/usage → ${res.status}${detail ? ` (${detail})` : ""}`);
  }
  const parsed = (await res.json()) as { rows?: UsageWindowWireRow[]; excluded?: UsageWindowExcludedWire };
  if (!Array.isArray(parsed.rows)) throw new Error("GET /control/v1/usage returned no rows array (malformed response)");
  return { rows: parsed.rows, ...(parsed.excluded ? { excluded: parsed.excluded } : {}) };
}

export async function defaultExpectedModels(root?: string): Promise<readonly string[]> {
  const { STACKS, SHIPPED_STACK, stackModelIds } = await importAppModule<typeof import("../../../../agent/model/stacks.js")>(
    "agent/model/stacks.ts",
    root,
  );
  return stackModelIds(STACKS[SHIPPED_STACK]);
}

export async function resolveExpectedModels(envValue: string | undefined): Promise<readonly string[]> {
  const explicit = (envValue ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return explicit.length > 0 ? explicit : await defaultExpectedModels();
}

export function checkExpectedModels(
  rows: readonly UsageWindowWireRow[],
  expected: readonly string[],
): { ok: boolean; seen: readonly string[]; unexpected: readonly string[] } {
  const expectedSet = new Set(expected);
  const modelCalls = rows.filter(
    (r) => r.model !== undefined || r.inputTokens + r.outputTokens + r.cacheReadTokens + r.cacheWriteTokens > 0,
  );
  const seen = [...new Set(modelCalls.map((r) => r.model ?? "(unstamped)"))].sort();
  const unexpected = seen.filter((m) => !expectedSet.has(m));
  return { ok: unexpected.length === 0, seen, unexpected };
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
  if (report.excluded === undefined) {
    lines.push("excluded by the run's session bound: not reported (the read carried no session bound, or the deployment predates the field)");
  } else if (report.excluded.calls === 0) {
    lines.push("excluded by the run's session bound: none — every session with usage in this window started inside it");
  } else {
    const e = report.excluded;
    lines.push(
      `🔴 excluded by the run's session bound: ${e.calls} call(s), ${fmtUsd(e.estimatedUsd)}` +
        (e.unpricedModels.length ? ` (+ unpriced: ${e.unpricedModels.join(", ")})` : "") +
        ` across up to ${e.sessionsUpperBound} session(s) on [${e.surfaceKeys.join(", ")}]` +
        " — a standing seat outlives a run, so its whole spend is dropped from the figure above",
    );
  }
  return lines;
}
