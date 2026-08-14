
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { join } from "node:path";
import {
  parseCron,
  cronMatches,
  nextCronAfter,
  computeNextRun,
  isDue,
} from "../agent/routines/schedule.js";
import {
  applyOutcome,
  settleOutcome,
  shouldPostOnDiff,
  hashState,
  MAX_CONSECUTIVE_FAILURES,
} from "../agent/routines/lifecycle.js";
import * as lifecycleModule from "../agent/routines/lifecycle.js";
import {
  renderWatchMessage,
  applyWatchObservation,
  WATCH_SILENCE_SENTINEL,
  WATCH_STATE_TOOL,
} from "../agent/routines/watch.js";
import { routineMarker, ROUTINE_MARKER, describeTrigger, isClockScheduled, type Routine } from "../agent/routines/routine.js";
import { storedTrigger } from "../agent/tools/create_routine.js";
import "../agent/routines/github-normalizer.js";
import {
  CHECK_IN_START_MS,
  CHECK_IN_CAP_MS,
  CHECK_IN_DOCTRINE,
} from "../agent/routines/check-in.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}
function throws(fn: () => unknown, label: string): void {
  let threw = false;
  try {
    fn();
  } catch {
    threw = true;
  }
  ok(threw, label);
}

const U = (iso: string) => new Date(iso);

throws(() => parseCron("* * * *"), "cron with 4 fields is rejected");
throws(() => parseCron("99 * * * *"), "out-of-range minute is rejected");
throws(() => parseCron("0 9 * * 1-9"), "out-of-range dow is rejected");

const weekday9 = parseCron("0 9 * * 1-5");
ok(cronMatches(weekday9, U("2026-06-25T09:00:00Z")), "weekday 9am matches Thursday 09:00");
ok(!cronMatches(weekday9, U("2026-06-25T09:01:00Z")), "weekday 9am does NOT match 09:01");
ok(!cronMatches(weekday9, U("2026-06-27T09:00:00Z")), "weekday 9am does NOT match Saturday");

const everyQuarter = parseCron("*/15 * * * *");
ok(cronMatches(everyQuarter, U("2026-06-25T12:30:00Z")), "*/15 matches :30");
ok(!cronMatches(everyQuarter, U("2026-06-25T12:31:00Z")), "*/15 does NOT match :31");

const domOrDow = parseCron("0 0 1 * 1");
ok(cronMatches(domOrDow, U("2026-07-01T00:00:00Z")), "DOM-or-DOW matches the 1st (a Wednesday)");
ok(cronMatches(domOrDow, U("2026-06-29T00:00:00Z")), "DOM-or-DOW matches a Monday");
ok(!cronMatches(domOrDow, U("2026-06-30T00:00:00Z")), "DOM-or-DOW skips a non-1st non-Monday");

const nxt = nextCronAfter(weekday9, U("2026-06-25T09:00:00Z"));
ok(nxt !== null && nxt.toISOString() === "2026-06-26T09:00:00.000Z", "next weekday-9 after Thu 9am is Fri 9am");
const overWeekend = nextCronAfter(weekday9, U("2026-06-26T10:00:00Z"));
ok(overWeekend !== null && overWeekend.getUTCDay() === 1, "next weekday-9 after Fri jumps the weekend to Monday");

const from = U("2026-06-24T12:00:00Z");
const iv = computeNextRun({ kind: "interval", everyMinutes: 30 }, from);
ok(iv !== null && iv.toISOString() === "2026-06-24T12:30:00.000Z", "interval next = from + 30min");
const wn = computeNextRun({ kind: "watch", everyMinutes: 5 }, from);
ok(wn !== null && wn.toISOString() === "2026-06-24T12:05:00.000Z", "watch next = from + 5min");
const wc = computeNextRun({ kind: "watch", expr: "0 9 * * 1-5" }, from);
ok(wc !== null && wc.toISOString() === "2026-06-25T09:00:00.000Z", "a cron-scheduled only-on-change trigger uses cron math");
ok(computeNextRun({ kind: "watch" }, from) === null, "a watch with neither cadence nor cron never fires (create_routine refuses it)");
ok(computeNextRun({ kind: "event", source: "github" }, from) === null, "event has no clock-next");
ok(computeNextRun({ kind: "once", at: "2026-07-08T09:00:00.000Z" }, from) === null, "once has no clock-next (fixed at creation, never recomputed)");

