import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";
import { resolvePartition } from "../memory/partition.js";
import { resolveMode, principalIdOf } from "../access/request.js";
import { bindFrom } from "../identity/binding.js";
import { addRoutine, newRoutineId } from "../routines/store.js";
import { auditToolAction } from "../audit/tool-action.js";
import { computeNextRun, parseCron } from "../routines/schedule.js";
import { describeTrigger, type Routine, type RoutineTrigger } from "../routines/routine.js";

const trigger = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("cron"),
    expr: z.string().describe('Standard 5-field UTC cron "min hour dom mon dow", e.g. "0 9 * * 1-5" = 9am weekdays.'),
  }),
  z.object({
    kind: z.literal("interval"),
    everyMinutes: z.number().int().min(1).describe("Run every N minutes from now."),
  }),
  z.object({
    kind: z.literal("watch"),
    everyMinutes: z.number().int().min(1).describe("Re-check every N minutes, but post ONLY when the watched state changes."),
  }),
  z.object({
    kind: z.literal("event"),
    source: z.string().describe('External event source, e.g. "github".'),
    match: z.record(z.string(), z.string()).optional().describe('Event filter, e.g. { "event": "pull_request", "action": "opened" }.'),
  }),
]);

export default defineTool({
  description:
    "Create a durable ROUTINE so you act without being re-tagged: a scheduled job (cron/interval), a watch (re-check on a cadence, post only when state changes), or an event subscription. Use this when the user asks for recurring, scheduled, or 'let me know when…' work. Routines belong to this surface and survive their creator leaving; cancel with cancel_routine.",
  inputSchema: z.object({
    prompt: z.string().min(1).describe("What you should DO each time it fires, written as a self-contained instruction (the firing session has no prior thread context)."),
    trigger,
  }),
  outputSchema: z.object({
    created: z.boolean(),
    id: z.string(),
    trigger: z.string(),
    nextRunAt: z.string().nullable().describe("When it first fires (ISO, UTC), or null for event subscriptions."),
  }),
  needsApproval: never(),
  async execute(input, ctx) {
    const mode = resolveMode(ctx);
    if (mode === "mpim") {
      throw new Error("Group DMs are execution-only — create routines in a channel or DM instead.");
    }
    const p = resolvePartition(ctx);
    const t = input.trigger as RoutineTrigger;

    if (t.kind === "cron") {
      try {
        parseCron(t.expr);
      } catch (err) {
        throw new Error(`That cron expression is invalid: ${String(err instanceof Error ? err.message : err)}`);
      }
    }

    const now = new Date();
    const next = computeNextRun(t, now);
    if ((t.kind === "cron" || t.kind === "interval" || t.kind === "watch") && next === null) {
      throw new Error("That schedule never fires — check the cron expression.");
    }

    const target = bindFrom(ctx).target;

    const routine: Routine = {
      id: newRoutineId(),
      org: p.org,
      surfaceKey: p.surfaceKey,
      target,
      trigger: t,
      prompt: input.prompt.trim(),
      createdBy: principalIdOf(ctx),
      createdAt: now.toISOString(),
      status: "active",
      nextRunAt: next ? next.toISOString() : null,
      consecutiveFailures: 0,
    };
    await addRoutine(p, routine);

    await auditToolAction(ctx, "routine.create", {
      id: routine.id,
      trigger: describeTrigger(t),
      nextRunAt: routine.nextRunAt ?? null,
    });

    return {
      created: true,
      id: routine.id,
      trigger: describeTrigger(t),
      nextRunAt: routine.nextRunAt ?? null,
    };
  },
});
