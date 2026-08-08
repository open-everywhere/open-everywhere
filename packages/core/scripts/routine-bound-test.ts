
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
const okReceive = (() => ({
  send: async () => {
    receives++;
  },
})) as never;

async function tick(now: Date): Promise<void> {
  const pending: Promise<unknown>[] = [];
  await dispatch.dispatchTick({
    now,
    to: okReceive,
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
    to: okReceive,
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

const { MAX_STALLED_FIRES, describeStall, stallExhausted, stallFoldPatch, stallResetPatch } = await import("../agent/routines/stall.js");
const { boundExhaustedPatch } = await import("../agent/routines/bound.js");

async function quietStore(except: string): Promise<void> {
  for (const r of await routineStore.listRoutines({ org: ORG, surfaceKey: SURFACE } as never)) {
    if (r.status === "active" && r.id !== except) await routineStore.updateRoutine(ORG, SURFACE, r.id, { status: "disabled", nextRunAt: null });
  }
}

{
  ok(MAX_STALLED_FIRES === MAX_CONSECUTIVE_FAILURES, "stall: the limit REUSES the three-strike constant — a stall run is the same 'how many attempts is a fair sample' question, and a second constant would be a second answer to it");

  const row = (over: Partial<Routine>): Pick<Routine, "bound" | "fireCount" | "stalledFires"> => over as never;
  ok(stallExhausted({ stalledFires: undefined }) === false, "stall: an absent counter is not stalling — every pre-OPE-253 row, and every routine on a deployment with no configured checkpoint");
  ok(stallExhausted({ stalledFires: MAX_STALLED_FIRES - 1 }) === false, "stall: under the limit runs");
  ok(stallExhausted({ stalledFires: MAX_STALLED_FIRES }) === true, "stall: AT the limit is exhausted (>=, so the run that trips it has already happened — the check runs before the NEXT dispatch)");

  const at = new Date("2030-01-01T00:00:00.000Z");
  const stalled = checkBound(row({ bound: { maxFires: 200 }, fireCount: 4, stalledFires: MAX_STALLED_FIRES }), at);
  ok(stalled.exhausted && stalled.dimension === "stalled", "🔴 THE VERDICT: a job blocked MAX_STALLED_FIRES fires running is exhausted, on its own dimension — remove the stall check from checkBound and this job runs until its 200-fire ceiling instead, doing nothing on every one of them");
  ok(stalled.exhausted && /cost checkpoint/i.test(stalled.reason) && stalled.reason.includes(String(MAX_STALLED_FIRES)), "verdict: the reason is HOST-COMPOSED from the row's own numbers and NAMES the cause — no model text rides the notice path");

  const bothTripped = checkBound(row({ bound: { maxFires: 3, until: "2026-07-01T00:00:00.000Z" }, fireCount: 9, stalledFires: MAX_STALLED_FIRES }), at);
  ok(
    bothTripped.exhausted && bothTripped.dimension === "stalled",
    "🔴 ORDER: with the stall AND the fire cap AND the deadline all tripped, the STALL is what gets reported — move the check below the fire cap and the operator is told to re-arm a job that will stall again on its very next fire",
  );

  ok(checkBound(row({ stalledFires: 99 }), at).exhausted === false, "stall: an UNBOUNDED routine is never retired by a stall run — stall-reaping is keyed on carrying a ceiling, the same key fireCount is written under, and a daily digest is SUPPOSED to run forever");

  ok(boundExhaustedPatch(stalled as never).disabledReason?.startsWith("stopped because it was blocked") === true, "stall: the row's own reason says BLOCKED, not 'at its ceiling' — the job never got to spend its ceiling, and disabledReason is what list_routines, the CLI and the re-arm card all show");
  ok(boundExhaustedPatch({ exhausted: true, dimension: "fires", reason: "x" }).disabledReason?.startsWith("stopped at its ceiling") === true, "stall: …and a genuine ceiling stop still reads as one");
}

{
  ok(Object.keys(stallFoldPatch({ stalledFires: undefined, lastStallAt: undefined })).length === 0, "fold: a routine that has never stalled and did not stall this fire gets a BYTE-IDENTICAL patch — no field is written onto it at all");
  ok(stallFoldPatch({ stalledFires: undefined, lastStallAt: "2026-07-02T12:00:00.000Z" }).stalledFires === 1, "fold: a fire that recorded a stall starts the run at 1");
  ok(stallFoldPatch({ stalledFires: 2, lastStallAt: "2026-07-02T12:00:00.000Z" }).stalledFires === 3, "fold: …and extends it");
  const cleared = stallFoldPatch({ stalledFires: 2, lastStallAt: undefined });
  ok("stalledFires" in cleared && cleared.stalledFires === undefined, "🔴 CONSECUTIVE: a fire that got its hands CLEARS the run — drop this and a job that stalled three times across months of healthy work retires as though it had stalled three times running");
  ok(stallResetPatch().stalledFires === undefined && stallResetPatch().lastStallAt === undefined, "reset: a re-arm clears BOTH — leaving lastStallAt would have the next fold count a stall from before the re-arm");

  ok(describeStall({ stalledFires: 0, lastStallAt: undefined }) === null, "describe: a routine that is not stalling says nothing about stalls at all");
  const d = describeStall({ stalledFires: 2, lastStallAt: "2026-07-30T03:00:00.000Z" }) ?? "";
  ok(/cost checkpoint/.test(d) && d.includes(`2/${MAX_STALLED_FIRES}`) && d.includes("2026-07-30T03:00:00.000Z"), "describe: list_routines gets the cause, the progress toward the limit AND when it last happened — 'waiting on a human click' and 'running fine' were the same reading of a job before this field");
}

{
  const fold = await import("../agent/routines/outcome-fold.js");
  const id = "r-stallfold";
  await routineStore.addRoutine({} as never, routine({ id, sessionMode: "job", bound: { maxFires: 200 }, fireCount: 1, lastStallAt: "2026-07-05T12:00:00.000Z" }));
  const marker = { id, surfaceKey: SURFACE, org: ORG };

  await fold.foldRoutineOutcome({ marker, sessionOutcome: "ok", at: new Date("2026-07-05T12:00:05.000Z"), sessionId: "s-1" });
  const one = await routineStore.getRoutine(ORG, SURFACE, id);
  ok(one?.stalledFires === 1, "🔴 THE COUNT: the fold turns the mid-turn stall FACT into a run — remove stallFoldPatch from foldRoutineOutcome and a stalled fire leaves the row indistinguishable from a healthy one");
  ok(one?.lastOutcome === "ok" && one?.consecutiveFailures === 0, "fold: …on a fire that settled OK with zero failures, which is why consecutiveFailures, report_run_failed and the delivery fold are all structurally blind to it");
  ok(one?.status === "active", "fold: one stall does not stop it — the card may yet be answered");

  await routineStore.updateRoutine(ORG, SURFACE, id, { lastStallAt: "2026-07-05T12:15:00.000Z" });
  await fold.foldRoutineOutcome({ marker, sessionOutcome: "ok", at: new Date("2026-07-05T12:15:05.000Z"), sessionId: "s-2" });
  ok((await routineStore.getRoutine(ORG, SURFACE, id))?.stalledFires === 2, "fold: a second blocked fire extends the run");

  await routineStore.updateRoutine(ORG, SURFACE, id, { lastStallAt: undefined });
  await fold.foldRoutineOutcome({ marker, sessionOutcome: "ok", at: new Date("2026-07-05T12:30:05.000Z"), sessionId: "s-3" });
  const healed = await routineStore.getRoutine(ORG, SURFACE, id);
  ok(healed?.stalledFires === undefined, "🔴 CONSECUTIVE, end to end: one fire that was NOT blocked resets the run to nothing");
}

{
  const id = "r-stallclear";
  await routineStore.addRoutine(
    {} as never,
    routine({ id, sessionMode: "job", bound: { maxFires: 200 }, fireCount: 0, stalledFires: 1, lastStallAt: "2026-07-06T11:00:00.000Z", nextRunAt: "2026-07-06T12:00:00.000Z" }),
  );
  await quietStore(id);
  await tick(new Date("2026-07-06T12:00:00.000Z"));
  const fired = await routineStore.getRoutine(ORG, SURFACE, id);
  ok(fired?.lastRunAt === "2026-07-06T12:00:00.000Z", "clear: the routine fires (one stall is under the limit)");
  ok(
    fired?.lastStallAt === undefined,
    "🔴 THE INVARIANT: the dispatcher CLEARS lastStallAt at fire, alongside lastOutcome — delete that line and a routine that was blocked ONCE has the fact on its row forever, so every later fold counts a stall that never happened and the job retires on a run it did not have",
  );
  ok(fired?.stalledFires === 1, "clear: …while the RUN so far is untouched — the fact is per-fire, the count is not");
  ok(fired?.fireCount === 1, "clear: and the fire counted toward the OPE-248 ceiling like any other — a blocked fire still woke the session, ran a turn and billed tokens");
}

{
  const fold = await import("../agent/routines/outcome-fold.js");
  const id = "r-stallrec";
  await routineStore.addRoutine({} as never, routine({ id, sessionMode: "job", bound: { maxFires: 200 }, fireCount: 2, stalledFires: 1 }));
  const marker = { id, surfaceKey: SURFACE, org: ORG };
  const reason = "this session reached its cost checkpoint (5,000,000 / 5,000,000 tokens)";

  ok(await fold.recordCheckpointStall({ marker, tool: "remember", reason, at: new Date("2026-07-07T12:00:00.000Z") }), "recorder: the first refusal of a fire records the stall");
  const stamped = await routineStore.getRoutine(ORG, SURFACE, id);
  ok(stamped?.lastStallAt === "2026-07-07T12:00:00.000Z", "recorder: …as the per-fire FACT on the row");
  ok(stamped?.stalledFires === 1, "recorder: it does NO arithmetic — the count is the fold's job, which is what lets a clean fire break the run");

  ok((await fold.recordCheckpointStall({ marker, tool: "open_pull_request", reason })) === false, "🔴 IDEMPOTENT PER FIRE: a second refusal in the same fire records nothing — remove the already-set early return and one fire writes a row per blocked tool, inflating the run and the audit trail together");
  const rows = (await readAudit({ org: ORG, limit: 1000 })).filter((r) => r.action === ROUTINE_AUDIT.stalled && (r.detail as { routineId?: string } | undefined)?.routineId === id);
  ok(rows.length === 1, "recorder: exactly ONE routine.stalled forensic row for the fire");
  const detail = (rows[0]?.detail ?? {}) as Record<string, unknown>;
  ok(detail["tool"] === "remember" && String(detail["reason"]).includes("cost checkpoint"), "forensics: the row names the refused tool and the checkpoint's own reason — before this, a durable job's 2nd..200th blocked fire wrote NOTHING anywhere (checkpoint.trip is once per session, and a job resumes one session across every fire)");
  ok(detail["stalledFires"] === 2, "forensics: …and the run this fire EXTENDS, stated as the count including this fire rather than the stored one, which would be off by one for every reader");

  ok((await fold.recordCheckpointStall({ marker: { id: "r-gone", surfaceKey: SURFACE, org: ORG }, tool: "remember", reason })) === false, "recorder: a routine cancelled between the fire and the refusal is a no-op, never a throw — this runs inside a guard whose own job is to throw a specific recoverable error");
}

{
  const id = "r-stalled";
  await routineStore.addRoutine(
    {} as never,
    routine({ id, sessionMode: "job", bound: { maxFires: 200, until: "2030-01-01T00:00:00.000Z" }, fireCount: 3, stalledFires: MAX_STALLED_FIRES, lastStallAt: "2026-07-08T11:45:00.000Z", nextRunAt: "2026-07-08T12:00:00.000Z" }),
  );
  await quietStore(id);
  const noticesBefore = notices.length;
  await tick(new Date("2026-07-08T12:00:00.000Z"));
  const stopped = await routineStore.getRoutine(ORG, SURFACE, id);
  ok(stopped?.fireCount === 3 && stopped?.lastRunAt === undefined, "🔴 THE FENCE: a job blocked MAX_STALLED_FIRES fires running does NOT fire again — its fire count and last-run are untouched, with 197 runs and years left on its ceiling, so nothing else in the tree would have stopped it");
  ok(stopped?.status === "disabled" && stopped?.nextRunAt === null, "trip: it stopped itself, terminally, and stops consuming a per-tick concurrency slot");
  ok(stopped?.consecutiveFailures === 0, "trip: with consecutiveFailures still 0 — every one of those fires SUCCEEDED, which is exactly why the three-strike fold could never reach this");
  ok(stopped?.status !== "done", "trip: `disabled`, not `done` — the job did not declare its objective finished, it was never allowed to work on it");

  ok(notices.length === noticesBefore + 1, "🔴 THE NOTICE: stopping POSTS, exactly once, through the routine's OWN dispatch origin — the same arm a fire's reply takes, not a second delivery mechanism");
  const text = notices[notices.length - 1]!;
  ok(text.includes(id), "notice: names the routine");
  ok(/BLOCKED/.test(text) && /cost checkpoint/i.test(text), "🔴 THE DIAGNOSIS: the notice says it was BLOCKED and names the cost checkpoint — remove the dimension branch and a stalled job reports the CEILING's story instead");
  ok(!/Nothing failed: it just never finished/.test(text), "🔴 THE DIAGNOSIS: …and it does NOT claim 'nothing failed, it just never finished', which is the ceiling's line and a false diagnosis here — it points the operator at re-arm when the truth is unblock-then-re-arm");
  ok(/raise the cost checkpoint|Answer that card/i.test(text) && /THEN/.test(text), "notice: it names the step that has to happen BEFORE a re-arm, which is the whole reason the two stops read differently");

  const disabledRows = (await readAudit({ org: ORG, limit: 1000 })).filter((r) => r.action === ROUTINE_AUDIT.disabled && (r.detail as { routineId?: string } | undefined)?.routineId === id);
  ok(disabledRows.length === 1, "forensics: exactly ONE routine.disabled row, on the transition");
  const d = (disabledRows[0]?.detail ?? {}) as Record<string, unknown>;
  ok(d["boundDimension"] === "stalled", "🔴 forensics: the row names the STALL dimension — 'ran out of tries', 'ran out of time' and 'was never allowed to work' are three different incidents and three different next moves");
  ok(d["stalledFires"] === MAX_STALLED_FIRES && d["fireCount"] === 3, "forensics: …with the stall run AND the fires it burned, so 'how much of the ceiling went on doing nothing?' is answerable");

  await import("../agent/approvals/routine-lifecycle.js");
  const { actionKind } = await import("../agent/approvals/actions.js");
  const enable = actionKind("routine.enable");
  ok(enable !== undefined, "re-arm: the routine.enable ActionKind is registered");
  const card = (enable!.summarize as (a: unknown) => string[])({
    org: ORG,
    partition: { org: ORG, platform: "slack", workspace: "T1", surface: CHAN, surfaceKey: SURFACE, workspaceKey: "slack/T1" },
    surfaceKey: SURFACE,
    id,
    description: "every 15 minutes",
    disabledReason: stopped?.disabledReason ?? "",
    consecutiveFailures: 0,
    prompt: stopped?.prompt ?? "",
    trigger: { kind: "interval", everyMinutes: 15 },
    requestedBy: "U1",
    bounded: true,
    stalled: true,
  }).join("\n");
  ok(/cost checkpoint/i.test(card) && /FIRST/.test(card), "🔴 THE CARD: a re-arm of a STALLED routine says the checkpoint has to be cleared FIRST — without it the clicker recovers the job into an identical incident three fires later");

  await enable!.execute(
    {
      org: ORG,
      partition: { org: ORG, platform: "slack", workspace: "T1", surface: CHAN, surfaceKey: SURFACE, workspaceKey: "slack/T1" },
      surfaceKey: SURFACE,
      id,
      description: "every 15 minutes",
      disabledReason: stopped?.disabledReason ?? "",
      consecutiveFailures: 0,
      prompt: stopped?.prompt ?? "",
      trigger: { kind: "interval", everyMinutes: 15 },
      requestedBy: "U1",
      bounded: true,
      stalled: true,
    } as never,
    "U-APPROVER",
  );
  const rearmed = await routineStore.getRoutine(ORG, SURFACE, id);
  ok(rearmed?.status === "active", "re-arm: the row is active again, keeping its id, ledger and thread");
  ok(rearmed?.stalledFires === undefined && rearmed?.lastStallAt === undefined, "re-arm: the stall run AND the per-fire fact are both cleared");
  ok(rearmed?.fireCount === 0, "re-arm: and the ceiling starts again from zero (OPE-248)");

  await quietStore(id);
  await tick(new Date(Date.parse(rearmed?.nextRunAt ?? "2026-07-08T12:30:00.000Z") + 1000));
  const ran = await routineStore.getRoutine(ORG, SURFACE, id);
  ok(
    ran?.fireCount === 1 && ran?.status === "active",
    "🔴 THE SHARPEST EDGE: a re-armed job FIRES — drop stallResetPatch() from the re-arm click and its fireCount stays 0 and its status flips straight back to disabled, because checkBound retires it before dispatch on the very next tick: 'enable didn't work', and the routine never runs again",
  );
}

{
  const id = "r-nostall";
  await routineStore.addRoutine({} as never, routine({ id, sessionMode: "job", bound: { maxFires: 200 }, fireCount: 0, nextRunAt: "2026-07-09T12:00:00.000Z" }));
  await quietStore(id);
  for (const t of ["12:00", "12:15", "12:30"]) await tick(new Date(`2026-07-09T${t}:00.000Z`));
  const clean = await routineStore.getRoutine(ORG, SURFACE, id);
  ok(clean?.fireCount === 3, "parity: a job nothing ever blocked fires on every tick");
  ok(clean?.stalledFires === undefined && clean?.lastStallAt === undefined, "parity: …and NEITHER stall field is ever written onto its row — its stored JSON is byte-identical to a pre-OPE-253 one, which is every row on every deployment with no configured spend checkpoint");
}

console.log(`✓ routine-bound: ${passed} assertions passed`);