{
  const st = (t: Parameters<typeof storedTrigger>[0]) => storedTrigger(t);
  ok(JSON.stringify(st({ kind: "scheduled", everyMinutes: 60, postPolicy: "every-run" })) === '{"kind":"interval","everyMinutes":60}', "cadence + every-run → interval");
  ok(JSON.stringify(st({ kind: "scheduled", cron: "0 9 * * *", postPolicy: "every-run" })) === '{"kind":"cron","expr":"0 9 * * *"}', "cron + every-run → cron");
  ok(JSON.stringify(st({ kind: "scheduled", everyMinutes: 60, postPolicy: "only-on-change" })) === '{"kind":"watch","everyMinutes":60}', "cadence + only-on-change → watch");
  ok(JSON.stringify(st({ kind: "scheduled", cron: "0 9 * * *", postPolicy: "only-on-change" })) === '{"kind":"watch","expr":"0 9 * * *"}', "cron + only-on-change → cron-scheduled watch (new expressiveness)");
  ok(JSON.stringify(st({ kind: "scheduled", at: "2027-03-01T09:00:00Z" })) === '{"kind":"once","at":"2026-07-08T09:00:00.000Z"}', "at → once (postPolicy omitted entirely — ignored for a one-shot)");
  ok(JSON.stringify(st({ kind: "scheduled", at: "2027-03-01T09:00:00Z", postPolicy: "every-run" })) === '{"kind":"once","at":"2026-07-08T09:00:00.000Z"}', "at → once EVEN when postPolicy is also given (ignored, not an error)");
  let threw = 0;
  try { st({ kind: "scheduled", postPolicy: "every-run" }); } catch { threw++; }
  try { st({ kind: "scheduled", cron: "0 9 * * *", everyMinutes: 5, postPolicy: "every-run" }); } catch { threw++; }
  try { st({ kind: "scheduled", cron: "0 9 * * *", at: "2027-03-01T09:00:00Z" }); } catch { threw++; }
  try { st({ kind: "scheduled", at: "not-a-real-timestamp" }); } catch { threw++; }
  try { st({ kind: "scheduled", cron: "0 9 * * *" }); } catch { threw++; }
  ok(threw === 5, "neither / both / all-three of cron+everyMinutes+at, an invalid `at`, and a missing postPolicy are all refused");
  const ev = st({ kind: "event", source: "github", jq: '.fields.repo == "me/proj" and (.fields.event | IN("push"))' });
  ok(ev.kind === "event", "event maps to the stored event kind");
  ok(ev.kind === "event" && ev.jq?.includes(".fields.repo") === true, "OPE-210: the jq expression is stored verbatim on the trigger");
  ok(ev.kind === "event" && (ev as { filter?: unknown; match?: unknown }).filter === undefined && (ev as { match?: unknown }).match === undefined, "OPE-210: neither legacy shape is ever written");
  let evThrew = 0;
  try { st({ kind: "event", source: "typo-hub", jq: '.fields.repo == "me/proj"' }); } catch { evThrew++; }
  try { st({ kind: "event", source: "github", jq: '(.fields.event | IN("push"))' }); } catch { evThrew++; }
  ok(evThrew === 2, "OPE-163: a typo'd source and an unnarrowed subscription are both refused at CREATE (they used to arm a routine that could never match)");
}

ok(describeTrigger({ kind: "interval", everyMinutes: 60 }) === "every 60 min (posts every run)", "interval description states the policy");
ok(describeTrigger({ kind: "watch", everyMinutes: 60 }) === "every 60 min (posts only on change)", "only-on-change description avoids the word watch");
ok(describeTrigger({ kind: "watch", expr: "0 9 * * 1-5" }).includes("posts only on change"), "cron-scheduled only-on-change described consistently");
ok(describeTrigger({ kind: "once", at: "2026-07-08T09:00:00.000Z" }) === "once at 2026-07-08T09:00:00.000Z (fires once, then disables)", "once description states the instant and the disable behaviour");

