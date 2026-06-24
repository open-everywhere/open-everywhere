import { defineHook } from "eve/hooks";
import { resolvePartition } from "../memory/partition.js";
import { recordUsage } from "../spend/store.js";
import { periodOf, type Usage } from "../spend/spend.js";

export default defineHook({
  events: {
    "step.completed": async (event, ctx) => {
      const usage = event.data?.usage as Usage | undefined;
      if (!usage || (usage.inputTokens == null && usage.outputTokens == null)) return;
      try {
        const p = resolvePartition(ctx);
        await recordUsage(p, periodOf(new Date().toISOString()), usage);
      } catch (err) {
        console.log(`[open-everywhere:spend] record skipped: ${String(err)}`);
      }
    },
  },
});
