import { defineSchedule, type ScheduleHandlerArgs } from "eve/schedules";
import { bridgeConfirmChannelInternal, bridgeSlackForm } from "../channels/slack-bridge.js";
import { resolveRoutineTarget } from "./routine-dispatch.js";
import { routineFireAttributes } from "../routines/fire-auth.js";
import { recheckFireCreator, type CreatorStandingCheck } from "../routines/fire-creator.js";
import {
  checkFireEligibility,
  type AccountActiveCheck,
  type FireEligibility,
  type RoomMembershipCheck,
  type TeamsAccountActiveCheck,
  type TeamsRoomMembershipCheck,
} from "../routines/fire-eligibility.js";
import { divertTriggeredFire, jobFireSeatKey, runFireSeatKey } from "../routines/fire-window.js";
import { mintWakeId, type UnifiedWakeOrigin } from "../channels/unified-window.js";
import { auditRoutineFireLost, auditRoutineSkip } from "../routines/fire-audit.js";
import { auditFireAttrsSent } from "../routines/fire-carriage.js";
import { checkBound } from "../routines/bound.js";
import { foldRoutineOutcome, retireExhaustedRoutine } from "../routines/outcome-fold.js";
import { listAllRoutines, updateRoutine } from "../routines/store.js";
import { computeNextRun, isDue, DISPATCH_TICK_MINUTES } from "../routines/schedule.js";
import { isClockScheduled, isJobRoutine, routinePermissionGeneration, routineReportSurfaceKey, type Routine } from "../routines/routine.js";
import { renderFireMessage } from "../routines/fire-message.js";
import { routinePartition } from "../routines/partition.js";
import { routineFireHalted } from "../routines/fire-halt.js";
import { scopeOverBudget } from "../spend/check.js";
import type { Trust } from "../identity/binding.js";
import type { Partition } from "../memory/partition.js";
import { emitTelemetry } from "../observability/telemetry.js";
import { getSettings } from "../settings/settings.js";

function log(msg: string): void {
  console.log(`[open-everywhere:routines] ${msg}`);
}

function routineMaxConcurrency(): number {
  return getSettings().routines.maxConcurrency;
}

function onceDisablePatch(r: Routine, now: Date, note: string): Partial<Routine> {
  return r.trigger.kind === "once" ? { status: "disabled", disabledReason: `once: ${note} at ${now.toISOString()}` } : {};
}

