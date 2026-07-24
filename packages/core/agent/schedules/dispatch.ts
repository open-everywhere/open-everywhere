import { defineSchedule, type ScheduleHandlerArgs } from "eve/schedules";
import { bridgeSlackChannel, bridgeConfirmChannelInternal, bridgeSlackForm } from "../channels/slack-bridge.js";
import { rootDmGrainAttrs } from "../channels/unified-window.js";
import { resolveRegisteredRoutineDispatch, type DispatchTarget } from "./routine-dispatch.js";
import { listAllRoutines, updateRoutine } from "../routines/store.js";
import { computeNextRun, isDue } from "../routines/schedule.js";
import { isClockScheduled, isJobRoutine, ROUTINE_MARKER, type Routine } from "../routines/routine.js";
import { renderWatchMessage, renderScheduledMessage } from "../routines/watch.js";
import { renderJobMessage } from "../routines/job.js";
import { scopeOverBudget } from "../spend/check.js";
import type { Partition } from "../memory/partition.js";
import type { SessionMode } from "../access/resolver.js";
import { emitTelemetry } from "../observability/telemetry.js";

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

function storedString(t: Routine["target"], key: string): string | undefined {
  const v = t?.[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function resolveSlackTarget(r: Routine): DispatchTarget | null {
  const channelId = storedString(r.target, "channelId");
  if (!channelId) return null;
  const slackChannel = bridgeSlackChannel();
  if (!slackChannel) return null;
  const mode: SessionMode = channelId.startsWith("D") ? "dm" : "channel";
  return {
    channel: slackChannel,
    target: { channelId },
    mode,
    attributes: {
      team_id: r.surfaceKey.split("/")[1] ?? "",
      channel_id: channelId,
      channel_type: mode === "dm" ? "im" : "channel",
    },
  };
}

function resolveTarget(routine: Routine): DispatchTarget | null {
  const platform = routine.surfaceKey.split("/")[0];
  if (platform === undefined) return null;
  const provider = resolveRegisteredRoutineDispatch(platform);
  if (provider) return provider.resolveTarget(routine);
  switch (platform) {
    case "slack":
      return resolveSlackTarget(routine);
    default:
      return null;
  }
}

function onceDisablePatch(r: Routine, now: Date, note: string): Partial<Routine> {
  return r.trigger.kind === "once" ? { status: "disabled", disabledReason: `once: ${note} at ${now.toISOString()}` } : {};
}

function partitionOf(r: Routine): Partition {
  const [platform = "", workspace = "", ...rest] = r.surfaceKey.split("/");
  const workspaceKey = `${platform}/${workspace}`;
  return { org: r.org, platform, workspace, surface: rest.join("/"), workspaceKey, surfaceKey: r.surfaceKey, key: r.surfaceKey };
}

async function liveJobKickoff(channelId: string, text: string): Promise<string | undefined> {
  try {
    const body = new URLSearchParams({ channel: channelId, text });
    const res = await bridgeSlackForm("chat.postMessage", body.toString());
    const ts = (res as { ts?: unknown } | undefined)?.ts;
    return typeof ts === "string" && ts.length > 0 ? ts : undefined;
  } catch {
    return undefined;
  }
}

function jobKickoffText(r: Routine): string {
  return `🔄 Starting job — I'll keep this thread as my working context and update it as I go.\n> ${r.prompt.slice(0, 240)}`;
}

export async function dispatchTick(
  args: ScheduleHandlerArgs & {
    readonly now?: Date;
    readonly confirmInternal?: (channelId: string) => Promise<boolean>;
    readonly postJobKickoff?: (channelId: string, text: string) => Promise<string | undefined>;
  },
): Promise<void> {
  const { receive, waitUntil, appAuth } = args;
  const now = args.now ?? new Date();
  const confirmInternal = args.confirmInternal ?? bridgeConfirmChannelInternal;
  const postJobKickoff = args.postJobKickoff ?? liveJobKickoff;
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
    const firePlatform = r.surfaceKey.split("/")[0];
    if (!dest) {
      dryRun++;
      log(`DUE (dry-run, unresolvable channel/target): ${r.id} on ${r.surfaceKey} — "${r.prompt.slice(0, 60)}"`);
      continue;
    }
    if (fired >= cap) {
      deferred++;
      continue;
    }
    const next = computeNextRun(r.trigger, now);
    const mode = dest.mode;
    try {
      const verdict = await scopeOverBudget(partitionOf(r), mode, now.toISOString());
      if (verdict.over) {
        declined++;
        log(`DECLINED (over budget): ${r.id} on ${r.surfaceKey} — ${verdict.reason ?? "cap reached"}`);
        await updateRoutine(r.org, r.surfaceKey, r.id, {
          lastRunAt: now.toISOString(),
          nextRunAt: next ? next.toISOString() : null,
          lastOutcome: "skipped",
          ...onceDisablePatch(r, now, "declined (over budget)"),
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
        ...onceDisablePatch(r, now, "fired"),
      });
      let fireTarget = dest.target;
      let jobAnchor = r.jobSessionAnchor;
      if (isJobRoutine(r)) {
        if (firePlatform === "slack" && "channelId" in dest.target && typeof dest.target.channelId === "string") {
          const channelId: string = dest.target.channelId;
          if (!jobAnchor) {
            jobAnchor = await postJobKickoff(channelId, jobKickoffText(r));
            if (jobAnchor) {
              await updateRoutine(r.org, r.surfaceKey, r.id, { jobSessionAnchor: jobAnchor });
            } else {
              log(`job ${r.id}: kickoff post failed — firing fresh this tick (no session join)`);
            }
          }
          if (jobAnchor) fireTarget = { channelId, threadTs: jobAnchor };
        } else {
          log(`job ${r.id} on ${r.surfaceKey}: durable-job session-join is Slack-only in v1 — firing with ledger continuity only`);
        }
      }
      const slackChannelId =
        firePlatform === "slack" && typeof (dest.target as { channelId?: unknown }).channelId === "string"
          ? (dest.target as { channelId: string }).channelId
          : undefined;
      const internal =
        slackChannelId !== undefined && mode === "channel" ? await confirmInternal(slackChannelId).catch(() => false) : false;
      const markedAuth = {
        ...appAuth,
        attributes: {
          ...appAuth.attributes,
          ...dest.attributes,
          ...(internal ? { is_ext_shared: "false", trust_checked: "true" } : {}),
          ...rootDmGrainAttrs(mode === "dm" || mode === "mpim" || dest.attributes.chat_type === "group" || dest.attributes.chat_type === "supergroup"),
          [ROUTINE_MARKER.id]: r.id,
          [ROUTINE_MARKER.surface]: r.surfaceKey,
          [ROUTINE_MARKER.org]: r.org,
        },
      };
      waitUntil(
        receive(dest.channel, {
          message: isJobRoutine(r)
            ? renderJobMessage(r)
            : r.trigger.kind === "watch"
              ? renderWatchMessage(r)
              : renderScheduledMessage(r),
          target: fireTarget,
          auth: markedAuth,
        }).catch((err: unknown) => log(`fire delivery failed for ${r.id} on ${r.surfaceKey}: ${String(err)}`)),
      );
      fired++;
      emitTelemetry("oe.feature.used", { "oe.feature": "routine_fired", "oe.outcome": "ok" });
    } catch (err) {
      log(`failed to dispatch ${r.id} on ${r.surfaceKey}: ${String(err)}`);
      emitTelemetry("oe.feature.used", { "oe.feature": "routine_fired", "oe.outcome": "failed" });
    }
  }
  log(`tick: ${due.length} due -> ${fired} fired, ${dryRun} dry-run, ${declined} declined, ${deferred} deferred (cap ${cap})`);
}

export default defineSchedule({
  cron: "*/10 * * * *",
  async run(args: ScheduleHandlerArgs) {
    await dispatchTick(args);
  },
});
