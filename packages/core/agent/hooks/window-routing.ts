import { defineHook, type HookContext } from "eve/hooks";
import { appendAudit } from "../audit/audit.js";
import { getConfig } from "../access/config.js";
import { domainKeyOf, resolvePartition } from "../memory/partition.js";
import { classifyWindowRouting, WINDOW_ROUTING_DEGRADED_ACTION } from "../access/window-routing.js";
import { memoryRecallRouteFor } from "../access/window-gate-manifest.js";
import { canDelegateFromSeat } from "../access/delegation-mount.js";
import { currentWakeId, deploymentOrg, windowGrainOf, type BindableContext } from "../identity/binding.js";

async function auditRoutingPosture(ctx: HookContext): Promise<void> {
  try {
    const c = ctx as unknown as BindableContext;
    const grain = windowGrainOf(c);
    if (grain !== "native") return;
    const partition = resolvePartition(c);
    const domainKey = domainKeyOf(partition);
    const domains = getConfig().loadDomains();
    if (classifyWindowRouting(grain, domainKey, domains) !== "native-degraded") return;
    await appendAudit({
      org: deploymentOrg(),
      platform: partition.platform,
      workspace: partition.workspace,
      action: WINDOW_ROUTING_DEGRADED_ACTION,
      detail: {
        domainKey,
        surfaceKey: partition.surfaceKey,
        grain,
        recall: memoryRecallRouteFor(grain, undefined, undefined, canDelegateFromSeat(c)),
        wakeId: currentWakeId(c) ?? null,
      },
    });
  } catch {
  }
}

export default defineHook({
  events: {
    "turn.started": async (_event, ctx) => {
      await auditRoutingPosture(ctx);
    },
  },
});
