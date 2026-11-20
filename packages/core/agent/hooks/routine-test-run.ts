import { defineHook, type HookContext } from "eve/hooks";
import { defineState } from "eve/context";
import { markTestRunSession, testRunBlockedCount } from "../access/test-run-state.js";
import { getOperationalStore } from "../operational/provider.js";
import { readAudit } from "../audit/audit.js";
import { bridgeSlackForm } from "../channels/slack-bridge.js";
import { isSubagentChildContext, type BindableContext } from "../identity/binding.js";
import { oneAttrValue } from "../routines/routine.js";
import { getRoutine } from "../routines/store.js";
import { resolveRegisteredRoutineDispatch, resolveSurfaceTarget } from "../schedules/routine-dispatch.js";
import { describeTrigger } from "../routines/routine.js";
import { routineWords } from "../routines/schedule-words.js";
import {
  noteTestRunFenceMounted,
  renderTestRunSummary,
  ROUTINE_TEST_BLOCKED_ACTION,
  routineTestStamped,
  type BlockedCall,
  type TestRunStamp,
} from "../routines/test-run.js";
import { optional, refuseTurn, type RefusableContext } from "./control-refusal.js";

type Attrs = Readonly<Record<string, string | readonly string[]>> | undefined;

noteTestRunFenceMounted();

const reported = defineState<Record<string, true>>("open-everywhere.routine-test-run.reported", () => ({}));

function attrsOf(ctx: HookContext): Attrs {
  const c = ctx as unknown as BindableContext;
  return c.session?.auth?.current?.attributes ?? c.session?.auth?.initiator?.attributes;
}

function log(msg: string): void {
  console.log(`[open-everywhere:routine-test-run] ${msg}`);
}

const SUMMARY_WINDOW_MS = 24 * 60 * 60_000;

export async function readBlockedCalls(stamp: TestRunStamp, now: Date = new Date()): Promise<BlockedCall[]> {
  const [platform, workspace, surface] = stamp.surfaceKey.split("/");
  const rows = await readAudit({
    org: stamp.org,
    ...(platform ? { platform } : {}),
    ...(workspace ? { workspace } : {}),
    ...(surface ? { surface } : {}),
    action: ROUTINE_TEST_BLOCKED_ACTION,
    since: new Date(now.getTime() - SUMMARY_WINDOW_MS).toISOString(),
    limit: 500,
  });
  const out: BlockedCall[] = [];
  for (const row of rows) {
    const d = (row.detail ?? {}) as Record<string, unknown>;
    if (d["test"] !== stamp.testId) continue;
    if (typeof d["what"] !== "string" || typeof d["tool"] !== "string") continue;
    out.push({ tool: d["tool"], what: d["what"] });
  }
  return out.reverse();
}

async function routineName(stamp: TestRunStamp): Promise<string> {
  const r = await getRoutine(stamp.org, stamp.surfaceKey, stamp.routineId).catch(() => null);
  return r ? routineWords(describeTrigger(r.trigger, r.report)) : "the routine";
}

export interface TestRunSummaryDeps {
  readonly post?: (method: string, body: string) => Promise<unknown>;
  readonly now?: () => Date;
  readonly read?: (stamp: TestRunStamp, now: Date) => Promise<BlockedCall[]>;
  readonly counted?: number;
  readonly surface?: (stamp: TestRunStamp) => Promise<SurfaceSummaryEdge | undefined>;
}

interface SurfaceSummaryEdge {
  readonly routine: string;
  readonly post: (anchor: string, text: string) => Promise<boolean>;
}

async function liveSurfaceEdge(stamp: TestRunStamp): Promise<SurfaceSummaryEdge | undefined> {
  const platform = stamp.surfaceKey.split("/")[0] ?? "";
  const arm = resolveRegisteredRoutineDispatch(platform)?.testRun;
  if (arm === undefined) return undefined;
  const r = await getRoutine(stamp.org, stamp.surfaceKey, stamp.routineId).catch(() => null);
  const dest = r ? resolveSurfaceTarget({ surfaceKey: r.surfaceKey, target: r.target }) : null;
  if (r === null || dest === null) return undefined;
  return {
    routine: routineWords(describeTrigger(r.trigger, r.report)),
    post: async (anchor, text) => (await arm.post(dest, text, anchor).catch(() => undefined)) !== undefined,
  };
}

