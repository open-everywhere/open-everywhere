import { defineSchedule, type ScheduleHandlerArgs } from "eve/schedules";
import slack from "../channels/slack.js";
import { confirmChannelInternal } from "../channels/slack-events.js";
import { listAllRoutines, updateRoutine } from "../routines/store.js";
import { computeNextRun, isDue } from "../routines/schedule.js";
import { isClockScheduled, ROUTINE_MARKER, type Routine } from "../routines/routine.js";
import { renderWatchMessage, renderScheduledMessage } from "../routines/watch.js";
import { scopeOverBudget } from "../spend/check.js";
import type { Partition } from "../memory/partition.js";

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

function partitionOf(r: Routine): Partition {
  const [platform = "", workspace = "", ...rest] = r.surfaceKey.split("/");
  const workspaceKey = `${platform}/${workspace}`;
  return { org: r.org, platform, workspace, surface: rest.join("/"), workspaceKey, surfaceKey: r.surfaceKey, key: r.surfaceKey };
}

function surfaceAttributesFor(
  r: Routine,
  dest: DispatchTarget,
  mode: "dm" | "channel",
  confirmedInternal: boolean,
): Record<string, string> {
  const teamId = r.surfaceKey.split("/")[1] ?? "";
  return {
    team_id: teamId,
    channel_id: dest.target.channelId,
    channel_type: mode === "dm" ? "im" : "channel",
    ...(confirmedInternal ? { is_ext_shared: "false", trust_checked: "true" } : {}),
  };
}

export async function dispatchTick(
  args: ScheduleHandlerArgs & {
    readonly now?: Date;
    readonly confirmInternal?: (channelId: string) => Promise<boolean>;
  },
): Promise<void> {
  const { receive, waitUntil, appAuth } = args;
  const now = args.now ?? new Date();
  const confirmInternal = args.confirmInternal ?? confirmChannelInternal;
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
  let declined = 0;
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
    const mode = dest.target.channelId.startsWith("D") ? "dm" : "channel";
    try {
      const verdict = await scopeOverBudget(partitionOf(r), mode, now.toISOString());
      if (verdict.over) {
        declined++;
        log(`DECLINED (over budget): ${r.id} on ${r.surfaceKey} — ${verdict.reason ?? "cap reached"}`);
        await updateRoutine(r.org, r.surfaceKey, r.id, {
          lastRunAt: now.toISOString(),
          nextRunAt: next ? next.toISOString() : null,
          lastOutcome: "skipped",
        });
        continue;
      }
    } catch {
    }
    try {
      await updateRoutine(r.org, r.surfaceKey, r.id, {
        lastRunAt: now.toISOString(),
        nextRunAt: next ? next.toISOString() : null,
        lastOutcome: undefined,
      });
      const internal =
        r.surfaceKey.startsWith("slack/") && mode === "channel"
          ? await confirmInternal(dest.target.channelId).catch(() => false)
          : false;
      const markedAuth = {
        ...appAuth,
        attributes: {
          ...appAuth.attributes,
          ...surfaceAttributesFor(r, dest, mode, internal),
          [ROUTINE_MARKER.id]: r.id,
          [ROUTINE_MARKER.surface]: r.surfaceKey,
          [ROUTINE_MARKER.org]: r.org,
        },
      };
      waitUntil(
        receive(dest.channel, {
          message: r.trigger.kind === "watch" ? renderWatchMessage(r) : renderScheduledMessage(r),
          target: dest.target,
          auth: markedAuth,
        }),
      );
      fired++;
    } catch (err) {
      log(`failed to dispatch ${r.id} on ${r.surfaceKey}: ${String(err)}`);
    }
  }
  log(`tick: ${due.length} due -> ${fired} fired, ${dryRun} dry-run, ${declined} declined, ${deferred} deferred (cap ${cap})`);
}

export default defineSchedule({
  cron: "* * * * *",
  async run(args: ScheduleHandlerArgs) {
    await dispatchTick(args);
  },
});
