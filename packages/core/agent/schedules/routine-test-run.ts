import type { ScheduleHandlerArgs } from "eve/schedules";
import { bridgeConfirmChannelInternal, bridgeSlackForm } from "../channels/slack-bridge.js";
import { resolveRegisteredRoutineDispatch, resolveSurfaceTarget, type DispatchTarget, type RoutineTestRunArm } from "./routine-dispatch.js";
import { routineFireAttributes } from "../routines/fire-auth.js";
import { recheckFireCreator, type CreatorStandingCheck } from "../routines/fire-creator.js";
import { routineFireHalted } from "../routines/fire-halt.js";
import {
  checkFireEligibility,
  type AccountActiveCheck,
  type FireEligibility,
  type RoomMembershipCheck,
  type TeamsAccountActiveCheck,
  type TeamsRoomMembershipCheck,
} from "../routines/fire-eligibility.js";
import { getOperationalStore } from "../operational/provider.js";
import { DISPATCH_TICK_MINUTES } from "../routines/schedule.js";
import { mintWakeId } from "../channels/unified-window.js";
import { getRoutine, updateRoutine } from "../routines/store.js";
import { describeTrigger, type Routine } from "../routines/routine.js";
import { routineWords } from "../routines/schedule-words.js";
import { renderFireMessage } from "../routines/fire-message.js";
import { preFireFallback, runPreFire, type PreFireOutcome } from "../routines/pre-fire.js";
import { routinePartition } from "../routines/partition.js";
import { scopeOverBudget } from "../spend/check.js";
import { appendAudit } from "../audit/audit.js";
import { eventPrompt } from "../routines/events.js";
import { evaluateSubscription } from "../routines/event-match.js";
import { checkEventReadGrant, eventGrantPartitions, type EventGrantDeps } from "../routines/event-authz.js";
import { checkFireDisclosure, type FireDisclosureDeps } from "../routines/fire-disclosure.js";
import { hydratePointer, newHydrationMemo, renderHydratedEntity, type HydrationDeps } from "../routines/entity-read.js";
import { auditRoutineEligibilityUnresolved } from "../routines/fire-audit.js";
import { configHookDisclosure, findWebhook, type WebhookHook } from "../webhooks/config.js";
import { getConfig } from "../access/config.js";
import type { NormalizedEvent } from "../routines/event-model.js";
import { personWords } from "../channels/friendly-ids.js";
import { resolveFriendlyIds } from "../channels/friendly-outbound.js";
import {
  ROUTINE_TEST_FIRED_ACTION,
  TEST_RUN_UNFENCED_REFUSAL,
  replayEventWords,
  storedReplayEvent,
  testRunAttrs,
  testRunFenceMounted,
  testRunKickoffText,
  testRunRefusal,
  type RoutineTestRequest,
} from "../routines/test-run.js";
import type { AuditDetail } from "../audit/scrubbed-text.js";

function log(msg: string): void {
  console.log(`[open-everywhere:routine-test-run] ${msg}`);
}

export type TestRunPost = (channelId: string, text: string, threadTs?: string) => Promise<string | undefined>;

async function liveTestRunPost(channelId: string, text: string, threadTs?: string): Promise<string | undefined> {
  try {
    const body = new URLSearchParams({ channel: channelId, text, ...(threadTs !== undefined ? { thread_ts: threadTs } : {}) });
    const res = await bridgeSlackForm("chat.postMessage", body.toString());
    const ts = (res as { ts?: unknown } | undefined)?.ts;
    return typeof ts === "string" && ts.length > 0 ? ts : undefined;
  } catch {
    return undefined;
  }
}

function slackChannelOf(dest: DispatchTarget): string | undefined {
  const channelId = (dest.target as { channelId?: unknown }).channelId;
  return typeof channelId === "string" && channelId.length > 0 ? channelId : undefined;
}

function slackTestRunArm(post: TestRunPost = liveTestRunPost): RoutineTestRunArm {
  return {
    post: async (dest, text, anchor) => {
      const channelId = slackChannelOf(dest);
      return channelId === undefined ? undefined : post(channelId, text, anchor).catch(() => undefined);
    },
    target: (dest, anchor) => ({ channelId: slackChannelOf(dest) ?? "", threadTs: anchor }),
    attributes: (_dest, anchor) => ({ thread_ts: anchor }),
  };
}