ok(isClockScheduled({ kind: "once", at: "2026-07-08T09:00:00.000Z" }), "once is clock-scheduled (dispatcher evaluates it, same as cron/interval/watch)");
ok(!isClockScheduled({ kind: "event", source: "github" }), "event stays NOT clock-scheduled");

ok(isDue("2026-06-24T11:59:00Z", from), "past nextRunAt is due");
ok(!isDue("2026-06-24T12:01:00Z", from), "future nextRunAt is not due");
ok(!isDue(null, from), "null nextRunAt is never due");
ok(!isDue(undefined, from), "undefined nextRunAt is never due");

const base: Routine = {
  id: "r-test", org: "default", surfaceKey: "local/dev/alpha", trigger: { kind: "interval", everyMinutes: 5 },
  prompt: "do x", createdAt: from.toISOString(), status: "active", consecutiveFailures: 0,
};
let r = base;
for (let i = 0; i < MAX_CONSECUTIVE_FAILURES; i++) r = applyOutcome(r, "failed", new Date(from.getTime() + i * 60 * 60_000));
ok(r.status === "disabled" && r.consecutiveFailures === MAX_CONSECUTIVE_FAILURES, "self-disables at the failure threshold once the streak has also spanned an hour");
ok(r.disabledReason?.includes("consecutive failures") === true, "disable reason is recorded");

let quick = base;
for (let i = 0; i < MAX_CONSECUTIVE_FAILURES; i++) quick = applyOutcome(quick, "failed", new Date(from.getTime() + i * 60_000));
ok(
  quick.status === "active" && quick.consecutiveFailures === MAX_CONSECUTIVE_FAILURES,
  "🔴 OPE-506: 3 consecutive failures within a couple of minutes do NOT disable — the streak has not spanned an hour yet",
);
ok(quick.firstFailureAt === from.toISOString(), "OPE-506: firstFailureAt pins the start of the streak, unmoved by later failures in the same streak");

const recovered = applyOutcome({ ...base, consecutiveFailures: 2 }, "ok", from);
ok(recovered.consecutiveFailures === 0 && recovered.status === "active", "an ok run resets the failure counter");

const skipped = applyOutcome({ ...base, consecutiveFailures: 2 }, "skipped", from);
ok(skipped.consecutiveFailures === 0 && skipped.lastOutcome === "skipped", "a skip does NOT count as a failure");

ok(shouldPostOnDiff(undefined, hashState("state-a")), "first observation always posts (baseline)");
ok(!shouldPostOnDiff(hashState("same"), hashState("same")), "no diff -> no post");
ok(shouldPostOnDiff(hashState("old"), hashState("new")), "changed state -> post");
ok(hashState("x") === hashState("x") && hashState("x") !== hashState("y"), "hashState is stable + distinguishes");

const first = applyWatchObservation({ lastStateHash: undefined }, "3 open PRs: #1 #2 #3");
ok(first.changed && first.firstObservation, "watch: first observation counts as changed (baseline)");
ok(first.patch.lastStateHash === hashState("3 open PRs: #1 #2 #3"), "watch: first observation persists the new hash");
ok(!("lastOutcome" in first.patch), "watch: a changed observation does NOT record an outcome (the session settles it)");

const same = applyWatchObservation({ lastStateHash: first.patch.lastStateHash }, "3 open PRs: #1 #2 #3");
ok(!same.changed && !same.firstObservation, "watch: identical state -> unchanged, not first");
ok(same.patch.lastOutcome === "skipped", "watch: an unchanged observation records `skipped` NOW");
ok(same.patch.lastStateHash === first.patch.lastStateHash, "watch: unchanged still (re)persists the hash");

