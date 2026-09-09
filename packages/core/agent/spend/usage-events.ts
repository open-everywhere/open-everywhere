import { getOperationalStore } from "../operational/provider.js";
import type { UsageEventEntry, UsageEventInput, UsageSummaryFilter, UsageSummaryRow } from "../operational/store.js";
import { getSettings } from "../settings/settings.js";

export type { UsageEventEntry, UsageEventInput, UsageSummaryFilter, UsageSummaryRow } from "../operational/store.js";

export const GENERATION_ID_DETAIL_KEY = "generationId";

export function generationIdOf(row: { readonly detail?: Readonly<Record<string, unknown>> }): string | undefined {
  const raw = row.detail?.[GENERATION_ID_DETAIL_KEY];
  return typeof raw === "string" && raw.length > 0 ? raw : undefined;
}

export function usageEventsTtlDays(): number {
  return getSettings().spend.usageEventsTtlDays;
}

export function cacheReportedness(entry: {
  readonly cacheTokensReported?: boolean;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly model?: string;
}): { cacheTokensReported?: boolean } {
  if (entry.cacheTokensReported !== undefined) return { cacheTokensReported: entry.cacheTokensReported };
  if (entry.model === undefined) return {};
  return { cacheTokensReported: entry.cacheReadTokens !== undefined || entry.cacheWriteTokens !== undefined };
}

export async function appendUsageEvent(entry: UsageEventInput): Promise<void> {
  const record: UsageEventEntry = {
    ...entry,
    ts: entry.ts ?? new Date().toISOString(),
    inputTokens: entry.inputTokens ?? 0,
    outputTokens: entry.outputTokens ?? 0,
    cacheReadTokens: entry.cacheReadTokens ?? 0,
    cacheWriteTokens: entry.cacheWriteTokens ?? 0,
    ...cacheReportedness(entry),
  };
  try {
    await getOperationalStore().appendUsageEvent(record);
  } catch (err) {
    console.warn(`[open-everywhere:usage] dropped a usage event for ${entry.org}/${entry.surfaceKey}: ${String(err)}`);
    return;
  }
  if (Math.random() < 0.05) {
    try {
      const cutoff = new Date(Date.parse(record.ts) - usageEventsTtlDays() * 24 * 60 * 60 * 1000).toISOString();
      await getOperationalStore().pruneUsageEvents(record.org, cutoff);
    } catch (err) {
      console.warn(`[open-everywhere:usage] opportunistic prune skipped: ${String(err)}`);
    }
  }
}

export async function usageForSession(org: string, sessionId: string): Promise<UsageEventEntry[]> {
  return getOperationalStore().usageForSession(org, sessionId);
}

export async function usageSummary(org: string, filter: UsageSummaryFilter = {}): Promise<UsageSummaryRow[]> {
  return getOperationalStore().usageSummary(org, filter);
}

export async function pruneUsageEvents(org: string, olderThanTs: string): Promise<number> {
  return getOperationalStore().pruneUsageEvents(org, olderThanTs);
}
