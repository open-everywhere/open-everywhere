import type { ScheduleHandlerArgs } from "eve/schedules";
import { bridgeConfirmChannelInternal, bridgeSlackForm } from "../channels/slack-bridge.js";
import { resolveSurfaceTarget } from "./routine-dispatch.js";
import { routineFireAttributes } from "../routines/fire-auth.js";
import { recheckFireCreator, type CreatorStandingCheck } from "../routines/fire-creator.js";
import { routineFireHalted } from "../routines/fire-halt.js";
import { checkFireEligibility, type AccountActiveCheck, type FireEligibility, type RoomMembershipCheck } from "../routines/fire-eligibility.js";
import { getOperationalStore } from "../operational/provider.js";
import { DISPATCH_TICK_MINUTES } from "../routines/schedule.js";
import { mintWakeId } from "../channels/unified-window.js";
import { getRoutine, updateRoutine } from "../routines/store.js";
import { describeTrigger, type Routine } from "../routines/routine.js";
import { routineWords } from "../routines/schedule-words.js";
import { renderFireMessage } from "../routines/fire-message.js";
import { preFireFallback, runPreFire, type PreFireOutcome } from "../routines/pre-fire.js";
import { taintedFireAttrs } from "../access/taint-signal.js";
import { routinePartition } from "../routines/partition.js";
import { scopeOverBudget } from "../spend/check.js";
import { appendAudit } from "../audit/audit.js";
import { ROUTINE_TEST_FIRED_ACTION, testRunAttrs, testRunKickoffText, testRunRefusal, type RoutineTestRequest } from "../routines/test-run.js";

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
  readonly post?: TestRunPost;
}

export interface TestRunTickResult {
  readonly fired: number;
  readonly refused: number;
}

async function auditTestFired(r: Routine, test: RoutineTestRequest, detail: Readonly<Record<string, unknown>>): Promise<void> {
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

export async function dispatchTestRuns(all: readonly Routine[], args: TestRunDispatchArgs): Promise<TestRunTickResult> {
  const post = args.post ?? liveTestRunPost;
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

      const name = routineWords(describeTrigger(r.trigger, r.report));
      const dest = resolveSurfaceTarget({ surfaceKey: r.surfaceKey, target: r.target });
      const channelId = dest && typeof (dest.target as { channelId?: unknown }).channelId === "string" ? (dest.target as { channelId: string }).channelId : undefined;
      const refuse = async (why: string, reason: string): Promise<void> => {
        refused++;
        log(`test ${test.id} of ${r.id} not started: ${reason}`);
        await auditTestFired(r, test, { started: false, reason });
        if (channelId !== undefined) await post(channelId, `🧪 The test run of ${name} did not start: ${why}.`);
      };
      const refusal = testRunRefusal(r);
      if (refusal !== null) {
        await refuse(refusal, "not-testable");
        continue;
      }
      if (!dest || channelId === undefined) {
        await refuse("I can't post into its room", "unresolved-target");
        continue;
      }
      if (await routineFireHalted(r, { trigger: r.trigger.kind, test: true })) {
        await refuse("this deployment is halted", "halted");
        continue;
      }
      const eligibility = await checkFireEligibility({
        createdBy: r.createdBy,
        platform: "slack",
        roomId: channelId,
        ...(args.confirmRoomMembership ? { membershipCheck: args.confirmRoomMembership } : {}),
        ...(args.confirmCreatorActive ? { activeCheck: args.confirmCreatorActive } : {}),
      }).catch((): FireEligibility => ({ eligible: true }));
      if (!eligibility.eligible) {
        await refuse("the person who set it up can no longer run it in this room", eligibility.reason);
        continue;
      }
      const mode = dest.mode;
      const internal = mode === "channel" ? await confirmInternal(channelId).catch(() => false) : false;
      const creatorInternal = await recheckFireCreator({
        createdBy: r.createdBy,
        platform: "slack",
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
      const root = await post(channelId, testRunKickoffText({ routine: name, requestedBy: test.requestedBy, ...(gateSkip !== undefined ? { gateSkip } : {}) }));
      if (root === undefined) {
        refused++;
        log(`test ${test.id} of ${r.id} not started: the thread root did not post`);
        await auditTestFired(r, test, { started: false, reason: "root-post-failed" });
        continue;
      }

      const fireId = mintWakeId();
      const auth = {
        ...args.appAuth,
        attributes: {
          ...args.appAuth.attributes,
          ...routineFireAttributes(r, dest.attributes, mode, internal, creatorInternal, fireId),
          thread_ts: root,
          ...taintedFireAttrs(pre.tainted),
          ...testRunAttrs(test),
        },
      };
      const message = renderFireMessage(r, pre.collected);
      await auditTestFired(r, test, { started: true, ...(gateSkip !== undefined ? { gated: true } : {}) });
      fired++;
      args.waitUntil(
        args
          .to(dest.channel, { channelId, threadTs: root })
          .send(message, { auth })
          .catch(async (err: unknown) => {
            log(`test ${test.id} of ${r.id}: delivery failed: ${String(err)}`);
            await post(channelId, `🧪 The test run of ${name} could not start its run.`, root);
          }),
      );
    } catch (err) {
      log(`test of ${listed.id} skipped: ${String(err)}`);
    }
  }
  return { fired, refused };
}
