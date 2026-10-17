import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";
import { resolvePartition } from "../memory/partition.js";
import { actingPrincipalIdOf } from "../access/request.js";
import { getRoutine, updateRoutine } from "../routines/store.js";
import { describeTrigger, isClockScheduled } from "../routines/routine.js";
import { auditRoutineRunNow } from "../routines/fire-audit.js";
import { DISPATCH_TICK_MINUTES } from "../routines/schedule.js";
import { getOperationalStore } from "../operational/provider.js";

const RUN_NOW_WINDOW_MS = DISPATCH_TICK_MINUTES * 60_000;

function runNowThrottleKey(routineId: string): string {
  return `routinerunnow:${routineId}`;
}

export default defineTool({
  description:
    "Run an existing routine ONCE right now, off its schedule, without changing the schedule. Get the id from list_routines. Use when someone wants a REAL run early ('run the digest now'): it posts and writes for real. To try a routine they just set up or edited without it changing anything, use test_routine instead. It does NOT run instantly: it moves the routine to due, and the scheduler picks it up within a few minutes — say that in plain words rather than claiming it has run. The routine keeps its cadence, its history and its run state; the next scheduled run is unaffected. Rate-limited to one manual run per routine per few minutes.",
  inputSchema: z.object({
    id: z.string().min(1).describe("The routine id, e.g. 'r-1a2b3c4d' (from list_routines)."),
  }),
  outputSchema: z.object({
    queued: z.boolean().describe("True when this call moved the routine to due. False = refused (see message)."),
    id: z.string(),
    trigger: z.string(),
    dueAt: z.string().nullable().describe("When the routine is now due (ISO, UTC) — the scheduler fires it on its next tick at/after this."),
    withinMinutes: z.number().describe("Worst-case wait before the run starts, in minutes (the dispatcher tick cadence)."),
    message: z.string(),
  }),
  approval: never(),
  async execute(input, ctx) {
    const p = resolvePartition(ctx);
    const id = input.id.trim();

    // principal-gate: presence — the documented loop guard. A fire re-triggering a fire is a loop with no
    const requestedBy = actingPrincipalIdOf(ctx);
    if (!requestedBy) {
      throw new Error(
        "run_routine_now needs a verified sender — an unattended routine fire has no acting sender (only the creator it is attributed to), and a routine may not re-trigger itself or another routine. Ask a person in this conversation to run it.",
      );
    }

    const routine = await getRoutine(p.org, p.surfaceKey, id);
    if (!routine) {
      throw new Error(`No routine '${id}' on this surface — check the id with list_routines.`);
    }
    if (routine.status !== "active") {
      throw new Error(
        routine.status === "done"
          ? `Routine '${id}' is a finished job (${routine.completedReason ?? "completed"}) — a completed job is terminal. Create a fresh routine if the work has come back.`
          : `Routine '${id}' is disabled (${routine.disabledReason ?? "no reason recorded"}) — re-arm it with enable_routine first, then run it.`,
      );
    }
    if (!isClockScheduled(routine.trigger)) {
      throw new Error(
        `Routine '${id}' is an event subscription (${describeTrigger(routine.trigger, routine.report)}) — it runs when a matching event arrives, so there's no scheduled run to bring forward.`,
      );
    }

    const now = new Date();
    const nowIso = now.toISOString();
    let first = true;
    try {
      first = await getOperationalStore().markEventSeen(p.org, runNowThrottleKey(id), nowIso, RUN_NOW_WINDOW_MS);
    } catch {
      first = true;
    }
    if (!first) {
      return {
        queued: false,
        id,
        trigger: describeTrigger(routine.trigger, routine.report),
        dueAt: routine.nextRunAt ?? null,
        withinMinutes: DISPATCH_TICK_MINUTES,
        message: `routine ${id} already has a manual run queued (one per ${DISPATCH_TICK_MINUTES} minutes) — it will start on the next scheduler tick.`,
      };
    }

    await updateRoutine(p.org, p.surfaceKey, id, { nextRunAt: nowIso, manualRunAt: nowIso });
    await auditRoutineRunNow(routine, requestedBy, nowIso);

    return {
      queued: true,
      id,
      trigger: describeTrigger(routine.trigger, routine.report),
      dueAt: nowIso,
      withinMinutes: DISPATCH_TICK_MINUTES,
      message: `routine ${id} is queued to run — the scheduler picks it up within ${DISPATCH_TICK_MINUTES} minutes. Its schedule (${describeTrigger(routine.trigger, routine.report)}) is unchanged.`,
    };
  },
});
