import { effectiveCaps, domainNameForScope, effectiveUserCaps } from "./caps.js";
import { checkCap, periodOf, type CapVerdict } from "./spend.js";
import { surfaceTokens, workspaceTokens, surfaceUsd, workspaceUsd, principalSurfaceSpend } from "./store.js";
import { userScopeKey } from "../access/scope-key.js";
import { domainKeyOf, type Partition } from "../memory/partition.js";
import type { SessionMode } from "../access/resolver.js";
import type { Trust } from "../identity/binding.js";
import { emitTelemetry } from "../observability/telemetry.js";

export interface ScopeUsdSpend {
  readonly surfaceUsd: number;
  readonly workspaceUsd: number;
}

export async function scopeUsdSpend(org: string, workspaceKey: string, surfaceKey: string, nowISO: string): Promise<ScopeUsdSpend> {
  const period = periodOf(nowISO);
  return {
    surfaceUsd: await surfaceUsd(org, surfaceKey, period),
    workspaceUsd: await workspaceUsd(org, workspaceKey, period),
  };
}

export async function scopeOverBudget(p: Partition, mode: SessionMode, nowISO: string, trust?: Trust, principalId?: string): Promise<CapVerdict> {
  const scopeKey = domainKeyOf(p);
  const domainName = domainNameForScope(scopeKey, mode, trust);
  const caps = await effectiveCaps(p.org, p.workspaceKey, scopeKey, domainName);
  const userCaps = mode === "dm" && principalId ? await effectiveUserCaps(p.org, p.platform, p.workspace, principalId) : {};
  const tokenCapped = caps.surfaceMonthlyTokens != null || caps.workspaceMonthlyTokens != null;
  const usdCapped = caps.surfaceMonthlyUsd != null || caps.workspaceMonthlyUsd != null;
  const userCapped = userCaps.surfaceMonthlyTokens != null || userCaps.surfaceMonthlyUsd != null;
  if (!tokenCapped && !usdCapped && !userCapped) return { over: false };
  const period = periodOf(nowISO);
  const [st, wt] = tokenCapped
    ? await Promise.all([surfaceTokens(p.org, scopeKey, period), workspaceTokens(p.org, p.workspaceKey, period)])
    : [0, 0];
  const usd = usdCapped ? await scopeUsdSpend(p.org, p.workspaceKey, scopeKey, nowISO) : { surfaceUsd: 0, workspaceUsd: 0 };
  const user = userCapped ? await principalSurfaceSpend(p.org, scopeKey, principalId!, period) : { tokens: 0, usd: 0 };
  const verdict = checkCap({
    mode,
    surfaceTokens: st,
    workspaceTokens: wt,
    surfaceUsd: usd.surfaceUsd,
    workspaceUsd: usd.workspaceUsd,
    userTokens: user.tokens,
    userUsd: user.usd,
    caps,
    userCaps,
    scopes: {
      ...(principalId ? { user: userScopeKey(p.platform, p.workspace, principalId) } : {}),
      surface: scopeKey,
      workspace: p.workspaceKey,
    },
  });
  if (verdict.over) emitTelemetry("oe.feature.used", { "oe.feature": "spend_cap_hit", "oe.outcome": "ok" });
  return verdict;
}