const moved = applyWatchObservation({ lastStateHash: first.patch.lastStateHash }, "4 open PRs: #1 #2 #3 #7");
ok(moved.changed && !moved.firstObservation, "watch: different state -> changed");
ok(moved.patch.lastStateHash !== first.patch.lastStateHash, "watch: changed state persists the NEW hash");

const wm = renderWatchMessage({ id: "r-w", prompt: "watch the status page", lastStateHash: undefined, createdAt: "2026-07-01T09:00:00.000Z", lastRunAt: undefined });
ok(wm.includes("watch the status page"), "watch message carries the routine's own prompt");
ok(wm.includes(WATCH_STATE_TOOL), "watch message instructs calling the record_watch_state tool");
ok(wm.includes(WATCH_SILENCE_SENTINEL), "watch message teaches the silence sentinel for the unchanged case");
ok(wm.includes("first check"), "watch message flags a missing baseline (first check)");
ok(wm.includes("FIRST run") && wm.includes("2026-07-01T09:00:00.000Z"), "watch message opens with the temporal fire preamble");
ok(
  !renderWatchMessage({ id: "r-w", prompt: "p", lastStateHash: "abc", createdAt: "2026-07-01T09:00:00.000Z", lastRunAt: "2026-07-02T09:00:00.000Z" }).includes("first check"),
  "watch message with a baseline does NOT claim first check",
);

ok(settleOutcome("ok", "skipped") === "skipped", "settle: an ok session keeps a run-recorded skip");
ok(settleOutcome("ok", undefined) === "ok", "settle: an ok session with no recorded outcome is ok");
ok(settleOutcome("ok", "ok") === "ok", "settle: a stale non-skip outcome never masks ok");
ok(settleOutcome("failed", "skipped") === "failed", "settle: a failure always wins (even after a recorded skip)");

ok(!("gcOrphaned" in lifecycleModule), "gc: the never-wired surface-removal GC is GONE, not re-exported (a tested-but-uncalled mechanism reads as evidence for a guarantee nothing enforced)");

const mk = routineMarker({ [ROUTINE_MARKER.id]: "r-9", [ROUTINE_MARKER.surface]: "slack/T1/C9", [ROUTINE_MARKER.org]: "acme" });
ok(mk?.id === "r-9" && mk.surfaceKey === "slack/T1/C9" && mk.org === "acme", "routineMarker reads id + surfaceKey + org from attributes");
ok(routineMarker({ [ROUTINE_MARKER.id]: "r-9", [ROUTINE_MARKER.surface]: "slack/T1/C9" })?.org === "default", "routineMarker defaults org to 'default' (back-compat with pre-org markers)");
ok(routineMarker({ other: "x" }) === null, "routineMarker is null on a non-routine session");
ok(routineMarker(undefined) === null, "routineMarker is null when no attributes");
ok(routineMarker({ [ROUTINE_MARKER.id]: ["r-9"], [ROUTINE_MARKER.surface]: ["s"] })?.id === "r-9", "routineMarker collapses string[] attributes");

