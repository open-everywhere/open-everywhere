import type { Caps } from "./spend.js";
import type { SpendLimitRow } from "../operational/store.js";
import { getOperationalStore } from "../operational/provider.js";

interface CapConfig {
  readonly default?: Caps;
  readonly perWorkspace?: Readonly<Record<string, Caps>>;
  readonly perSurface?: Readonly<Record<string, Caps>>;
}

const CONFIG: CapConfig = {};

export function resolveCaps(workspaceKey: string, surfaceKey: string): Caps {
  return CONFIG.perSurface?.[surfaceKey] ?? CONFIG.perWorkspace?.[workspaceKey] ?? CONFIG.default ?? {};
}

export function isSpendLimitActive(row: SpendLimitRow, now: number): boolean {
  return row.expiresAt == null || row.expiresAt > now;
}

export function activeSpendLimits(limits: readonly SpendLimitRow[], now: number): SpendLimitRow[] {
  return limits.filter((l) => isSpendLimitActive(l, now));
}

export function applyCapOverrides(config: Caps, limits: readonly SpendLimitRow[], workspaceKey: string, surfaceKey: string): Caps {
  let surfaceMonthlyTokens = config.surfaceMonthlyTokens;
  let workspaceMonthlyTokens = config.workspaceMonthlyTokens;
  for (const l of limits) {
    if (l.level === "surface" && l.scopeKey === surfaceKey) surfaceMonthlyTokens = l.monthlyTokens;
    else if (l.level === "workspace" && l.scopeKey === workspaceKey) workspaceMonthlyTokens = l.monthlyTokens;
  }
  return { surfaceMonthlyTokens, workspaceMonthlyTokens };
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
