import { type Caps, type SpendBudgets } from "./spend.js";
import type { SpendLimitRow } from "../operational/store.js";
import { getOperationalStore } from "../operational/provider.js";
import { getConfig } from "../access/config.js";

function loadBudgets(): SpendBudgets {
  try {
    return getConfig().loadSpendBudgets?.() ?? {};
  } catch {
    return {};
  }
}

export function resolveCaps(workspaceKey: string, surfaceKey: string): Caps {
  const budgets = loadBudgets();
  return budgets.perSurface?.[surfaceKey] ?? budgets.perWorkspace?.[workspaceKey] ?? budgets.default ?? {};
}

export function isSpendLimitActive(row: SpendLimitRow, now: number): boolean {
  return row.expiresAt == null || row.expiresAt > now;
}

export function activeSpendLimits(limits: readonly SpendLimitRow[], now: number): SpendLimitRow[] {
  return limits.filter((l) => isSpendLimitActive(l, now));
}

export function applyCapOverrides(config: Caps, limits: readonly SpendLimitRow[], workspaceKey: string, surfaceKey: string): Caps {
  let { surfaceMonthlyTokens, workspaceMonthlyTokens, surfaceMonthlyUsd, workspaceMonthlyUsd } = config;
  for (const l of limits) {
    if (l.level === "surface" && l.scopeKey === surfaceKey) {
      if (l.monthlyTokens != null) surfaceMonthlyTokens = l.monthlyTokens;
      if (l.monthlyUsd != null) surfaceMonthlyUsd = l.monthlyUsd;
    } else if (l.level === "workspace" && l.scopeKey === workspaceKey) {
      if (l.monthlyTokens != null) workspaceMonthlyTokens = l.monthlyTokens;
      if (l.monthlyUsd != null) workspaceMonthlyUsd = l.monthlyUsd;
    }
  }
  return { surfaceMonthlyTokens, workspaceMonthlyTokens, surfaceMonthlyUsd, workspaceMonthlyUsd };
}

export async function effectiveCaps(org: string, workspaceKey: string, surfaceKey: string): Promise<Caps> {
  const config = resolveCaps(workspaceKey, surfaceKey);
  try {
    const limits = activeSpendLimits(await getOperationalStore().spendLimits(org), Date.now());
    return limits.length ? applyCapOverrides(config, limits, workspaceKey, surfaceKey) : config;
  } catch {
    return config;
  }
}

export async function activeSpendLimitsForOrg(org: string, now: number = Date.now()): Promise<SpendLimitRow[]> {
  try {
    return activeSpendLimits(await getOperationalStore().spendLimits(org), now);
  } catch {
    return [];
  }
}
