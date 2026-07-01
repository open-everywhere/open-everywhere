import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";
import { resolvePartition } from "../memory/partition.js";
import { listRoutines } from "../routines/store.js";
import { describeTrigger } from "../routines/routine.js";

export default defineTool({
  description:
    "List the routines (scheduled jobs, watches, event subscriptions) set up on this surface, with their status and next run time. Use when asked what proactive/recurring work is configured here.",
  inputSchema: z.object({
    includeDisabled: z.boolean().default(false).describe("Include auto-disabled routines (e.g. ones that failed repeatedly)."),
  }),
  outputSchema: z.object({
    routines: z.array(
      z.object({
        id: z.string(),
        trigger: z.string(),
        prompt: z.string(),
        status: z.string(),
        nextRunAt: z.string().nullable(),
        lastOutcome: z.string().nullable(),
        note: z.string().nullable(),
      }),
    ),
  }),
  approval: never(),
  async execute(input, ctx) {
    const p = resolvePartition(ctx);
    const all = await listRoutines(p);
    const routines = all
      .filter((r) => input.includeDisabled || r.status === "active")
      .map((r) => ({
        id: r.id,
        trigger: describeTrigger(r.trigger),
        prompt: r.prompt,
        status: r.status,
        nextRunAt: r.nextRunAt ?? null,
        lastOutcome: r.lastOutcome ?? null,
        note: r.disabledReason ?? null,
      }));
    return { routines };
  },
});