const partitionOf = (r: Routine): Partition => routinePartition(r);

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
    readonly confirmCreatorInternal?: CreatorStandingCheck;
    readonly confirmRoomMembership?: RoomMembershipCheck;
    readonly confirmCreatorActive?: AccountActiveCheck;
    readonly confirmTeamsRoomMembership?: TeamsRoomMembershipCheck;
    readonly confirmTeamsCreatorActive?: TeamsAccountActiveCheck;
  },
): Promise<void> {
  const { to, waitUntil, appAuth } = args;
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
  let ineligible = 0;
  let halted = 0;
  let retired = 0;
  for (const r of due) {
    const bound = checkBound(r, now);
    if (bound.exhausted) {
      retired++;
      log(`CEILING: ${r.id} on ${r.surfaceKey} stopped — ${bound.reason}`);
      try {
        await retireExhaustedRoutine({ routine: r, verdict: bound });
      } catch (err) {
        log(`ceiling retire failed for ${r.id} on ${r.surfaceKey}: ${String(err)}`);
      }
      continue;
    }
    const dest = resolveRoutineTarget(r);
    const fireSurfaceKey = routineReportSurfaceKey(r);
    const firePlatform = fireSurfaceKey.split("/")[0];
    if (!dest) {
      dryRun++;
      log(`DUE (dry-run, unresolvable channel/target): ${r.id} on ${r.surfaceKey} — "${r.prompt.slice(0, 60)}"`);
      await auditRoutineSkip(r, "unresolved_target", { trigger: r.trigger.kind });
      continue;
    }
    if (fired >= cap) {
      deferred++;
      continue;
    }
    const dueAt = Date.parse(r.nextRunAt ?? "");
    const next = computeNextRun(r.trigger, Number.isFinite(dueAt) ? new Date(dueAt) : now, now);
    const mode = dest.mode;
    const slackChannelId =
      firePlatform === "slack" && typeof (dest.target as { channelId?: unknown }).channelId === "string"
        ? (dest.target as { channelId: string }).channelId
        : undefined;
    const teamsChannelId = firePlatform === "teams" && typeof dest.attributes["channel_id"] === "string" ? dest.attributes["channel_id"] : undefined;
    const teamsTeamId = firePlatform === "teams" && typeof dest.attributes["team_id"] === "string" ? dest.attributes["team_id"] : undefined;
    const teamsAadObjectId = firePlatform === "teams" && typeof dest.attributes["aad_object_id"] === "string" ? dest.attributes["aad_object_id"] : undefined;
    if (await routineFireHalted(r, { trigger: r.trigger.kind })) {
      halted++;
      log(`SKIPPED (halted): ${r.id} on ${r.surfaceKey} — "${r.prompt.slice(0, 60)}"`);
      continue;
    }
    const internal =
      slackChannelId !== undefined && mode === "channel" ? await confirmInternal(slackChannelId).catch(() => false) : false;
    const creatorInternal = await recheckFireCreator({
      createdBy: r.createdBy,
      platform: firePlatform,
      mode,
      workspaceId: fireSurfaceKey.split("/")[1],
      ...(args.confirmCreatorInternal ? { check: args.confirmCreatorInternal } : {}),
    }).catch(() => undefined);
    const fireTrust: Trust = (mode === "dm" ? creatorInternal === true : internal) ? "internal" : "external";
    const eligibility = await checkFireEligibility({
      createdBy: r.createdBy,
      platform: firePlatform,
      roomId: firePlatform === "teams" ? teamsChannelId : slackChannelId,
      ...(args.confirmRoomMembership ? { membershipCheck: args.confirmRoomMembership } : {}),
      ...(args.confirmCreatorActive ? { activeCheck: args.confirmCreatorActive } : {}),
      ...(teamsTeamId ? { teamsTeamId } : {}),
      ...(teamsAadObjectId ? { teamsCreatorAadObjectId: teamsAadObjectId } : {}),
      ...(args.confirmTeamsRoomMembership ? { teamsMembershipCheck: args.confirmTeamsRoomMembership } : {}),
      ...(args.confirmTeamsCreatorActive ? { teamsActiveCheck: args.confirmTeamsCreatorActive } : {}),
    }).catch((): FireEligibility => ({ eligible: true }));
    if (!eligibility.eligible) {
      ineligible++;
      log(`SKIPPED (${eligibility.reason}): ${r.id} on ${r.surfaceKey} — "${r.prompt.slice(0, 60)}"`);
      await updateRoutine(r.org, r.surfaceKey, r.id, {
        lastRunAt: now.toISOString(),
        nextRunAt: next ? next.toISOString() : null,
        lastOutcome: "skipped",
        lastFailureReason: undefined,
        ...onceDisablePatch(r, now, `skipped (${eligibility.reason})`),
      });
      await auditRoutineSkip(r, eligibility.reason, { trigger: r.trigger.kind }).catch(() => false);
      continue;
    }
    try {
      const verdict = await scopeOverBudget(partitionOf(r), mode, now.toISOString(), fireTrust, r.createdBy);
      if (verdict.over) {
        declined++;
        log(`DECLINED (over budget): ${r.id} on ${r.surfaceKey} — ${verdict.reason ?? "cap reached"}`);
        await updateRoutine(r.org, r.surfaceKey, r.id, {
          lastRunAt: now.toISOString(),
          nextRunAt: next ? next.toISOString() : null,
          lastOutcome: "skipped",
          lastFailureReason: undefined,
          ...onceDisablePatch(r, now, "declined (over budget)"),
        });
        await auditRoutineSkip(r, "over_budget", { ...(verdict.reason ? { budgetReason: verdict.reason } : {}) }).catch(() => false);
        continue;
      }
    } catch {
    }
    try {
      await updateRoutine(r.org, r.surfaceKey, r.id, {
        lastRunAt: now.toISOString(),
        nextRunAt: next ? next.toISOString() : null,
        lastOutcome: undefined,
        lastFailureReason: undefined,
        lastStallAt: undefined,
        ...(r.manualRunAt !== undefined ? { manualRunAt: undefined } : {}),
        ...(r.bound ? { fireCount: (r.fireCount ?? 0) + 1 } : {}),
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
      const fireWakeId = mintWakeId();
      const markedAuth = {
        ...appAuth,
        attributes: {
          ...appAuth.attributes,
          ...routineFireAttributes(r, dest.attributes, mode, internal, creatorInternal, fireWakeId),
        },
      };
      const fireOrigin: UnifiedWakeOrigin | undefined =
        dest.origin && dest.origin.platform === "slack" && isJobRoutine(r) && jobAnchor
          ? { ...dest.origin, threadTs: jobAnchor }
          : dest.origin;
      const seatKey = isJobRoutine(r) ? jobFireSeatKey(r.id, routinePermissionGeneration(r)) : runFireSeatKey(fireWakeId);
      const message = renderFireMessage(r);
      const deliver = async (): Promise<void> => {
        await auditFireAttrsSent(r, markedAuth.attributes, fireWakeId);
        if (fireOrigin) {
          const diverted = await divertTriggeredFire(
            to,
            { message, surfaceKey: fireSurfaceKey, origin: fireOrigin, seatKey, auth: markedAuth, wakeId: fireWakeId },
          );
          if (diverted) return;
        }
        await to(dest.channel, fireTarget).send(message, { auth: markedAuth });
      };
      waitUntil(
        deliver().catch(async (err: unknown) => {
          log(`fire delivery failed for ${r.id} on ${r.surfaceKey}: ${String(err)}`);
          await auditRoutineFireLost(r, String(err));
          try {
            const folded = await foldRoutineOutcome({
              marker: { id: r.id, surfaceKey: r.surfaceKey, org: r.org },
              sessionOutcome: "failed",
              at: now,
            });
            if (folded.folded) {
              log(
                `delivery failure folded for ${r.id} [${r.surfaceKey}] ` +
                  `(fails=${folded.consecutiveFailures}${folded.disabled ? ", AUTO-DISABLED" : ""})`,
              );
            }
          } catch (foldErr) {
            log(`delivery-failure fold skipped for ${r.id}: ${String(foldErr)}`);
          }
        }),
      );
      fired++;
      emitTelemetry("oe.feature.used", { "oe.feature": "routine_fired", "oe.outcome": "ok" });
    } catch (err) {
      log(`failed to dispatch ${r.id} on ${r.surfaceKey}: ${String(err)}`);
      emitTelemetry("oe.feature.used", { "oe.feature": "routine_fired", "oe.outcome": "failed" });
    }
  }
  log(
    `tick: ${due.length} due -> ${fired} fired, ${dryRun} dry-run, ${declined} declined, ${ineligible} ineligible, ${deferred} deferred` +
      `${halted > 0 ? `, ${halted} halted` : ""}${retired > 0 ? `, ${retired} retired at ceiling` : ""} (cap ${cap})`,
  );
}

export default defineSchedule({
  cron: `*/${DISPATCH_TICK_MINUTES} * * * *`,
  async run(args: ScheduleHandlerArgs) {
    await dispatchTick(args);
  },
});
