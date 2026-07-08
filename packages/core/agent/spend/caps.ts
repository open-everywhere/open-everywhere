import { type Caps, type SpendBudgets } from "./spend.js";
import type { SpendLimitRow } from "../operational/store.js";
import { getOperationalStore } from "../operational/provider.js";
import { getConfig } from "../access/config.js";
import { domainForChannel, domainMatchFor, criteriaDomain, type Domain } from "../memory/domain.js";
import type { SessionMode } from "../access/resolver.js";
import type { Trust } from "../identity/binding.js";

function loadBudgets(): SpendBudgets {
  try {
    return getConfig().loadSpendBudgets?.() ?? {};
  } catch {
    return {};
  }
}

function loadDomains(): readonly Domain[] {
  try {
    return getConfig().loadDomains();
  } catch {
    return [];
  }
}

export function domainNameForScope(surfaceKey: string, mode?: SessionMode, trust?: Trust): string | undefined {
  const domains = loadDomains();
  const explicit = domainForChannel(surfaceKey, domains);
  if (explicit) return explicit.name;
  if (mode === undefined || trust === undefined) return undefined;
  const match = domainMatchFor(mode, trust);
  return match ? criteriaDomain(match, domains)?.name : undefined;
}

export function resolveCaps(workspaceKey: string, surfaceKey: string, domainName?: string): Caps {
  const budgets = loadBudgets();
  return (
    budgets.perSurface?.[surfaceKey] ??
    (domainName !== undefined ? budgets.perDomain?.[domainName] : undefined) ??
    budgets.perWorkspace?.[workspaceKey] ??
    budgets.default ??
    {}
  );
}

export function isSpendLimitActive(row: SpendLimitRow, now: number): boolean {
  return row.expiresAt == null || row.expiresAt > now;
}

export function activeSpendLimits(limits: readonly SpendLimitRow[], now: number): SpendLimitRow[] {
  return limits.filter((l) => isSpendLimitActive(l, now));
}

export function applyCapOverrides(config: Caps, limits: readonly SpendLimitRow[], workspaceKey: string, surfaceKey: string, domainName?: string): Caps {
  let { surfaceMonthlyTokens, workspaceMonthlyTokens, surfaceMonthlyUsd, workspaceMonthlyUsd } = config;
  for (const l of limits) {
    if (l.level === "workspace" && l.scopeKey === workspaceKey) {
      if (l.monthlyTokens != null) workspaceMonthlyTokens = l.monthlyTokens;
      if (l.monthlyUsd != null) workspaceMonthlyUsd = l.monthlyUsd;
    }
  }
  for (const l of limits) {
    if (l.level === "domain" && domainName !== undefined && l.scopeKey === domainName) {
      if (l.monthlyTokens != null) surfaceMonthlyTokens = l.monthlyTokens;
      if (l.monthlyUsd != null) surfaceMonthlyUsd = l.monthlyUsd;
    }
  }
  for (const l of limits) {
    if (l.level === "surface" && l.scopeKey === surfaceKey) {
      if (l.monthlyTokens != null) surfaceMonthlyTokens = l.monthlyTokens;
      if (l.monthlyUsd != null) surfaceMonthlyUsd = l.monthlyUsd;
    }
  }
  return { surfaceMonthlyTokens, workspaceMonthlyTokens, surfaceMonthlyUsd, workspaceMonthlyUsd };
}

export async function effectiveCaps(org: string, workspaceKey: string, surfaceKey: string, domainName?: string): Promise<Caps> {
  const config = resolveCaps(workspaceKey, surfaceKey, domainName);
  try {
    const limits = activeSpendLimits(await getOperationalStore().spendLimits(org), Date.now());
    return limits.length ? applyCapOverrides(config, limits, workspaceKey, surfaceKey, domainName) : config;
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