const SUMMARY_LATCH_MS = 24 * 60 * 60_000;

export async function postTestRunSummary(attrs: Attrs, failed: boolean, deps: TestRunSummaryDeps = {}): Promise<string | undefined> {
  try {
    const stamp = routineTestStamped(attrs);
    if (stamp === null) return undefined;
    const slack = (stamp.surfaceKey.split("/")[0] ?? "slack") === "slack" || stamp.surfaceKey === "";
    const channel = oneAttrValue(attrs?.["channel_id"]);
    const thread = oneAttrValue(attrs?.["thread_ts"]);
    if (slack ? channel === undefined || thread === undefined : stamp.anchor === undefined) return undefined;
    const edge = slack ? undefined : await (deps.surface ?? liveSurfaceEdge)(stamp);
    if (!slack && edge === undefined) {
      log(`summary of test ${stamp.testId} not posted: the routine's room could not be resolved`);
      return undefined;
    }
    const now = (deps.now ?? (() => new Date()))();
    const first = await getOperationalStore()
      .markEventSeen(stamp.org, `routinetestsummary:${stamp.testId}`, now.toISOString(), SUMMARY_LATCH_MS)
      .catch(() => true);
    if (!first) return undefined;
    let blocked: BlockedCall[] = [];
    let unreadable = false;
    try {
      blocked = await (deps.read ?? readBlockedCalls)(stamp, now);
    } catch {
      unreadable = true;
    }
    const text = renderTestRunSummary({ routine: edge?.routine ?? (await routineName(stamp)), blocked, failed, unreadable, counted: deps.counted ?? 0, ...(slack ? {} : { threaded: false }) });
    if (edge !== undefined) {
      if (!(await edge.post(stamp.anchor!, text))) {
        log(`summary of test ${stamp.testId} did not post`);
        return undefined;
      }
      return text;
    }
    const body = new URLSearchParams({ channel: channel!, thread_ts: thread!, text });
    await (deps.post ?? bridgeSlackForm)("chat.postMessage", body.toString());
    return text;
  } catch (err) {
    log(`summary not posted: ${String(err)}`);
    return undefined;
  }
}

async function onTurnStarted(ctx: HookContext): Promise<void> {
  let stamp: TestRunStamp | null = null;
  try {
    stamp = routineTestStamped(attrsOf(ctx));
  } catch {
    stamp = null;
  }
  if (stamp === null) return;
  try {
    markTestRunSession(stamp);
  } catch (err) {
    await refuseTurn(ctx as unknown as RefusableContext, {
      hook: "routine-test-run",
      phase: "turn.started",
      reason: "test-run-slot-unwritable",
      message: `the test-run slot could not be written, so this test fire would run unfenced: ${String(err).slice(0, 200)}`,
      detail: { test: stamp.testId },
    });
  }
}

async function onTurnEnded(ctx: HookContext, failed: boolean): Promise<void> {
  try {
    if (isSubagentChildContext(ctx as unknown as BindableContext)) return;
    const attrs = attrsOf(ctx);
    const stamp = routineTestStamped(attrs);
    if (stamp === null) return;
    if (reported.get()[stamp.testId] === true) return;
    reported.update((s) => ({ ...s, [stamp.testId]: true }));
    const posted = await postTestRunSummary(attrs, failed, { counted: testRunBlockedCount() });
    if (posted === undefined) {
      reported.update((s) => {
        const { [stamp.testId]: _gone, ...rest } = s;
        return rest;
      });
    }
  } catch (err) {
    log(`turn end skipped: ${String(err)}`);
  }
}

export default defineHook({
  events: {
    // hook-path: REFUSAL — an unwritable test-run slot would let a test fire run unfenced, so the turn is cancelled
    "turn.started": async (_event, ctx) => {
      await onTurnStarted(ctx);
    },
    "turn.settled": optional("routine-test-run", async (event, ctx) => {
      switch (event.data.outcome) {
        case "completed":
          await onTurnEnded(ctx, false);
          return;
        case "failed":
          await onTurnEnded(ctx, true);
          return;
        default:
          return;
      }
    }),
  },
});
