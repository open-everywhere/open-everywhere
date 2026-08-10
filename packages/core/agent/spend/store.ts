import { domainKeyOf, type Partition } from "../memory/partition.js";
import { billableTokens, type Usage } from "./spend.js";
import { ensurePricingFor, usdMicrosAtWrite } from "./pricing.js";
import { getOperationalStore } from "../operational/provider.js";
import type { SpendLedgerFilter, SpendLedgerRow, SpendTotals } from "../operational/store.js";

export function spendRoot(): string {
  return getOperationalStore().root();
}

export interface SpendEntry {
  readonly period: string;
  readonly usage: Usage;
  readonly principalId?: string;
  readonly routineId?: string;
  readonly model?: string;
  readonly usdMicros?: number;
  readonly measuredUsd?: number;
}

export async function recordSpend(p: Partition, entry: SpendEntry): Promise<void> {
  const model = entry.model ?? "";
  let usdMicros = entry.usdMicros;
  if (usdMicros === undefined) {
    await ensurePricingFor([model || undefined]);
    usdMicros = usdMicrosAtWrite(entry.usage, model || undefined);
  }
  const measuredMicros = entry.measuredUsd !== undefined && Number.isFinite(entry.measuredUsd) ? Math.round(entry.measuredUsd * 1_000_000) : undefined;
  await getOperationalStore().recordSpend(p.org, {
    surfaceKey: domainKeyOf(p),
    principalId: entry.principalId ?? "",
    routineId: entry.routineId ?? "",
    model,
    period: entry.period,
    inputTokens: entry.usage.inputTokens ?? 0,
    outputTokens: entry.usage.outputTokens ?? 0,
    cacheReadTokens: entry.usage.cacheReadTokens ?? 0,
    cacheWriteTokens: entry.usage.cacheWriteTokens ?? 0,
    usdMicros,
    ...(measuredMicros !== undefined ? { usdMicrosMeasured: measuredMicros, costSource: "measured" as const } : { costSource: "derived" as const }),
  });
}

export async function surfaceTokens(org: string, surfaceKey: string, period: string): Promise<number> {
  return billableTokens(await getOperationalStore().spendTotals(org, { surfaceKey, period }));
}

export async function workspaceTokens(org: string, workspaceKey: string, period: string): Promise<number> {
  return billableTokens(await getOperationalStore().spendTotals(org, { surfaceKeyPrefix: `${workspaceKey}/`, period }));
}

export async function surfaceUsd(org: string, surfaceKey: string, period: string): Promise<number> {
  return (await getOperationalStore().spendTotals(org, { surfaceKey, period })).usdMicros / 1_000_000;
}

export async function workspaceUsd(org: string, workspaceKey: string, period: string): Promise<number> {
  return (await getOperationalStore().spendTotals(org, { surfaceKeyPrefix: `${workspaceKey}/`, period })).usdMicros / 1_000_000;
}

export async function principalSurfaceSpend(org: string, surfaceKey: string, principalId: string, period: string): Promise<{ tokens: number; usd: number }> {
  const totals = await getOperationalStore().spendTotals(org, { surfaceKey, principalId, period });
  return { tokens: billableTokens(totals), usd: totals.usdMicros / 1_000_000 };
}

export async function spendTotals(org: string, filter: SpendLedgerFilter = {}): Promise<SpendTotals> {
  return getOperationalStore().spendTotals(org, filter);
}

export interface SurfacePeriodSpend {
  readonly org: string;
  readonly surfaceKey: string;
  readonly period: string;
  readonly tokens: number;
  readonly usd: number;
  readonly usdMeasured: number;
  readonly usdDerivedOnMeasured: number;
  readonly measuredCalls: number;
  readonly calls: number;
}

export function aggregateSpendBySurfacePeriod(rows: readonly SpendLedgerRow[]): SurfacePeriodSpend[] {
  const byKey = new Map<
    string,
    { org: string; surfaceKey: string; period: string; tokens: number; usdMicros: number; measuredMicros: number; derivedOnMeasuredMicros: number; measuredCalls: number; calls: number }
  >();
  for (const r of rows) {
    const k = `${r.org}\u0000${r.surfaceKey}\u0000${r.period}`;
    const acc =
      byKey.get(k) ?? { org: r.org, surfaceKey: r.surfaceKey, period: r.period, tokens: 0, usdMicros: 0, measuredMicros: 0, derivedOnMeasuredMicros: 0, measuredCalls: 0, calls: 0 };
    acc.tokens += billableTokens(r);
    acc.usdMicros += r.usdMicros;
    acc.calls += r.calls;
    if (r.costSource === "measured") {
      acc.measuredMicros += r.usdMicrosMeasured;
      acc.derivedOnMeasuredMicros += r.usdMicros;
      acc.measuredCalls += r.calls;
    }
    byKey.set(k, acc);
  }
  return [...byKey.values()].map((a) => ({
    org: a.org,
    surfaceKey: a.surfaceKey,
    period: a.period,
    tokens: a.tokens,
    usd: a.usdMicros / 1_000_000,
    usdMeasured: a.measuredMicros / 1_000_000,
    usdDerivedOnMeasured: a.derivedOnMeasuredMicros / 1_000_000,
    measuredCalls: a.measuredCalls,
    calls: a.calls,
  }));
}

export async function spendRollup(): Promise<SurfacePeriodSpend[]> {
  return aggregateSpendBySurfacePeriod(await getOperationalStore().listSpendLedger());
}
