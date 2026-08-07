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

export function buildCostReport(rows: readonly UsageWindowWireRow[]): RunCostReport {
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
  return { slices, totalUsd: total, unpricedModels: [...unpriced].sort() };
}

export async function fetchRunUsage(
  targetUrl: string,
  readToken: string,
  sinceIso: string,
  workspaceKeys: readonly string[],
): Promise<readonly UsageWindowWireRow[]> {
  const base = targetUrl.replace(/\/+$/, "");
  const qs = new URLSearchParams({ since: sinceIso, workspaces: workspaceKeys.join(",") });
  const res = await fetch(`${base}/control/v1/usage?${qs.toString()}`, {
    headers: { authorization: `Bearer ${readToken}`, accept: "application/json" },
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 200);
    throw new Error(`GET /control/v1/usage → ${res.status}${detail ? ` (${detail})` : ""}`);
  }
  const parsed = (await res.json()) as { rows?: UsageWindowWireRow[] };
  if (!Array.isArray(parsed.rows)) throw new Error("GET /control/v1/usage returned no rows array (malformed response)");
  return parsed.rows;
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
  return lines;
}
