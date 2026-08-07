import { defineTool } from "eve/tools";
import { z } from "zod";
import { principalIdOf } from "../access/request.js";
import { resolvePartition } from "../memory/partition.js";
import { armCaptureWindow } from "../control/capture-window-read.js";
import { CAPTURE_MAX_DELIVERIES, CAPTURE_MAX_WINDOW_MS } from "../operational/store.js";

export default defineTool({
  description:
    "Turn on temporary recording of a webhook's incoming deliveries so their shape can be inspected with list_recent_events and a subscription filter written against real traffic. Use when someone wants a routine to fire on only some of a webhook's events and nobody knows what the sender's payload looks like. Recording is OFF until this is run, stops automatically, and keeps only a bounded number of recent deliveries. Refused for trigger-only webhooks, whose payloads are never retained by design.",
  inputSchema: z.object({
    source: z.string().min(1).describe("The webhook's source handle, e.g. 'deploy-status' (from list_webhooks)."),
    minutes: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(`How long to record for. Defaults to 15 and is capped at ${Math.round(CAPTURE_MAX_WINDOW_MS / 60_000)}.`),
  }),
  outputSchema: z.object({
    ok: z.boolean(),
    message: z.string(),
  }),
  async execute(input, ctx) {
    const partition = resolvePartition(ctx);
    const armedBy = principalIdOf(ctx);
    const result = await armCaptureWindow({
      partition,
      source: input.source,
      ...(armedBy !== undefined ? { armedBy } : {}),
      ...(input.minutes !== undefined ? { windowMs: input.minutes * 60_000 } : {}),
    });
    if (!result.ok) return { ok: false, message: result.message };
    return {
      ok: true,
      message:
        `Recording deliveries to "${input.source}" until ${result.until}, or until ${CAPTURE_MAX_DELIVERIES} have arrived — ` +
        "whichever comes first. Any previously captured deliveries for this webhook were cleared, so the numbering starts at 1. " +
        "Run list_recent_events once some have landed.",
    };
  },
});
