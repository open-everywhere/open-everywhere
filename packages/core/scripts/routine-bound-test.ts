
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { join } from "node:path";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

const dir = join(tmpdir(), `open-everywhere-routine-bound-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");
process.env.OE_ORG = "acme";
delete process.env.OE_ONESHOT_AGENT;
delete process.env.OE_WINDOW_TOPOLOGY;
delete process.env.OE_JOB_MAX_FIRES;
delete process.env.OE_JOB_MAX_DAYS;

const {
  DEFAULT_JOB_MAX_DAYS,
  DEFAULT_JOB_MAX_FIRES,
  MIN_FIRES_BEFORE_DEADLINE,
  checkBound,
  describeBound,
  describeBoundPolicy,
  jobBoundMaxDays,
  jobBoundMaxFires,
  mintJobBound,
  triggerPeriodMs,
} = await import("../agent/routines/bound.js");
const { MAX_CONSECUTIVE_FAILURES } = await import("../agent/routines/lifecycle.js");
const { DISPATCH_TICK_MINUTES } = await import("../agent/routines/schedule.js");
const { boundNoticeText, announceBoundExhausted } = await import("../agent/routines/disable-notice.js");

type Routine = import("../agent/routines/routine.js").Routine;

const DAY = 24 * 60 * 60_000;
const MIN = 60_000;

{
  ok(DEFAULT_JOB_MAX_DAYS === 7, "default deadline is 7 days — the same window every routine-history read in the product uses (fire-audit.ts FORENSIC_WINDOW_MS), so a ceiling never trips after its own evidence has aged out");
  ok(MIN_FIRES_BEFORE_DEADLINE === MAX_CONSECUTIVE_FAILURES, "the deadline's cadence floor REUSES the three-strike constant rather than inventing a second answer to 'how many attempts is a fair sample'");

  const hourlyFiresInDefaultWindow = 24 * DEFAULT_JOB_MAX_DAYS;
  ok(hourlyFiresInDefaultWindow === 168, "an HOURLY job fires 168 times in the default window");
  ok(
    DEFAULT_JOB_MAX_FIRES > hourlyFiresInDefaultWindow,
    "the fire cap is strictly ABOVE that — so every cadence at or slower than hourly retires on its DEADLINE (the dimension that is meaningful there), never surprised by the count",
  );
  ok(
    DEFAULT_JOB_MAX_FIRES < 2 * hourlyFiresInDefaultWindow,
    "…and not so far above that it stops binding: the cap is the runaway backstop, so it must sit just over the hourly crossover, not an order of magnitude past it",
  );
  const fastestFiresPerDay = (24 * 60) / DISPATCH_TICK_MINUTES;
  const fastestHoursToCap = (DEFAULT_JOB_MAX_FIRES / fastestFiresPerDay) * 24;
  ok(
    fastestHoursToCap < 48,
    `the FASTEST job OE can physically run (one fire per ${DISPATCH_TICK_MINUTES}-minute tick) is bounded in ${fastestHoursToCap.toFixed(0)}h — under two days, not the deadline's week`,
  );
}

{
  ok(jobBoundMaxFires() === DEFAULT_JOB_MAX_FIRES && jobBoundMaxDays() === DEFAULT_JOB_MAX_DAYS, "unset env ⇒ the defaults");
  process.env.OE_JOB_MAX_FIRES = "12";
  process.env.OE_JOB_MAX_DAYS = "2";
  ok(jobBoundMaxFires() === 12 && jobBoundMaxDays() === 2, "an operator can tighten (or widen) either dimension by env");
  for (const bad of ["0", "-5", "banana", ""]) {
    process.env.OE_JOB_MAX_FIRES = bad;
    ok(jobBoundMaxFires() === DEFAULT_JOB_MAX_FIRES, `a garbage override (${JSON.stringify(bad)}) falls back to the default rather than minting a nonsense ceiling`);
  }
  delete process.env.OE_JOB_MAX_FIRES;
  delete process.env.OE_JOB_MAX_DAYS;
}

