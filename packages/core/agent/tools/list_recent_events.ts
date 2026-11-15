import { defineTool } from "eve/tools";
import { z } from "zod";
import { ingestUntrustedModelOutput } from "../access/untrusted.js";
import { principalIdOf } from "../access/request.js";
import { resolvePartition } from "../memory/partition.js";
import { readCaptureWindow, renderCaptureWindow } from "../control/capture-window-read.js";

export default defineTool({
  description:
    "Read the deliveries a webhook has actually sent, numbered, so a subscription filter can be written against real traffic instead of guesswork. Use when someone wants a routine to fire on some-but-not-all events from a webhook, when you don't know what fields a sender puts in its payload, or to CHECK a filter you just wrote. Requires a capture window to have been armed first with capture_events. Pass `filter` with a candidate jq expression to see exactly which captured deliveries it would have matched and which it would have missed.",
  inputSchema: z.object({
    source: z.string().min(1).describe("The webhook's source handle, e.g. 'deploy-status' (from list_webhooks)."),
    filter: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Optional candidate jq predicate to score against every captured delivery, e.g. '.event == \"build\" and .fields.status == \"failed\"'. Nothing is saved; this is a dry run. Use create_routine to store one.",
      ),
  }),
  outputSchema: z.object({
    ok: z.boolean(),
    events: z.string(),
    message: z.string(),
  }),
  async execute(input, ctx) {
    const partition = resolvePartition(ctx);
    const principalId = principalIdOf(ctx);
    const result = await readCaptureWindow({
      partition,
      source: input.source,
      ...(principalId !== undefined ? { principalId } : {}),
      ...(input.filter !== undefined ? { candidate: input.filter } : {}),
    });
    if (!result.ok) return { ok: false, events: "", message: result.message };
    return { ok: true, events: renderCaptureWindow(result.view), message: "" };
  },
  toModelOutput(output) {
    if (!output.ok) return { type: "text" as const, value: output.message };
    return ingestUntrustedModelOutput(output.events, {
      source: "captured webhook deliveries",
      toolName: "list_recent_events",
    });
  },
});
