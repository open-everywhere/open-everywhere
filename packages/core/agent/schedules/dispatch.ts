import { defineSchedule, type ScheduleHandlerArgs } from "eve/schedules";
import slack from "../channels/slack.js";
import { listAllRoutines, updateRoutine } from "../routines/store.js";
import { computeNextRun, isDue } from "../routines/schedule.js";
import { isClockScheduled, ROUTINE_MARKER, type Routine } from "../routines/routine.js";

function log(msg: string): void {
  console.log(`[open-everywhere:routines] ${msg}`);
}

const DEFAULT_MAX_CONCURRENCY = 3;
function routineMaxConcurrency(): number {
  const raw = process.env.OE_ROUTINE_MAX_CONCURRENCY;
  if (raw === undefined) return DEFAULT_MAX_CONCURRENCY;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_MAX_CONCURRENCY;
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

export async function dispatchTick(
  args: ScheduleHandlerArgs & { readonly now?: Date },
): Promise<void> {
  const { receive, waitUntil, appAuth } = args;
  const now = args.now ?? new Date();
  let all: Routine[];
  try {
    all = await listAllRoutines();
  } catch (err) {
    log(`tick skipped — store read failed: ${String(err)}`);
    return;
  }

  const due = all
    .filter((r) => r.status === "active" && isClockScheduled(r.trigger) && isDue(r.nextRunAt, now))
    .sort((a, b) => Date.parse(a.nextRunAt ?? "") - Date.parse(b.nextRunAt ?? ""));
  if (due.length === 0) return;

  const cap = routineMaxConcurrency();
  let fired = 0;
  let dryRun = 0;
  let deferred = 0;
  for (const r of due) {
    const dest = resolveTarget(r);
    if (!dest) {
      dryRun++;
      log(`DUE (dry-run, no channel): ${r.id} on ${r.surfaceKey} — "${r.prompt.slice(0, 60)}"`);
      continue;
    }
    if (fired >= cap) {
      deferred++;
      continue;
    }
    const next = computeNextRun(r.trigger, now);
    try {
      await updateRoutine(r.org, r.surfaceKey, r.id, {
        lastRunAt: now.toISOString(),
        nextRunAt: next ? next.toISOString() : null,
      });
      const markedAuth = {
        ...appAuth,
        attributes: {
          ...appAuth.attributes,
          [ROUTINE_MARKER.id]: r.id,
          [ROUTINE_MARKER.surface]: r.surfaceKey,
          [ROUTINE_MARKER.org]: r.org,
        },
      };
      waitUntil(
        receive(dest.channel, {
          message: r.prompt,
          target: dest.target,
          auth: markedAuth,
        }),
      );
      fired++;
    } catch (err) {
      log(`failed to dispatch ${r.id} on ${r.surfaceKey}: ${String(err)}`);
    }
  }
  log(`tick: ${due.length} due -> ${fired} fired, ${dryRun} dry-run, ${deferred} deferred (cap ${cap})`);
}

export default defineSchedule({
  cron: "* * * * *",
  async run(args: ScheduleHandlerArgs) {
    await dispatchTick(args);
  },
});
