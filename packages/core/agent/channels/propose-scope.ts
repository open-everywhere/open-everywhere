import { currentTurnId, type BindableContext } from "../identity/binding.js";
import type { Partition } from "../memory/partition.js";
import { addressedWakeThisTurn } from "../access/dispatch-origin-signal.js";
import { getOperationalStore } from "../operational/provider.js";
import { wakeSurfaceKeyFromTargetJson } from "./unified-window.js";

function isSurfaceKey(value: string): boolean {
  const parts = value.split("/");
  return parts.length === 3 && parts.every((p) => p.length > 0);
}

export async function proposalScopeKey(ctx: BindableContext, partition: Pick<Partition, "org" | "surfaceKey">): Promise<string> {
  const fallback = partition.surfaceKey;
  try {
    const addressed = addressedWakeThisTurn(currentTurnId(ctx));
    if (addressed === undefined || addressed.length === 0) return fallback;
    if (partition.org.length === 0) return fallback;
    const json = await getOperationalStore().getUnifiedWakeTarget(partition.org, addressed);
    if (!json) return fallback;
    const surfaceKey = wakeSurfaceKeyFromTargetJson(json);
    return surfaceKey !== undefined && isSurfaceKey(surfaceKey) ? surfaceKey : fallback;
  } catch {
    return fallback;
  }
}