const dir = join(tmpdir(), `open-everywhere-routines-test-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");

const store = await import("../agent/routines/store.js");
const p = { org: "default", platform: "local", workspace: "dev", surface: "alpha", workspaceKey: "local/dev", surfaceKey: "local/dev/alpha", key: "local/dev/alpha" };
const p2 = { ...p, surface: "beta", surfaceKey: "local/dev/beta", key: "local/dev/beta" };

const made: Routine = { ...base, id: store.newRoutineId(), org: p.org, surfaceKey: p.surfaceKey };
await store.addRoutine(p as never, made);
ok((await store.listRoutines(p as never)).length === 1, "store: routine persisted to its surface");
ok((await store.listRoutines(p2 as never)).length === 0, "store: another surface doesn't see it (isolation)");

const upd = await store.updateRoutine(p.org, p.surfaceKey, made.id, { status: "disabled", disabledReason: "manual" });
ok(upd?.status === "disabled", "store: update mutates the routine");
ok((await store.updateRoutine(p.org, p.surfaceKey, "nope", {})) === null, "store: update of missing id returns null");

await store.addRoutine(p2 as never, { ...base, id: store.newRoutineId(), org: p2.org, surfaceKey: p2.surfaceKey });
ok((await store.listAllRoutines()).length === 2, "store: listAll walks every surface");

ok((await store.getRoutine(p.org, p.surfaceKey, made.id))?.id === made.id, "store: getRoutine fetches by org + surfaceKey + id");
ok((await store.getRoutine(p.org, p.surfaceKey, "nope")) === null, "store: getRoutine returns null for missing id");

const pOrg2 = { ...p, org: "acme" };
await store.addRoutine(pOrg2 as never, { ...base, id: store.newRoutineId(), org: "acme", surfaceKey: p.surfaceKey });
ok((await store.listRoutines(p as never)).length === 1, "store: another org's routine for the same surfaceKey is invisible to this org");
ok((await store.listRoutines(pOrg2 as never)).length === 1, "store: the other org has its own isolated surface file");
ok((await store.getRoutine(p.org, p.surfaceKey, made.id))?.org === "default", "store: getRoutine stays within the requested org");

ok((await store.removeRoutine(p as never, made.id)) === true, "store: remove returns true");
ok((await store.listRoutines(p as never)).length === 0, "store: routine is gone after remove");
ok((await store.removeRoutine(p as never, made.id)) === false, "store: removing twice returns false");

{
  const cronRow: Routine = { ...base, id: store.newRoutineId(), surfaceKey: p.surfaceKey, trigger: { kind: "cron", expr: "0 9 * * *" } };
  const intervalRow: Routine = { ...base, id: store.newRoutineId(), surfaceKey: p.surfaceKey, trigger: { kind: "interval", everyMinutes: 30 } };
  const watchRow: Routine = { ...base, id: store.newRoutineId(), surfaceKey: p.surfaceKey, trigger: { kind: "watch", everyMinutes: 15 } };
  const onceRow: Routine = { ...base, id: store.newRoutineId(), surfaceKey: p.surfaceKey, trigger: { kind: "once", at: "2026-07-08T09:00:00.000Z" }, nextRunAt: "2026-07-08T09:00:00.000Z" };
  for (const r of [cronRow, intervalRow, watchRow, onceRow]) await store.addRoutine(p as never, r);

  const all = await store.listRoutines(p as never);
  ok(all.length === 4, "store: a once routine round-trips alongside cron/interval/watch on the same surface");
  const roundTrippedOnce = all.find((r) => r.id === onceRow.id);
  ok(roundTrippedOnce?.trigger.kind === "once" && (roundTrippedOnce.trigger as { at: string }).at === "2026-07-08T09:00:00.000Z", "store: the once trigger's `at` survives the round-trip exactly");
  ok(all.find((r) => r.id === cronRow.id)?.trigger.kind === "cron", "store: a pre-existing cron row is untouched by the once addition");
  ok(all.find((r) => r.id === watchRow.id)?.trigger.kind === "watch", "store: a pre-existing watch row is untouched by the once addition");

  const disabled = await store.updateRoutine(p.org, p.surfaceKey, onceRow.id, { status: "disabled", disabledReason: "once: fired at 2026-07-08T09:05:00.000Z", nextRunAt: null });
  ok(disabled?.status === "disabled" && disabled.trigger.kind === "once", "store: updateRoutine's generic patch path disables a once row without touching its trigger");
}

{
  const { resolvePartition } = await import("../agent/memory/partition.js");
  const { actionKind } = await import("../agent/approvals/actions.js");
  await import("../agent/approvals/flow.js");
  const { default: cancelRoutineTool } = await import("../agent/tools/cancel_routine.js");

  const { registerIdentityMapper } = await import("../agent/identity/binding.js");
  registerIdentityMapper("slack", (c) => {
    const a = (c.session?.auth?.current?.attributes ?? {}) as Record<string, string>;
    const channelId = a["channel_id"];
    return {
      workspace: a["team_id"],
      surface: channelId,
      mode: "channel",
      trust: "internal",
      principalId: c.session?.auth?.current?.principalId || a["user_id"],
      target: channelId ? { channelId } : undefined,
    };
  });

  const ctx = {
    channel: { kind: "slack" },
    session: { auth: { current: { attributes: { team_id: "T1", channel_id: "C1", channel_type: "channel" }, principalId: "U1", principalType: "slack-user" } } },
  } as never;
  const cp = resolvePartition(ctx);
  const cancelId = store.newRoutineId();
  await store.addRoutine(cp as never, { ...base, id: cancelId, org: cp.org, surfaceKey: cp.surfaceKey, trigger: { kind: "interval", everyMinutes: 30 } });

  let threwMissing = false;
  try { await cancelRoutineTool.execute({ id: "r-nope" } as never, ctx); } catch { threwMissing = true; }
  ok(threwMissing, "cancel_routine: refuses a nonexistent id up front (no card wasted)");

  const { registerSlackBridge, _resetSlackBridgeForTest } = await import("../agent/channels/slack-bridge.js");
  registerSlackBridge({
    form: async () => ({ ok: true, ts: "1700000000.0003" }),
    readCall: async () => {
      throw new Error("not wired in this test");
    },
    fetchUserDisplayName: async () => undefined,
    fetchChannelDisplayName: async () => undefined,
    botDisplayName: async () => undefined,
    confirmChannelInternal: async () => false,
    partnerFactsFromInfo: () => ({ dmPartnerTrust: "external" }),
    readableChannelList: () => [],
    channel: {} as never,
  });
  try {
    const proposed = (await cancelRoutineTool.execute({ id: cancelId } as never, ctx)) as { pending: boolean; id: string };
    ok(proposed.pending === true && proposed.id === cancelId, "cancel_routine: proposes (card posted, pending) instead of cancelling on the spot");
    ok((await store.getRoutine(cp.org, cp.surfaceKey, cancelId)) !== null, "cancel_routine: NOTHING is removed until a human confirms (routine still present)");

    const kind = actionKind("routine.cancel")!;
    ok(kind !== undefined && kind.policy === "member", "actionKind: routine.cancel registered with member policy");
    const summary = kind.summarize({ org: cp.org, partition: cp as never, surfaceKey: cp.surfaceKey, id: cancelId, description: "every 30 min" });
    ok(summary.some((l: string) => l.includes(cancelId)), "routine.cancel summarize: names the exact frozen routine id");
    const outcome = await kind.execute({ org: cp.org, partition: cp as never, surfaceKey: cp.surfaceKey, id: cancelId, description: "every 30 min", requestedBy: "U1" }, "U_CONFIRMER");
    ok(/cancelled/.test(outcome), "routine.cancel execute: the confirming click removes the frozen target");
    ok((await store.getRoutine(cp.org, cp.surfaceKey, cancelId)) === null, "cancel_routine: gone from the store after the confirming click");

    const again = await kind.execute({ org: cp.org, partition: cp as never, surfaceKey: cp.surfaceKey, id: cancelId, description: "every 30 min" }, "U_CONFIRMER");
    ok(/nothing to cancel/.test(again), "routine.cancel execute: a target already gone reports cleanly (no throw)");
  } finally {
    _resetSlackBridgeForTest();
  }
}

rmSync(dir, { recursive: true, force: true });

{
  const MIN = 60_000;
  ok(CHECK_IN_START_MS === 1 * MIN, "check-in: start interval is 1 min");
  ok(CHECK_IN_CAP_MS === 5 * MIN, "check-in: hard cap is 5 min");

  ok(CHECK_IN_DOCTRINE.includes("1 min"), "check-in: doctrine names the 1-min start");
  ok(CHECK_IN_DOCTRINE.includes("5 min"), "check-in: doctrine names the 5-min cap");
  ok(/back off/i.test(CHECK_IN_DOCTRINE), "check-in: doctrine states the back-off discipline");
}

console.log(`✓ routines: ${passed} assertions passed (schedule + lifecycle + watch + store + check-in cap)`);
