import type { Partition } from "../memory/partition.js";
import { windowTokens, type SurfaceLedger, type Usage } from "./spend.js";
import { getOperationalStore } from "../operational/provider.js";

export function spendRoot(): string {
  return getOperationalStore().root();
}

export async function recordUsage(p: Partition, period: string, usage: Usage): Promise<void> {
  await getOperationalStore().recordUsage(p.org, p.surfaceKey, period, usage);
}

export async function surfaceTokens(org: string, surfaceKey: string, period: string): Promise<number> {
  const ledger = await getOperationalStore().surfaceLedger(org, surfaceKey);
  return windowTokens(ledger.windows[period]);
}

export async function workspaceTokens(org: string, workspaceKey: string, period: string): Promise<number> {
  let total = 0;
  for (const l of await allLedgers()) {
    if (l.org === org && l.surfaceKey.startsWith(workspaceKey + "/")) {
      total += windowTokens(l.ledger.windows[period]);
    }
  }
  return total;
}

export async function allLedgers(): Promise<{ org: string; surfaceKey: string; ledger: SurfaceLedger }[]> {
  return getOperationalStore().allLedgers();
}
