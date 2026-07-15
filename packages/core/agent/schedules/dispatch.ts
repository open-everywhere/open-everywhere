import { defineSchedule, type ScheduleHandlerArgs } from "eve/schedules";
import type { TelegramReceiveTarget } from "eve/channels/telegram";
import type { DiscordReceiveTarget } from "eve/channels/discord";
import type { TeamsReceiveTarget } from "eve/channels/teams";
import slack from "../channels/slack.js";
import telegram from "../channels/telegram.js";
import discord from "../channels/discord.js";
import teams from "../channels/teams.js";
import { confirmChannelInternal } from "../channels/slack-events.js";
import { teamsMode } from "../channels/teams-identity.js";
import { rootDmGrainAttrs } from "../channels/unified-window.js";
import { listAllRoutines, updateRoutine } from "../routines/store.js";
import { computeNextRun, isDue } from "../routines/schedule.js";
import { isClockScheduled, ROUTINE_MARKER, type Routine } from "../routines/routine.js";
import { renderWatchMessage, renderScheduledMessage } from "../routines/watch.js";
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

interface DispatchTarget {
  readonly channel: typeof slack | typeof telegram | typeof discord | typeof teams;
  readonly target: { channelId: string; threadTs?: string } | TelegramReceiveTarget | DiscordReceiveTarget | TeamsReceiveTarget;
  readonly mode: SessionMode;
  readonly attributes: Readonly<Record<string, string>>;
}

function storedString(t: Routine["target"], key: string): string | undefined {
  const v = t?.[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function resolveSlackTarget(r: Routine): DispatchTarget | null {
  const channelId = storedString(r.target, "channelId");
  if (!channelId) return null;
  const mode: SessionMode = channelId.startsWith("D") ? "dm" : "channel";
  return {
    channel: slack,
    target: { channelId },
    mode,
    attributes: {
      team_id: r.surfaceKey.split("/")[1] ?? "",
      channel_id: channelId,
      channel_type: mode === "dm" ? "im" : "channel",
    },
  };
}

function resolveTelegramTarget(r: Routine): DispatchTarget | null {
  const chatId = storedString(r.target, "chatId");
  if (!chatId) return null;
  const threadId = r.target?.["messageThreadId"];
  const messageThreadId = typeof threadId === "number" && Number.isInteger(threadId) ? threadId : undefined;
  const chatType = storedString(r.target, "chatType") ?? (chatId.startsWith("-") ? undefined : "private");
  const mode: SessionMode = chatType === "private" ? "dm" : "channel";
  return {
    channel: telegram,
    target: { chatId, ...(messageThreadId !== undefined ? { messageThreadId } : {}) },
    mode,
    attributes: {
      chat_id: chatId,
      ...(messageThreadId !== undefined ? { message_thread_id: String(messageThreadId) } : {}),
      ...(chatType ? { chat_type: chatType } : {}),
    },
  };
}

function resolveDiscordTarget(r: Routine): DispatchTarget | null {
  const channelId = storedString(r.target, "channelId");
  if (!channelId) return null;
  const channelType = storedString(r.target, "channelType");
  const mode: SessionMode = channelType === "1" ? "dm" : channelType === "3" ? "mpim" : "channel";
  return {
    channel: discord,
    target: { channelId },
    mode,
    attributes: {
      channel_id: channelId,
      guild_id: storedString(r.target, "guildId") ?? r.surfaceKey.split("/")[1] ?? "",
      ...(channelType ? { channel_type: channelType } : {}),
    },
  };
}

function resolveTeamsTarget(r: Routine): DispatchTarget | null {
  const serviceUrl = storedString(r.target, "serviceUrl");
  const conversationId = storedString(r.target, "conversationId");
  if (!serviceUrl || !conversationId) return null;
  const conversationType = storedString(r.target, "conversationType");
  const channelId = storedString(r.target, "channelId");
  const teamId = storedString(r.target, "teamId");
  const tenantId = storedString(r.target, "tenantId") ?? r.surfaceKey.split("/")[1] ?? "";
  const mode = teamsMode(conversationType);
  return {
    channel: teams,
    target: {
      serviceUrl,
      conversationId,
      ...(conversationType ? { conversationType } : {}),
      ...(channelId ? { channelId } : {}),
      ...(teamId ? { teamId } : {}),
      ...(tenantId ? { tenantId } : {}),
    },
    mode,
    attributes: {
      conversation_id: conversationId,
      service_url: serviceUrl,
      ...(tenantId ? { tenant_id: tenantId } : {}),
      ...(channelId ? { channel_id: channelId } : {}),
      ...(teamId ? { team_id: teamId } : {}),
      ...(conversationType ? { scope: conversationType } : {}),
    },
  };
}

function resolveTarget(routine: Routine): DispatchTarget | null {
  const platform = routine.surfaceKey.split("/")[0];
  switch (platform) {
    case "slack":
      return resolveSlackTarget(routine);
    case "telegram":
      return resolveTelegramTarget(routine);
    case "discord":
      return resolveDiscordTarget(routine);
    case "teams":
      return resolveTeamsTarget(routine);
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
      const slackChannelId = dest.channel === slack && "channelId" in dest.target ? dest.target.channelId : undefined;
      const internal =
        slackChannelId !== undefined && mode === "channel" ? await confirmInternal(slackChannelId).catch(() => false) : false;
      const markedAuth = {
        ...appAuth,
        attributes: {
          ...appAuth.attributes,
          ...dest.attributes,
          ...(internal ? { is_ext_shared: "false", trust_checked: "true" } : {}),
          ...rootDmGrainAttrs(mode === "dm"),
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