{
  const from = new Date("2026-07-01T00:00:00.000Z");

  ok(triggerPeriodMs({ kind: "interval", everyMinutes: 15 }, from) === 15 * MIN, "period: an interval's cadence");
  ok(triggerPeriodMs({ kind: "cron", expr: "0 9 * * *" }, from) === DAY, "period: a daily cron's cadence, from the SAME math the dispatcher schedules on");
  ok(triggerPeriodMs({ kind: "once", at: "2026-07-02T00:00:00.000Z" }, from) === undefined, "period: a one-shot has none — it retires itself");
  ok(triggerPeriodMs({ kind: "event", source: "github" }, from) === undefined, "period: an event subscription has no clock (and can never be a job — create_routine refuses that pairing)");

  const fast = mintJobBound({ kind: "interval", everyMinutes: 15 }, from);
  ok(fast.maxFires === DEFAULT_JOB_MAX_FIRES, "mint: the fire cap is the flat runaway backstop");
  ok(Date.parse(fast.until!) - from.getTime() === DEFAULT_JOB_MAX_DAYS * DAY, "mint: a fast cadence gets the flat 7-day deadline (the fire cap is what actually binds it)");

  const weekly = mintJobBound({ kind: "cron", expr: "0 9 * * 1" }, from);
  const weeklySpanDays = (Date.parse(weekly.until!) - from.getTime()) / DAY;
  ok(weeklySpanDays === 7 * MIN_FIRES_BEFORE_DEADLINE, `mint: a WEEKLY cadence stretches the deadline to ${weeklySpanDays} days — three periods, so a slow job still gets a fair sample of runs instead of one`);
  ok(weeklySpanDays > DEFAULT_JOB_MAX_DAYS, "mint: …which is strictly longer than the flat default, i.e. the stretch really applies");

  const oneShot = mintJobBound({ kind: "once", at: "2026-07-02T00:00:00.000Z" }, from);
  ok(Date.parse(oneShot.until!) - from.getTime() === DEFAULT_JOB_MAX_DAYS * DAY, "mint: a trigger with no derivable period falls back to the flat default rather than to no bound at all");
}

{
  const at = (iso: string): Date => new Date(iso);
  const row = (over: Partial<Routine>): Pick<Routine, "bound" | "fireCount"> => over as never;

  ok(checkBound(row({}), at("2030-01-01T00:00:00.000Z")).exhausted === false, "verdict: NO bound ⇒ never exhausted — every pre-OPE-248 row and every plain routine is unbounded, and a daily digest is SUPPOSED to run forever");
  ok(checkBound(row({ bound: {} }), at("2030-01-01T00:00:00.000Z")).exhausted === false, "verdict: a bound with neither component set is not a ceiling");

  ok(checkBound(row({ bound: { maxFires: 3 }, fireCount: 2 }), at("2026-07-01T00:00:00.000Z")).exhausted === false, "verdict: under the cap runs");
  const atCap = checkBound(row({ bound: { maxFires: 3 }, fireCount: 3 }), at("2026-07-01T00:00:00.000Z"));
  ok(atCap.exhausted && atCap.dimension === "fires", "verdict: AT the cap is exhausted (>=, so `maxFires: 1` means one fire happens then it retires — never zero)");
  ok(atCap.exhausted && atCap.reason.includes("3") && /ceiling/i.test(atCap.reason), "verdict: the reason is HOST-COMPOSED from the row's own numbers — no model text ever rides the notice path");

  const past = checkBound(row({ bound: { until: "2026-07-01T00:00:00.000Z" } }), at("2026-07-01T00:00:00.001Z"));
  ok(past.exhausted && past.dimension === "deadline", "verdict: past the deadline is exhausted, and names the OTHER dimension — 'ran out of time' and 'ran out of tries' lead to different next moves");
  ok(checkBound(row({ bound: { until: "2026-07-01T00:00:00.000Z" } }), at("2026-06-30T23:59:59.999Z")).exhausted === false, "verdict: before the deadline runs");

  const both = checkBound(row({ bound: { maxFires: 3, until: "2026-07-01T00:00:00.000Z" }, fireCount: 9 }), at("2030-01-01T00:00:00.000Z"));
  ok(both.exhausted && both.dimension === "fires", "verdict: with BOTH tripped, the count is reported — most-specific-first, the same ordering checkCheckpoint uses");

  ok(checkBound(row({ bound: { until: "not-a-date" } }), at("2030-01-01T00:00:00.000Z")).exhausted === false, "verdict: a GARBAGE deadline is ignored, never read as expired — fail-open on the deadline, because the fire cap still binds");
  const garbageWithCap = checkBound(row({ bound: { until: "not-a-date", maxFires: 2 }, fireCount: 5 }), at("2030-01-01T00:00:00.000Z"));
  ok(garbageWithCap.exhausted && garbageWithCap.dimension === "fires", "verdict: …and the cap on the same garbage row still binds, so a broken date cannot buy an unbounded job");

  ok(describeBound(row({})) === null, "describe: an unbounded routine says nothing about ceilings at all");
  ok(describeBound(row({ bound: { maxFires: 200, until: "2026-08-05T00:00:00.000Z" }, fireCount: 12 })) === "12/200 runs, or until 2026-08-05T00:00:00.000Z", "describe: `list_routines` gets the ceiling AND the progress toward it — the only place 'how much longer will this job keep going?' is answerable");
  const policy = describeBoundPolicy({ kind: "interval", everyMinutes: 15 }, new Date("2026-07-01T00:00:00.000Z"));
  ok(/200 runs/.test(policy) && /7 days/.test(policy) && /whichever comes first/.test(policy), "describe: the CARD's line is RELATIVE — the card is frozen at propose time and the bound is minted at click, so an absolute date on it would be falsified by any gap between the two");
}

