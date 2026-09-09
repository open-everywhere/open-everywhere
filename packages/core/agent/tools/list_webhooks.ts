import { defineTool } from "eve/tools";
import { z } from "zod";
import { getConfig } from "../access/config.js";
import { describeReadableBy } from "../access/read-grant.js";
import { configHookPosture, isFusedHook, type WebhookHook } from "../webhooks/config.js";

const POSTURE_CONSEQUENCE: Readonly<Record<ReturnType<typeof configHookPosture>, string>> = {
  "trigger-only": "trigger-only (payload discarded)",
  "content-bearing": "content-bearing (payload reaches the model as untrusted data)",
  projection: "projection (only the declared fields reach the model, as untrusted data)",
};

function describeConfigHook(hook: WebhookHook): string {
  const shape = isFusedHook(hook) ? `fires ${hook.target}` : "emit-only (routines decide what happens)";
  return `"${hook.id}" (${hook.source}) — ${shape}; ${POSTURE_CONSEQUENCE[configHookPosture(hook)] ?? "UNKNOWN posture — treat as content-bearing"}`;
}

export default defineTool({
  description:
    "List the inbound webhooks declared for this deployment — which external systems can trigger work here, whether each one runs a fixed instruction or just emits events for routines to subscribe to, and how much of the sender's payload reaches you. Use when someone asks what's connected, before proposing a new one (to avoid a duplicate id), or to find the name to pass to rotate_webhook. It deliberately does not include signing secrets: those are handed to a human once, privately, and are not something you can see or repeat.",
  inputSchema: z.object({}),
  outputSchema: z.object({
    webhooks: z.array(
      z.object({
        id: z.string(),
        source: z.string(),
        posture: z.string(),
        shape: z.enum(["fused", "emit-only"]),
        target: z.string().optional(),
        readableBy: z.string(),
        description: z.string(),
      }),
    ),
    message: z.string(),
  }),
  async execute() {
    let hooks: readonly WebhookHook[] = [];
    try {
      hooks = getConfig().loadWebhooks?.() ?? [];
    } catch {
      hooks = [];
    }
    return {
      webhooks: hooks.map((h) => ({
        id: h.id,
        source: h.source,
        posture: configHookPosture(h),
        shape: isFusedHook(h) ? ("fused" as const) : ("emit-only" as const),
        ...(h.target !== undefined ? { target: h.target } : {}),
        readableBy: describeReadableBy(h.readableBy),
        description: describeConfigHook(h),
      })),
      message:
        hooks.length === 0
          ? "no inbound webhooks are declared for this deployment yet. Declaring one is a pull request against the config repo — declare_webhook can open it."
          : `${hooks.length} inbound webhook${hooks.length === 1 ? "" : "s"}. Signing secrets aren't listed — they're given to a person once, privately.`,
    };
  },
});
