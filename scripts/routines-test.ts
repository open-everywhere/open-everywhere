
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
  shouldPostOnDiff,
  hashState,
  gcOrphaned,
  MAX_CONSECUTIVE_FAILURES,
} from "../agent/routines/lifecycle.js";
import { routineMarker, ROUTINE_MARKER, type Routine } from "../agent/routines/routine.js";

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
ok(computeNextRun({ kind: "event", source: "github" }, from) === null, "event has no clock-next");

ok(isDue("2026-06-24T11:59:00Z", from), "past nextRunAt is due");
ok(!isDue("2026-06-24T12:01:00Z", from), "future nextRunAt is not due");
ok(!isDue(null, from), "null nextRunAt is never due");
ok(!isDue(undefined, from), "undefined nextRunAt is never due");

const base: Routine = {
  id: "r-test", org: "default", surfaceKey: "local/dev/alpha", trigger: { kind: "interval", everyMinutes: 5 },
  prompt: "do x", createdAt: from.toISOString(), status: "active", consecutiveFailures: 0,
};
let r = base;
for (let i = 0; i < MAX_CONSECUTIVE_FAILURES; i++) r = applyOutcome(r, "failed", from);
ok(r.status === "disabled" && r.consecutiveFailures === MAX_CONSECUTIVE_FAILURES, "self-disables at the failure threshold");
ok(r.disabledReason?.includes("consecutive failures") === true, "disable reason is recorded");

const recovered = applyOutcome({ ...base, consecutiveFailures: 2 }, "ok", from);
ok(recovered.consecutiveFailures === 0 && recovered.status === "active", "an ok run resets the failure counter");

const skipped = applyOutcome({ ...base, consecutiveFailures: 2 }, "skipped", from);
ok(skipped.consecutiveFailures === 0 && skipped.lastOutcome === "skipped", "a skip does NOT count as a failure");

ok(shouldPostOnDiff(undefined, hashState("state-a")), "first observation always posts (baseline)");
ok(!shouldPostOnDiff(hashState("same"), hashState("same")), "no diff -> no post");
ok(shouldPostOnDiff(hashState("old"), hashState("new")), "changed state -> post");
ok(hashState("x") === hashState("x") && hashState("x") !== hashState("y"), "hashState is stable + distinguishes");

const rs: Routine[] = [
  { ...base, id: "a", surfaceKey: "local/dev/alpha" },
  { ...base, id: "b", surfaceKey: "local/dev/gone" },
];
const gc = gcOrphaned(rs, new Set(["local/dev/alpha"]));
ok(gc.kept.length === 1 && gc.kept[0].id === "a" && gc.removed[0].id === "b", "gc drops routines on surfaces the agent left");
ok(gcOrphaned(rs, null).removed.length === 0, "gc with unknown membership keeps everything");

const mk = routineMarker({ [ROUTINE_MARKER.id]: "r-9", [ROUTINE_MARKER.surface]: "slack/T1/C9", [ROUTINE_MARKER.org]: "acme" });
ok(mk?.id === "r-9" && mk.surfaceKey === "slack/T1/C9" && mk.org === "acme", "routineMarker reads id + surfaceKey + org from attributes");
ok(routineMarker({ [ROUTINE_MARKER.id]: "r-9", [ROUTINE_MARKER.surface]: "slack/T1/C9" })?.org === "default", "routineMarker defaults org to 'default' (back-compat with pre-org markers)");
ok(routineMarker({ other: "x" }) === null, "routineMarker is null on a non-routine session");
ok(routineMarker(undefined) === null, "routineMarker is null when no attributes");
ok(routineMarker({ [ROUTINE_MARKER.id]: ["r-9"], [ROUTINE_MARKER.surface]: ["s"] })?.id === "r-9", "routineMarker collapses string[] attributes");

const dir = join(tmpdir(), `open-everywhere-routines-test-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
process.env.OE_ROUTINES_DIR = dir;

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

rmSync(dir, { recursive: true, force: true });

console.log(`✓ routines: ${passed} assertions passed`);