const ORG = "acme";
const CHAN = "C-BOUND";
const SURFACE = `slack/T1/${CHAN}`;

const { registerSlackTestBridge, registerSlackFixtureMapper, registerSlackFixtureCodec } = await import("./_slack-test-stubs.js");
registerSlackTestBridge();
registerSlackFixtureMapper();
registerSlackFixtureCodec();

const { registerConfig } = await import("../agent/access/config.js");
registerConfig({
  loadBundles: () => [],
  loadBindings: () => [],
  pluginRegistry: {},
  skillContent: {},
  loadDomains: () => [],
  loadSilos: () => [],
  domainsForSurface: () => [],
});

const notices: string[] = [];
let postDelayMs = 0;
const { registerPostArm } = await import("../agent/channels/post-arms.js");
registerPostArm({
  platform: "slack",
  dispatchUnified: async (_origin, text) => {
    if (postDelayMs > 0) await new Promise((r) => setTimeout(r, postDelayMs));
    notices.push(text);
    return "ts-notice";
  },
});

const dispatch = await import("../agent/schedules/dispatch.js");
const routineStore = await import("../agent/routines/store.js");
const { readAudit } = await import("../agent/audit/audit.js");
const { ROUTINE_AUDIT } = await import("../agent/routines/fire-audit.js");

function routine(over: Partial<Routine> & Pick<Routine, "id">): Routine {
  return {
    org: ORG,
    surfaceKey: SURFACE,
    target: { channelId: CHAN },
    trigger: { kind: "interval", everyMinutes: 15 },
    prompt: "Watch the release board and tell me when it goes green.",
    createdAt: "2026-07-01T00:00:00.000Z",
    status: "active",
    consecutiveFailures: 0,
    nextRunAt: "2026-07-02T12:00:00.000Z",
    ...over,
  };
}

let receives = 0;
const okReceive = (async () => {
  receives++;
}) as never;

async function tick(now: Date): Promise<void> {
  const pending: Promise<unknown>[] = [];
  await dispatch.dispatchTick({
    now,
    receive: okReceive,
    waitUntil: (p: Promise<unknown>) => void pending.push(p),
    appAuth: { attributes: {} },
    postJobKickoff: async () => "1700000000.0001",
  } as never);
  await Promise.all(pending);
}

