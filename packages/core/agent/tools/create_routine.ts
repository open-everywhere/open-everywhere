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
    kind: z.literal("scheduled"),
    cron: z
      .string()
      .optional()
      .describe('Standard 5-field UTC cron "min hour dom mon dow", e.g. "0 9 * * 1-5" = 9am weekdays. Exactly ONE of cron / everyMinutes.'),
    everyMinutes: z.number().int().min(1).optional().describe("Run every N minutes from now. Exactly ONE of cron / everyMinutes. Effective resolution is the dispatcher tick (~10 min): finer cadences fire on the first tick at/after they're due."),
    postPolicy: z
      .enum(["every-run", "only-on-change"])
      .describe(
        "Decide from the TASK'S SHAPE, never from the user's phrasing: 'every-run' = the post IS the product " +
          "(daily summary, digest, reminder — a silent run would be a failure); 'only-on-change' = the post is an " +
          "alert ('check X and tell me when something is new/changed') — the fired turn records what it observed " +
          "and a durable host-side diff decides whether to post (reliable across fires, unlike anything remembered " +
          "in-session). A cadence in the request ('hourly') only sets the schedule, never the policy. If genuinely " +
          "unclear, ask in plain words ('post every hour regardless, or only when something new lands?').",
      ),
  }),
  z.object({
    kind: z.literal("event"),
    source: z.string().describe('External event source, e.g. "github".'),
    match: z.record(z.string(), z.string()).optional().describe('Event filter, e.g. { "event": "pull_request", "action": "opened" }.'),
  }),
]);

export function storedTrigger(t: z.infer<typeof trigger>): RoutineTrigger {
  if (t.kind === "event") return { kind: "event", source: t.source, match: t.match };
  const both = t.cron !== undefined && t.everyMinutes !== undefined;
  if (both || (t.cron === undefined && t.everyMinutes === undefined)) {
    throw new Error("A scheduled routine needs exactly ONE of `cron` or `everyMinutes`.");
  }
  if (t.postPolicy === "only-on-change") {
    return t.cron !== undefined ? { kind: "watch", expr: t.cron } : { kind: "watch", everyMinutes: t.everyMinutes! };
  }
  return t.cron !== undefined ? { kind: "cron", expr: t.cron } : { kind: "interval", everyMinutes: t.everyMinutes! };
}

export default defineTool({
  description:
    "Create a durable ROUTINE so you act without being re-tagged: a scheduled job (on a cadence or cron, with a required post policy — every run, or only when something changed) or an event subscription. Use this when the user asks for recurring, scheduled, or 'let me know when…' work. When talking to users, describe the policy in plain words ('I'll check every hour and only post when something changes'), never internal jargon. Routines belong to this surface and survive their creator leaving; cancel with cancel_routine. The prompt can invoke skills by name (e.g. 'run the <skill> skill, then …') — a fired routine sees this surface's domain and granted skills just like a normal turn, so a whole workflow can be one skill cron'd via a one-line prompt.",
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
  approval: never(),
  async execute(input, ctx) {
    const mode = resolveMode(ctx);
    if (mode === "mpim") {
      throw new Error("Group DMs are execution-only — create routines in a channel or DM instead.");
    }
    const p = resolvePartition(ctx);
    const t = storedTrigger(input.trigger as z.infer<typeof trigger>);

    const expr = t.kind === "cron" ? t.expr : t.kind === "watch" ? t.expr : undefined;
    if (expr !== undefined) {
      try {
        parseCron(expr);
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
