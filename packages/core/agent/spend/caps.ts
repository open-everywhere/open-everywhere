import { type Caps, type SpendBudgets, type UserCaps } from "./spend.js";
import type { SpendLimitRow } from "../operational/store.js";
import { getOperationalStore } from "../operational/provider.js";
import { getConfig } from "../access/config.js";
import { domainForChannel, domainMatchFor, criteriaDomain, type Domain } from "../memory/domain.js";
import { userScopeKey } from "../access/scope-key.js";
import { principalKey } from "../identity/principal-key.js";
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

export type UserCapLayer = "override" | "config:overrides" | "config:default" | "none";

export interface ResolvedUserCaps {
  readonly caps: UserCaps;
  readonly layer: UserCapLayer;
  readonly configKey?: string;
}

export function resolveUserCaps(principalId: string | undefined, platform?: string): UserCaps {
  return resolveUserCapsWithLayer(principalId, platform).caps;
}

export function resolveUserCapsWithLayer(principalId: string | undefined, platform?: string): ResolvedUserCaps {
  if (!principalId) return { caps: {}, layer: "none" };
  const perUser = loadBudgets().perUser;
  const qualified = platform ? principalKey(platform, principalId) : undefined;
  for (const key of [qualified, principalId]) {
    const hit = key !== undefined ? perUser?.overrides?.[key] : undefined;
    if (hit) return { caps: hit, layer: "config:overrides", configKey: key! };
  }
  return perUser?.default ? { caps: perUser.default, layer: "config:default" } : { caps: {}, layer: "none" };
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

export function applyUserCapOverrides(config: UserCaps, limits: readonly SpendLimitRow[], principalScopeKey: string): UserCaps {
  let { surfaceMonthlyTokens, surfaceMonthlyUsd } = config;
  for (const l of limits) {
    if (l.level === "user" && l.scopeKey === principalScopeKey) {
      if (l.monthlyTokens != null) surfaceMonthlyTokens = l.monthlyTokens;
      if (l.monthlyUsd != null) surfaceMonthlyUsd = l.monthlyUsd;
    }
  }
  return { surfaceMonthlyTokens, surfaceMonthlyUsd };
}

export async function effectiveUserCaps(org: string, platform: string, principalId: string | undefined): Promise<UserCaps> {
  const config = resolveUserCaps(principalId, platform);
  if (!principalId) return config;
  try {
    const limits = activeSpendLimits(await getOperationalStore().spendLimits(org), Date.now());
    return limits.length ? applyUserCapOverrides(config, limits, userScopeKey(platform, principalId)) : config;
  } catch {
    return config;
  }
}

export interface UserCapRow {
  readonly principal: string;
  readonly source: "config:default" | "config:overrides" | "override";
  readonly monthlyTokens: number | null;
  readonly monthlyUsd: number | null;
  readonly expiresAt?: number;
  readonly reason?: string;
  readonly setBy?: string;
}

export function userCapInventory(limits: readonly SpendLimitRow[]): UserCapRow[] {
  const perUser = loadBudgets().perUser;
  const rows: UserCapRow[] = [];
  if (perUser?.default) {
    rows.push({ principal: "*", source: "config:default", monthlyTokens: perUser.default.surfaceMonthlyTokens ?? null, monthlyUsd: perUser.default.surfaceMonthlyUsd ?? null });
  }
  for (const [key, caps] of Object.entries(perUser?.overrides ?? {})) {
    rows.push({ principal: key, source: "config:overrides", monthlyTokens: caps.surfaceMonthlyTokens ?? null, monthlyUsd: caps.surfaceMonthlyUsd ?? null });
  }
  for (const l of limits) {
    if (l.level !== "user") continue;
    rows.push({
      principal: l.scopeKey,
      source: "override",
      monthlyTokens: l.monthlyTokens ?? null,
      monthlyUsd: l.monthlyUsd ?? null,
      ...(l.expiresAt != null ? { expiresAt: l.expiresAt } : {}),
      ...(l.reason ? { reason: l.reason } : {}),
      ...(l.setBy ? { setBy: l.setBy } : {}),
    });
  }
  return rows;
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