{
  const id = "r-monitor";
  await routineStore.addRoutine({} as never, routine({ id, sessionMode: "job", bound: { maxFires: 3 }, fireCount: 0 }));

  const firesBefore = receives;
  await tick(new Date("2026-07-02T12:00:00.000Z"));
  await tick(new Date("2026-07-02T12:15:00.000Z"));
  await tick(new Date("2026-07-02T12:30:00.000Z"));
  const atCap = await routineStore.getRoutine(ORG, SURFACE, id);
  ok(receives - firesBefore === 3, "trip: three ticks, three fires — the ceiling does not interfere with a job that still has runs left");
  ok(atCap?.fireCount === 3, "trip: the counter is advanced in the SAME optimistic write that guards the double-fire, so it can never disagree with the schedule");
  ok(atCap?.status === "active", "trip: AT the cap the routine is still active — the count is checked before the NEXT fire, so a `maxFires: 3` job gets three runs, not two");
  ok(atCap?.consecutiveFailures === 0, "trip: nothing has failed — every single run succeeded, which is exactly why no pre-existing mechanism can stop this routine");
  ok(notices.length === 0, "trip: and nothing has been announced yet");

  await tick(new Date("2026-07-02T12:45:00.000Z"));
  const stopped = await routineStore.getRoutine(ORG, SURFACE, id);
  ok(receives - firesBefore === 3, "🔴 THE FENCE: the fourth tick does NOT fire — remove the ceiling and this is 4, and keeps climbing forever");
  ok(stopped?.status === "disabled", "🔴 THE FENCE: the routine STOPPED itself at its ceiling, with consecutiveFailures still 0 — no failure counter, no declared failure and no rejected delivery could ever have reached this case");
  ok(stopped?.consecutiveFailures === 0, "trip: …and it stops WITHOUT recording a failure, because nothing failed");
  ok(stopped?.status !== "done", "trip: it is `disabled`, NOT `done` — `done` means the job declared its objective finished (complete_job), and a job at its ceiling is precisely one that did not");
  ok(stopped?.nextRunAt === null, "trip: no next run — it stops consuming a per-tick concurrency slot");
  ok((stopped?.disabledReason ?? "").includes("ceiling"), "trip: the row carries a legible host-composed reason");
  ok(stopped?.fireCount === 3, "trip: the retiring tick does NOT count as a fire — it never fired");

  ok(notices.length === 1, "🔴 THE NOTICE: stopping POSTS, host-composed, exactly once — a ceiling that disabled the row silently would be strictly worse than no ceiling, because the routine would go quiet with nothing to read");
  const text = notices[0]!;
  ok(text.includes(id), "notice: names the routine");
  ok(/Nothing failed/i.test(text), "notice: leads with NOTHING FAILED — a reader who has learned to read a routine's stop as 'it broke' would otherwise misdiagnose a job that was working perfectly and simply never finished");
  ok(/start it again/i.test(text), "notice: gives the recovery action, which is one call away");
  ok(!/approve|confirm|click/i.test(text), "notice: it is a NOTICE, not an approval card — nobody is there to click at the hour a ceiling trips");

  const rows = await readAudit({ org: ORG, limit: 500 });
  const disabled = rows.filter((r) => r.action === ROUTINE_AUDIT.disabled && (r.detail as { routineId?: string } | undefined)?.routineId === id);
  ok(disabled.length === 1, "forensics: exactly ONE routine.disabled row, on the transition");
  const detail = (disabled[0]?.detail ?? {}) as Record<string, unknown>;
  ok(detail["boundDimension"] === "fires", "forensics: the row names WHICH dimension tripped — raise the cap vs. re-arm as-is are different next moves");
  ok(detail["fireCount"] === 3 && detail["maxFires"] === 3, "forensics: …with the numbers behind it");
  ok(detail["consecutiveFailures"] === 0, "forensics: zero failures on a routine.disabled row is the signature of a ceiling stop, and a different incident from one that broke three times");

  const auditBefore = rows.length;
  await tick(new Date("2026-07-02T13:00:00.000Z"));
  ok((await readAudit({ org: ORG, limit: 500 })).length === auditBefore, "trip: a retired routine is not dispatched again — no second disable row, no second notice");
  ok(notices.length === 1, "trip: …and no repeated announcement");
}

{
  const id = "r-expired";
  await routineStore.addRoutine(
    {} as never,
    routine({ id, sessionMode: "job", bound: { until: "2026-07-02T00:00:00.000Z", maxFires: 200 }, fireCount: 0, target: undefined }),
  );
  const before = receives;
  await tick(new Date("2026-07-02T12:00:00.000Z"));
  const gone = await routineStore.getRoutine(ORG, SURFACE, id);
  ok(gone?.status === "disabled", "🔴 deadline: an EXPIRED job retires even though its fire count never moved — the deadline is the only thing that can ever end a routine whose target never resolves");
  ok(receives === before, "deadline: and it never fired");
  ok((gone?.disabledReason ?? "").includes("ceiling"), "deadline: same host-composed reason shape");
  const rows = await readAudit({ org: ORG, limit: 500 });
  const detail = (rows.find((r) => r.action === ROUTINE_AUDIT.disabled && (r.detail as { routineId?: string } | undefined)?.routineId === id)?.detail ?? {}) as Record<string, unknown>;
  ok(detail["boundDimension"] === "deadline", "deadline: the forensic row names the deadline, not the count");
}

