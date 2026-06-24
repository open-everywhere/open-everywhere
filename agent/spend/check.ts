import { resolveCaps } from "./caps.js";
import { checkCap, periodOf, type CapVerdict } from "./spend.js";
import { surfaceTokens, workspaceTokens } from "./store.js";
import type { Partition } from "../memory/partition.js";
import type { SessionMode } from "../access/resolver.js";

export async function scopeOverBudget(p: Partition, mode: SessionMode, nowISO: string): Promise<CapVerdict> {
  const caps = resolveCaps(p.workspaceKey, p.surfaceKey);
  if (caps.surfaceMonthlyTokens == null && caps.workspaceMonthlyTokens == null) return { over: false };
  const period = periodOf(nowISO);
  const [st, wt] = await Promise.all([
    surfaceTokens(p.org, p.surfaceKey, period),
    workspaceTokens(p.org, p.workspaceKey, period),
  ]);
  return checkCap({ mode, surfaceTokens: st, workspaceTokens: wt, caps });
}
