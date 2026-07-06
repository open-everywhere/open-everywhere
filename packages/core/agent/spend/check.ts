import { effectiveCaps } from "./caps.js";
import { checkCap, periodOf, type CapVerdict } from "./spend.js";
import { surfaceTokens, workspaceTokens } from "./store.js";
import { usageSummary } from "./usage-events.js";
import { resolveAssumedModel, rowCostUsd } from "./reporting.js";
import { domainKeyOf, type Partition } from "../memory/partition.js";
import type { SessionMode } from "../access/resolver.js";

export function monthStartISO(nowISO: string): string {
  return `${periodOf(nowISO)}-01T00:00:00.000Z`;
}

export interface ScopeUsdSpend {
  readonly surfaceUsd: number;
  readonly workspaceUsd: number;
}

export interface WorkspaceUsdSpend {
  readonly workspaceUsd: number;
  readonly bySurface: ReadonlyMap<string, number>;
}

function periodWindow(period: string): { sinceTs: string; untilTs: string } {
  const [y, m] = period.split("-").map(Number);
  return {
    sinceTs: `${period}-01T00:00:00.000Z`,
    untilTs: new Date(Date.UTC(y, m, 1) - 1).toISOString(),
  };
}

async function workspaceUsdSpendInWindow(org: string, workspaceKey: string, sinceTs: string, untilTs: string): Promise<WorkspaceUsdSpend> {
  const rows = await usageSummary(org, { surfaceKeyPrefix: `${workspaceKey}/`, sinceTs, untilTs });
  const assumed = resolveAssumedModel();
  let workspaceUsd = 0;
  const bySurface = new Map<string, number>();
  for (const r of rows) {
    const cost = rowCostUsd(r, assumed);
    if (cost === undefined) continue;
    workspaceUsd += cost;
    bySurface.set(r.surfaceKey, (bySurface.get(r.surfaceKey) ?? 0) + cost);
  }
  return { workspaceUsd, bySurface };
}

export async function workspaceUsdSpendForCurrentMonth(org: string, workspaceKey: string, nowISO: string): Promise<WorkspaceUsdSpend> {
  return workspaceUsdSpendInWindow(org, workspaceKey, monthStartISO(nowISO), nowISO);
}

export async function workspaceUsdSpendForPeriod(org: string, workspaceKey: string, period: string): Promise<WorkspaceUsdSpend> {
  const { sinceTs, untilTs } = periodWindow(period);
  return workspaceUsdSpendInWindow(org, workspaceKey, sinceTs, untilTs);
}

export async function scopeUsdSpend(org: string, workspaceKey: string, surfaceKey: string, nowISO: string): Promise<ScopeUsdSpend> {
  const { workspaceUsd, bySurface } = await workspaceUsdSpendForCurrentMonth(org, workspaceKey, nowISO);
  return { surfaceUsd: bySurface.get(surfaceKey) ?? 0, workspaceUsd };
}

export async function scopeOverBudget(p: Partition, mode: SessionMode, nowISO: string): Promise<CapVerdict> {
  const scopeKey = domainKeyOf(p);
  const caps = await effectiveCaps(p.org, p.workspaceKey, scopeKey);
  const tokenCapped = caps.surfaceMonthlyTokens != null || caps.workspaceMonthlyTokens != null;
  const usdCapped = caps.surfaceMonthlyUsd != null || caps.workspaceMonthlyUsd != null;
  if (!tokenCapped && !usdCapped) return { over: false };
  const period = periodOf(nowISO);
  const [st, wt] = tokenCapped
    ? await Promise.all([surfaceTokens(p.org, scopeKey, period), workspaceTokens(p.org, p.workspaceKey, period)])
    : [0, 0];
  const usd = usdCapped ? await scopeUsdSpend(p.org, p.workspaceKey, scopeKey, nowISO) : { surfaceUsd: 0, workspaceUsd: 0 };
  return checkCap({ mode, surfaceTokens: st, workspaceTokens: wt, surfaceUsd: usd.surfaceUsd, workspaceUsd: usd.workspaceUsd, caps });
}