{
  const id = "r-plain";
  await routineStore.addRoutine({} as never, routine({ id }));
  const before = receives;
  for (const t of ["12:00", "12:15", "12:30", "12:45", "13:00"]) await tick(new Date(`2026-07-03T${t}:00.000Z`));
  const plain = await routineStore.getRoutine(ORG, SURFACE, id);
  ok(receives - before === 5, "parity: an unbounded routine fires on every tick, forever — nothing about a plain routine changed");
  ok(plain?.status === "active", "parity: …and never retires itself");
  ok(plain?.fireCount === undefined, "parity: no counter is written onto an unbounded row at all — its stored JSON is byte-identical to a pre-OPE-248 one");
}

{
  const id = "r-await";
  await routineStore.addRoutine({} as never, routine({ id, sessionMode: "job", bound: { maxFires: 1 }, fireCount: 5 }));
  const noticesBefore = notices.length;
  postDelayMs = 5;
  await dispatch.dispatchTick({
    now: new Date("2026-07-04T12:00:00.000Z"),
    receive: okReceive,
    waitUntil: () => undefined,
    appAuth: { attributes: {} },
    postJobKickoff: async () => "1700000000.0001",
  } as never);
  postDelayMs = 0;
  ok(
    notices.length === noticesBefore + 1,
    "🔴 AWAITED: the ceiling's notice has ALREADY landed when dispatchTick resolves, across a real macrotask timer — a floated retire would be byte-identical to no fence at all, and this is the only leg that can tell them apart",
  );
  ok((await routineStore.getRoutine(ORG, SURFACE, id))?.status === "disabled", "awaited: …and the row is terminal by then too");
}

{
  const verdict = { exhausted: true, dimension: "fires", reason: "it ran 200 times without finishing (its ceiling is 200 runs)" } as const;
  const job = routine({ id: "r-notice", sessionMode: "job", prompt: "Chase   the\n  migration." });

  ok(boundNoticeText(job, verdict).startsWith("⏹️ Job `r-notice`"), "notice: a durable job is called a job");
  ok(boundNoticeText(routine({ id: "r-n2" }), verdict).startsWith("⏹️ Routine `r-n2`"), "notice: a plain routine is called a routine");
  ok(boundNoticeText(job, verdict).includes("> Chase the migration."), "notice: the prompt is whitespace-collapsed — this lands in a room, not a document");
  ok(!boundNoticeText(job, verdict).includes("only sign of it"), "notice: an ordinary job gets no silent-specific line");
  ok(boundNoticeText({ ...job, report: { kind: "silent" } }, verdict).includes("only sign of it"), "notice: a SILENT job's notice says why this message matters — nothing else would ever have told you it existed");

  const posts: string[] = [];
  const origin = { platform: "slack", channelId: "C1" };
  ok(
    (await announceBoundExhausted(job, verdict, { resolveTarget: (() => ({ origin })) as never, post: async (_o, t) => (posts.push(t), "ts-1") })) === true && posts.length === 1,
    "notice: posts exactly one message through the routine's own dispatch origin — the same arm a fire's reply takes, not a second delivery mechanism",
  );
  ok((await announceBoundExhausted(job, verdict, { resolveTarget: (() => null) as never })) === false, "notice: an unresolvable target skips it rather than guessing a room (the audit row still stands)");
  ok(
    (await announceBoundExhausted(job, verdict, {
      resolveTarget: (() => ({ origin })) as never,
      post: async () => {
        throw new Error("slack 429");
      },
    })) === false,
    "notice: a FAILED post is swallowed — the store write and the audit row have already landed, and a posting hiccup must never undo them",
  );
}

console.log(`✓ routine-bound: ${passed} assertions passed`);
