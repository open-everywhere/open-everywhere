import { effectiveCaps } from "./caps.js";
import { checkCap, periodOf, type CapVerdict } from "./spend.js";
import { surfaceTokens, workspaceTokens } from "./store.js";
import { usageSummary } from "./usage-events.js";
import { resolveAssumedModel, rowCostUsd } from "./reporting.js";
import type { Partition } from "../memory/partition.js";
import type { SessionMode } from "../access/resolver.js";

export function monthStartISO(nowISO: string): string {
  return `${periodOf(nowISO)}-01T00:00:00.000Z`;
}

export interface ScopeUsdSpend {
  readonly surfaceUsd: number;
  readonly workspaceUsd: number;
}

export async function scopeUsdSpend(org: string, workspaceKey: string, surfaceKey: string, nowISO: string): Promise<ScopeUsdSpend> {
  const rows = await usageSummary(org, {
    surfaceKeyPrefix: `${workspaceKey}/`,
    sinceTs: monthStartISO(nowISO),
    untilTs: nowISO,
  });
  const assumed = resolveAssumedModel();
  let surfaceUsd = 0;
  let workspaceUsd = 0;
  for (const r of rows) {
    const cost = rowCostUsd(r, assumed);
    if (cost === undefined) continue;
    workspaceUsd += cost;
    if (r.surfaceKey === surfaceKey) surfaceUsd += cost;
  }
  return { surfaceUsd, workspaceUsd };
}

export async function scopeOverBudget(p: Partition, mode: SessionMode, nowISO: string): Promise<CapVerdict> {
  const caps = await effectiveCaps(p.org, p.workspaceKey, p.surfaceKey);
  const tokenCapped = caps.surfaceMonthlyTokens != null || caps.workspaceMonthlyTokens != null;
  const usdCapped = caps.surfaceMonthlyUsd != null || caps.workspaceMonthlyUsd != null;
  if (!tokenCapped && !usdCapped) return { over: false };
  const period = periodOf(nowISO);
  const [st, wt] = tokenCapped
    ? await Promise.all([surfaceTokens(p.org, p.surfaceKey, period), workspaceTokens(p.org, p.workspaceKey, period)])
    : [0, 0];
  const usd = usdCapped ? await scopeUsdSpend(p.org, p.workspaceKey, p.surfaceKey, nowISO) : { surfaceUsd: 0, workspaceUsd: 0 };
  return checkCap({ mode, surfaceTokens: st, workspaceTokens: wt, surfaceUsd: usd.surfaceUsd, workspaceUsd: usd.workspaceUsd, caps });
}