function testRunArmFor(platform: string, post?: TestRunPost): RoutineTestRunArm | undefined {
  if (platform === "slack") return slackTestRunArm(post);
  return resolveRegisteredRoutineDispatch(platform)?.testRun;
}

export interface TestRunDispatchArgs {
  readonly to: ScheduleHandlerArgs["to"];
  readonly waitUntil: ScheduleHandlerArgs["waitUntil"];
  readonly appAuth: ScheduleHandlerArgs["appAuth"];
  readonly now: Date;
  readonly cap: number;
  readonly confirmInternal?: (channelId: string) => Promise<boolean>;
  readonly confirmCreatorInternal?: CreatorStandingCheck;
  readonly confirmRoomMembership?: RoomMembershipCheck;
  readonly confirmCreatorActive?: AccountActiveCheck;
  readonly confirmTeamsRoomMembership?: TeamsRoomMembershipCheck;
  readonly confirmTeamsCreatorActive?: TeamsAccountActiveCheck;
  readonly post?: TestRunPost;
  readonly eventGrant?: EventGrantDeps;
  readonly disclosure?: FireDisclosureDeps;
  readonly hydrate?: HydrationDeps;
  readonly webhooks?: () => readonly WebhookHook[];
}

async function askerWords(id: string, surfaceKey: string): Promise<string> {
  const platform = surfaceKey.split("/")[0] ?? "";
  const label = (await resolveFriendlyIds([{ platform, id }]).catch(() => new Map<string, { label: string }>())).get(id)?.label;
  return personWords({ id, platform, ...(label !== undefined ? { label } : {}) });
}

function liveDeclaredEvent(
  ev: NormalizedEvent,
  hooks: () => readonly WebhookHook[],
): { readonly ok: true; readonly event: NormalizedEvent } | { readonly ok: false; readonly why: string; readonly reason: string } {
  if (ev.readableBy === undefined) return { ok: true, event: ev };
  let hook: WebhookHook | undefined;
  try {
    hook = findWebhook(hooks(), ev.source);
  } catch {
    hook = undefined;
  }
  if (hook === undefined) return { ok: false, why: "the hook its event came from is no longer configured", reason: "grant-refused" };
  const now = configHookDisclosure(hook);
  const narrower =
    now.redactPayload === true
      ? ev.redacted !== true
      : now.project !== undefined && ev.redacted !== true && !(ev.projected !== undefined && ev.projected.every((k) => now.project!.includes(k)));
  if (narrower) return { ok: false, why: "the hook its event came from now shares less of each event", reason: "posture-changed" };
  return { ok: true, event: { ...ev, readableBy: hook.readableBy } };
}

export interface TestRunTickResult {
  readonly fired: number;
  readonly refused: number;
}

async function auditTestFired(r: Routine, test: RoutineTestRequest, detail: AuditDetail): Promise<void> {
  const p = routinePartition(r);
  await appendAudit({
    org: p.org,
    platform: p.platform,
    workspace: p.workspace,
    ...(p.surface === undefined ? {} : { surface: p.surface }),
    principalId: test.requestedBy,
    action: ROUTINE_TEST_FIRED_ACTION,
    detail: { id: r.id, test: test.id, ...detail },
  }).catch(() => undefined);
}

