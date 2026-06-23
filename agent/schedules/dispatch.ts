import { defineSchedule, type ScheduleHandlerArgs } from "eve/schedules";
import { listAllRoutines, updateRoutine } from "../routines/store.js";
import { computeNextRun, isDue } from "../routines/schedule.js";
import { isClockScheduled, type Routine } from "../routines/routine.js";

function log(msg: string): void {
  console.log(`[open-everywhere:routines] ${msg}`);
}

interface DispatchTarget {
  readonly channel: unknown;
  readonly target: Record<string, unknown>;
}
function resolveTarget(_routine: Routine): DispatchTarget | null {
  return null;
}

export default defineSchedule({
  cron: "* * * * *",
  async run({ receive, waitUntil, appAuth }: ScheduleHandlerArgs) {
    const now = new Date();
    let all: Routine[];
    try {
      all = await listAllRoutines();
    } catch (err) {
      log(`tick skipped — store read failed: ${String(err)}`);
      return;
    }

    const due = all.filter(
      (r) => r.status === "active" && isClockScheduled(r.trigger) && isDue(r.nextRunAt, now),
    );
    if (due.length === 0) return;

    let fired = 0;
    let dryRun = 0;
    for (const r of due) {
      const dest = resolveTarget(r);
      if (!dest) {
        dryRun++;
        log(`DUE (dry-run, no channel): ${r.id} on ${r.surfaceKey} — "${r.prompt.slice(0, 60)}"`);
        continue;
      }
      const next = computeNextRun(r.trigger, now);
      try {
        await updateRoutine(r.surfaceKey, r.id, {
          lastRunAt: now.toISOString(),
          lastOutcome: "ok",
          nextRunAt: next ? next.toISOString() : null,
          consecutiveFailures: 0,
        });
        waitUntil(
          receive(dest.channel as never, {
            message: r.prompt,
            target: dest.target as never,
            auth: appAuth,
          }),
        );
        fired++;
      } catch (err) {
        log(`failed to dispatch ${r.id} on ${r.surfaceKey}: ${String(err)}`);
      }
    }
    log(`tick: ${due.length} due -> ${fired} fired, ${dryRun} dry-run`);
  },
});
