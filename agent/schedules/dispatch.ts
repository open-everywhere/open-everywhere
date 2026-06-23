import { defineSchedule, type ScheduleHandlerArgs } from "eve/schedules";
import slack from "../channels/slack.js";
import { listAllRoutines, updateRoutine } from "../routines/store.js";
import { computeNextRun, isDue } from "../routines/schedule.js";
import { isClockScheduled, type Routine } from "../routines/routine.js";

function log(msg: string): void {
  console.log(`[open-everywhere:routines] ${msg}`);
}

interface DispatchTarget {
  readonly channel: typeof slack;
  readonly target: { channelId: string; threadTs?: string };
}
function resolveTarget(routine: Routine): DispatchTarget | null {
  const platform = routine.surfaceKey.split("/")[0];
  if (platform === "slack") {
    const channelId = routine.target?.["channelId"];
    if (typeof channelId === "string" && channelId.length > 0) {
      return { channel: slack, target: { channelId } };
    }
  }
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
          receive(dest.channel, {
            message: r.prompt,
            target: dest.target,
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
