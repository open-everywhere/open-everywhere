import { defineTool } from "eve/tools";
import { z } from "zod";
import { resolvePartition } from "../memory/partition.js";
import { getOperationalStore } from "../operational/provider.js";
import { describeRuntimeHook } from "../webhooks/runtime-hook.js";

export default defineTool({
  description:
    "List the inbound webhooks set up for this org — which external systems can trigger work here, whether each one's payload reaches you or is discarded, and whether it's still live. Use before creating one (to avoid a duplicate), when someone asks what's connected, or to find the source name to pass to rotate_webhook / revoke_webhook. It deliberately does not include endpoint URLs or secrets: those are handed to a human once, privately, and are not something you can see or repeat.",
  inputSchema: z.object({}),
  outputSchema: z.object({
    webhooks: z.array(
      z.object({
        source: z.string(),
        posture: z.string(),
        status: z.string(),
        createdBy: z.string(),
        createdAt: z.string(),
        description: z.string(),
      }),
    ),
    message: z.string(),
  }),
  async execute(_input, ctx) {
    const p = resolvePartition(ctx);
    const hooks = await getOperationalStore().listWebhookHooks(p.org);
    return {
      webhooks: hooks.map((h) => ({
        source: h.source,
        posture: h.posture,
        status: h.status,
        createdBy: h.createdBy,
        createdAt: h.createdAt,
        description: describeRuntimeHook(h),
      })),
      message:
        hooks.length === 0
          ? "no inbound webhooks are set up for this org yet."
          : `${hooks.length} inbound webhook${hooks.length === 1 ? "" : "s"}. Endpoint URLs and secrets aren't listed — they're given to a person once, privately.`,
    };
  },
});
