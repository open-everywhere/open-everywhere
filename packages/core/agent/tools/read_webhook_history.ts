import { defineTool } from "eve/tools";
import { z } from "zod";
import { ingestUntrustedModelOutput } from "../access/untrusted.js";
import { principalIdOf } from "../access/request.js";
import { resolvePartition } from "../memory/partition.js";
import { readDeliveryHistory, renderDeliveryHistory } from "../control/delivery-history.js";

export default defineTool({
  description:
    "Diagnose an inbound webhook: whether the sender is actually reaching us, and what each delivery did or didn't trigger. Use when someone says a webhook 'isn't working', when a routine that should be firing on events is quiet, or before rewriting a filter. Shows deliveries that were rejected at the door, deliveries that arrived but matched no routine, and routines that matched but were refused (with the reason). Name the hook by its source handle from list_webhooks.",
  inputSchema: z.object({
    source: z.string().min(1).describe("The webhook's source handle, e.g. 'deploy-status' (from list_webhooks)."),
  }),
  outputSchema: z.object({
    ok: z.boolean(),
    history: z.string(),
    message: z.string(),
  }),
  async execute(input, ctx) {
    const partition = resolvePartition(ctx);
    const principalId = principalIdOf(ctx);
    const result = await readDeliveryHistory({ partition, source: input.source, ...(principalId !== undefined ? { principalId } : {}) });
    if (!result.ok) return { ok: false, history: "", message: result.message };
    return { ok: true, history: renderDeliveryHistory(result.history), message: "" };
  },
  toModelOutput(output) {
    if (!output.ok) return { type: "text" as const, value: output.message };
    return ingestUntrustedModelOutput(output.history, {
      source: "webhook delivery history",
      toolName: "read_webhook_history",
    });
  },
});