function destAttr(dest: DispatchTarget, key: string): string | undefined {
  const v = dest.attributes[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

interface ReplayPlan {
  readonly words: string;
  readonly filterSkip: boolean;
  readonly redacted: boolean;
  readonly body: { readonly summary: string; readonly url?: string; readonly entity?: string };
}

export async function dispatchTestRuns(all: readonly Routine[], args: TestRunDispatchArgs): Promise<TestRunTickResult> {
  const confirmInternal = args.confirmInternal ?? bridgeConfirmChannelInternal;
  const nowIso = args.now.toISOString();
  let fired = 0;
  let refused = 0;
  for (const listed of all) {
    if (listed.testRun === undefined) continue;
    if (fired >= args.cap) break;
    try {
      const claimed = await getOperationalStore()
        .markEventSeen(listed.org, `routinetestclaim:${listed.testRun.id}`, nowIso, 6 * DISPATCH_TICK_MINUTES * 60_000)
        .catch(() => false);
      if (!claimed) continue;
      const r = await getRoutine(listed.org, listed.surfaceKey, listed.id);
      const test = r?.testRun;
      if (!r || test === undefined || test.id !== listed.testRun.id) continue;
      await updateRoutine(r.org, r.surfaceKey, r.id, { testRun: undefined });

      const platform = r.surfaceKey.split("/")[0] ?? "";
      const name = routineWords(describeTrigger(r.trigger, r.report));
      const dest = resolveSurfaceTarget({ surfaceKey: r.surfaceKey, target: r.target });
      const arm = testRunArmFor(platform, args.post);
      const postable = dest !== null && arm !== undefined && (platform !== "slack" || slackChannelOf(dest) !== undefined);
      const say = async (text: string, anchor?: string): Promise<string | undefined> =>
        postable ? arm!.post(dest!, text, anchor).catch(() => undefined) : undefined;
      const refuse = async (why: string, reason: string): Promise<void> => {
        refused++;
        log(`test ${test.id} of ${r.id} not started: ${reason}`);
        await auditTestFired(r, test, { started: false, reason });
        await say(`🧪 The test run of ${name} did not start: ${why}.`);
      };
      if (!testRunFenceMounted()) {
        await refuse(TEST_RUN_UNFENCED_REFUSAL, "fence-unmounted");
        continue;
      }
      const refusal = testRunRefusal(r);
      if (refusal !== null) {
        await refuse(refusal, "not-testable");
        continue;
      }
      if (!postable) {
        await refuse("I can't post into its room", "unresolved-target");
        continue;
      }
      if (await routineFireHalted(r, { trigger: r.trigger.kind, test: true })) {
        await refuse("this deployment is halted", "halted");
        continue;
      }
      const replay = r.trigger.kind === "event" ? storedReplayEvent(r) : undefined;
      if (replay !== undefined) {
        const live = liveDeclaredEvent(replay.event, args.webhooks ?? (() => getConfig().loadWebhooks?.() ?? []));
        if (!live.ok) {
          await refuse(live.why, live.reason);
          continue;
        }
        const grant = checkEventReadGrant(live.event, eventGrantPartitions(r), args.eventGrant ?? {});
        if (!grant.ok) {
          await refuse("its room can no longer read the event it would replay", "grant-refused");
          continue;
        }
        const disclosure = await checkFireDisclosure(r.surfaceKey, args.disclosure ?? {});
        if (!disclosure.ok) {
          await refuse("the people in its room may not see the event it would replay", "audience-floor");
          continue;
        }
      }
      const slackChannelId = platform === "slack" ? slackChannelOf(dest!) : undefined;
      const teamsChannelId = platform === "teams" ? destAttr(dest!, "channel_id") : undefined;
      const teamsTeamId = platform === "teams" ? destAttr(dest!, "team_id") : undefined;
      const teamsAadObjectId = platform === "teams" ? destAttr(dest!, "aad_object_id") : undefined;
      const teamsServiceUrl = platform === "teams" ? destAttr(dest!, "service_url") : undefined;
      const eligibility = await checkFireEligibility({
        createdBy: r.createdBy,
        platform,
        roomId: platform === "teams" ? teamsChannelId : slackChannelId,
        ...(args.confirmRoomMembership ? { membershipCheck: args.confirmRoomMembership } : {}),
        ...(args.confirmCreatorActive ? { activeCheck: args.confirmCreatorActive } : {}),
        ...(teamsTeamId ? { teamsTeamId } : {}),
        ...(teamsAadObjectId ? { teamsCreatorAadObjectId: teamsAadObjectId } : {}),
        ...(teamsServiceUrl ? { teamsServiceUrl } : {}),
        ...(args.confirmTeamsRoomMembership ? { teamsMembershipCheck: args.confirmTeamsRoomMembership } : {}),
        ...(args.confirmTeamsCreatorActive ? { teamsActiveCheck: args.confirmTeamsCreatorActive } : {}),
      }).catch((): FireEligibility => ({ eligible: true }));
      if (!eligibility.eligible) {
        await refuse("the person who set it up can no longer run it in this room", eligibility.reason);
        continue;
      }
      if (eligibility.teamsMembershipUnresolved !== undefined) {
        await auditRoutineEligibilityUnresolved(r, { check: "teams_room_membership", cause: eligibility.teamsMembershipUnresolved, test: test.id }).catch(() => false);
      }
      const mode = dest!.mode;
      const internal = slackChannelId !== undefined && mode === "channel" ? await confirmInternal(slackChannelId).catch(() => false) : false;
      const creatorInternal = await recheckFireCreator({
        createdBy: r.createdBy,
        platform,
        mode,
        workspaceId: r.surfaceKey.split("/")[1],
        ...(args.confirmCreatorInternal ? { check: args.confirmCreatorInternal } : {}),
      }).catch(() => undefined);
      const fireTrust = (mode === "dm" ? creatorInternal === true : internal) ? "internal" : "external";
      const budget = await scopeOverBudget(routinePartition(r), mode, nowIso, fireTrust, r.createdBy).catch(() => ({ over: false as const }));
      if (budget.over) {
        await refuse("its spending limit is reached", "over-budget");
        continue;
      }

      const pre = await runPreFire(r, nowIso).catch((err: unknown): PreFireOutcome => preFireFallback(r, err));
      const gateSkip = pre.gate.fire ? undefined : pre.gate.why;

      let plan: ReplayPlan | undefined;
      if (replay !== undefined) {
        const ev = replay.event;
        const verdict = await evaluateSubscription(r, ev).catch(() => ({ match: false as const }));
        let entity: string | undefined;
        if (ev.pointer) {
          const h = await hydratePointer(ev.pointer, newHydrationMemo(), args.hydrate ?? {});
          if (h.status === "forbidden") {
            await refuse("it can no longer read what that event is about", "grant-drift");
            continue;
          }
          if (h.status === "error") {
            await refuse("I could not read what that event is about", "hydration-failed");
            continue;
          }
          if (h.status === "ok") entity = renderHydratedEntity(h.entity);
        }
        plan = {
          words: replayEventWords(replay),
          filterSkip: !("match" in verdict) || verdict.match !== true,
          redacted: ev.redacted === true,
          body: { summary: ev.summary, ...(ev.fields["url"] ? { url: ev.fields["url"] } : {}), ...(entity !== undefined ? { entity } : {}) },
        };
      }

      const root = await say(
        testRunKickoffText({
          routine: name,
          askedBy: await askerWords(test.requestedBy, r.surfaceKey),
          ...(gateSkip !== undefined ? { gateSkip } : {}),
          ...(platform !== "slack" ? { threaded: false } : {}),
          ...(plan !== undefined ? { replay: plan.words, filterSkip: plan.filterSkip } : {}),
        }),
      );
      if (root === undefined) {
        refused++;
        log(`test ${test.id} of ${r.id} not started: the opening post did not post`);
        await auditTestFired(r, test, { started: false, reason: "root-post-failed" });
        continue;
      }

      const fireId = mintWakeId();
      const auth = {
        ...args.appAuth,
        attributes: {
          ...args.appAuth.attributes,
          ...routineFireAttributes(r, dest!.attributes, mode, internal, creatorInternal, fireId),
          ...(arm!.attributes?.(dest!, root) ?? {}),
          ...testRunAttrs(test, root),
        },
      };
      const message = plan !== undefined ? eventPrompt(r, plan.body, pre.collected) : renderFireMessage(r, pre.collected);
      await auditTestFired(r, test, {
        started: true,
        ...(gateSkip !== undefined ? { gated: true } : {}),
        ...(plan !== undefined ? { replayed: true, ...(plan.filterSkip ? { unmatched: true } : {}) } : {}),
      });
      fired++;
      args.waitUntil(
        args
          .to(dest!.channel, arm!.target(dest!, root))
          .send(message, { auth })
          .catch(async (err: unknown) => {
            log(`test ${test.id} of ${r.id}: delivery failed: ${String(err)}`);
            await say(`🧪 The test run of ${name} could not start its run.`, root);
          }),
      );
    } catch (err) {
      log(`test of ${listed.id} skipped: ${String(err)}`);
    }
  }
  return { fired, refused };
}
