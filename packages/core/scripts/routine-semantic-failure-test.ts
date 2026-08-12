import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { overrideSettingsForTest } from "../agent/settings/settings.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}
async function throwsAsync(fn: () => Promise<unknown>, match: RegExp, label: string): Promise<void> {
  try {
    await fn();
  } catch (err) {
    ok(match.test(String(err)), `${label} (message: ${String(err)})`);
    return;
  }
  ok(false, `${label} — expected a throw, got none`);
}

const dir = join(tmpdir(), `open-everywhere-routine-semantic-failure-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");
process.env.OE_ORG = "acme";
overrideSettingsForTest({ delegation: { oneshotAgent: false } });
overrideSettingsForTest({ window: { topology: false } });

const { applyOutcome, declareRunFailed, settleOutcome, MAX_CONSECUTIVE_FAILURES } = await import("../agent/routines/lifecycle.js");
const { ROUTINE_MARKER, RUN_FAILURE_REASON_MAX_CHARS, routineMarker } = await import("../agent/routines/routine.js");
const { RUN_FAILED_TOOL, renderFailureBlock, renderScheduledMessage, renderWatchMessage } = await import("../agent/routines/watch.js");
const { renderJobMessage } = await import("../agent/routines/job.js");
const { renderFireMessage } = await import("../agent/routines/fire-message.js");
const { eventPrompt } = await import("../agent/routines/events.js");
const { TOOL_CONSEQUENCE } = await import("../agent/access/consequence.js");
const { JOB_WAKE_TOOLS, WINDOW_GATED_TOOLS, WINDOW_UNGATED_TOOLS } = await import("../agent/access/window-gate-manifest.js");
const { allowedOnRestrictedJobWake, restrictToolsetForJobWake } = await import("../agent/access/job-posture.js");

type Routine = import("../agent/routines/routine.js").Routine;
type Domain = import("../agent/memory/domain.js").Domain;

const MIN = 60_000;

{
  ok(settleOutcome("ok", "failed") === "failed", "settleOutcome: a DECLARED failure beats a clean session end — the whole defect, in one call");
  ok(settleOutcome("failed", "failed") === "failed", "settleOutcome: a declared failure on a crashed session is still one failure, not two");
  ok(settleOutcome("ok", "skipped") === "skipped", "settleOutcome: a watch skip still survives a clean end (unchanged)");
  ok(settleOutcome("failed", "skipped") === "failed", "settleOutcome: a session-level failure still beats a recorded skip (unchanged)");
  ok(settleOutcome("ok", undefined) === "ok", "settleOutcome: nothing recorded ⇒ the session outcome stands (unchanged)");
  ok(settleOutcome("ok", "ok") === "ok", "settleOutcome: a recorded ok is not special-cased");

  const d = declareRunFailed("  payments API returned\n  500 twice  ");
  ok(d.reason === "payments API returned 500 twice", "declareRunFailed: trims and collapses whitespace — this lands in an audit row, not a document");
  ok(d.patch.lastOutcome === "failed", "declareRunFailed: the patch records the OUTCOME (what settleOutcome reads)");
  ok(d.patch.lastFailureReason === d.reason, "declareRunFailed: and the REASON (what the audit rows carry) — writing one without the other is the half-mechanism this ticket refuses");

  const long = declareRunFailed("x".repeat(RUN_FAILURE_REASON_MAX_CHARS + 500));
  ok(long.reason.length === RUN_FAILURE_REASON_MAX_CHARS, `declareRunFailed: TRUNCATES at ${RUN_FAILURE_REASON_MAX_CHARS} chars`);
  ok(long.patch.lastOutcome === "failed", "declareRunFailed: an over-long reason is truncated, NEVER rejected — a declaration that failed on length would leave the run recorded as a success");
  const blank = declareRunFailed("   \n  ");
  ok(blank.patch.lastOutcome === "failed" && blank.reason.length > 0, "declareRunFailed: an all-whitespace reason still declares the failure, with a stand-in reason");

  const base: Routine = {
    id: "r-pure",
    org: "acme",
    surfaceKey: "slack/T/C",
    trigger: { kind: "interval", everyMinutes: 15 },
    prompt: "check the payments API and report",
    createdAt: "2026-07-01T00:00:00.000Z",
    status: "active",
    consecutiveFailures: 0,
  };
  const at = new Date("2026-07-02T12:00:00.000Z");
  const failed = applyOutcome({ ...base, lastFailureReason: "api 500" }, "failed", at);
  ok(failed.lastFailureReason === "api 500", "applyOutcome: a `failed` settlement KEEPS the declared reason (the fold reads it back for the rows)");
  const recovered = applyOutcome({ ...base, consecutiveFailures: 2, lastFailureReason: "api 500" }, "ok", at);
  ok(recovered.lastFailureReason === undefined && recovered.consecutiveFailures === 0, "applyOutcome: a recovered run clears BOTH the counter and the reason — a diagnosis must not outlive the failure");
  ok(applyOutcome({ ...base, lastFailureReason: "api 500" }, "skipped", at).lastFailureReason === undefined, "applyOutcome: a `skipped` settlement clears it too");
  ok(
    applyOutcome({ ...base, status: "done", lastFailureReason: "api 500" }, "ok", at).lastFailureReason === undefined,
    "applyOutcome: the TERMINAL `done` branch clears it as well — it returns early, so it needs its own clear or a completed job keeps a stale diagnosis forever",
  );

  let r: Routine = { ...base };
  for (let i = 1; i <= MAX_CONSECUTIVE_FAILURES; i++) {
    r = applyOutcome({ ...r, ...declareRunFailed(`api 500 on attempt ${i}`).patch } as Routine, "failed", at);
  }
  ok(r.status === "disabled" && r.consecutiveFailures === MAX_CONSECUTIVE_FAILURES, `applyOutcome: ${MAX_CONSECUTIVE_FAILURES} DECLARED failures disable the routine, exactly as ${MAX_CONSECUTIVE_FAILURES} session crashes do`);
  ok(
    !(r.disabledReason ?? "").includes("api 500"),
    "applyOutcome: `disabledReason` stays HOST-COMPOSED — routines/disable-notice.ts posts it into the room past the silent-routine delivery gate, so model text must never reach it (routine.ts lastFailureReason §quarantine)",
  );
}

{
  ok(RUN_FAILED_TOOL === "report_run_failed", "the tool name is a single exported constant, so prompt and tool cannot drift");

  ok(WINDOW_UNGATED_TOOLS.has(RUN_FAILED_TOOL), "posture: report_run_failed is in WINDOW_UNGATED_TOOLS — available on EVERY grain, because semantic failure is not a property of a seat shape");
  ok(!(RUN_FAILED_TOOL in WINDOW_GATED_TOOLS), "posture: it is not ALSO grain-gated (double declaration fails the lint, and a withheld grain would be a fire that cannot report)");

  const tier = TOOL_CONSEQUENCE[RUN_FAILED_TOOL];
  ok(tier !== undefined, "consequence: report_run_failed carries an explicit tier (fail-closed lint would reject it otherwise)");
  ok(tier?.tier === "open", "consequence: OPEN — its entire reach is to make the routine do LESS; gating the honesty mechanism on an unattended path would disarm it");

  ok(JOB_WAKE_TOOLS.has(RUN_FAILED_TOOL), "job kit: an un-escalated, autonomous job fire KEEPS report_run_failed (JOB_WAKE_TOOLS is default-DENY — absence would silently withhold it)");
  ok(allowedOnRestrictedJobWake(RUN_FAILED_TOOL), "job kit: allowedOnRestrictedJobWake agrees (the policy function, not just the table)");
  {
    const toolset: Record<string, { description: string; execute: () => unknown }> = {};
    for (const name of [...Object.keys(WINDOW_GATED_TOOLS), ...WINDOW_UNGATED_TOOLS]) toolset[name] = { description: name, execute: () => ({}) };
    restrictToolsetForJobWake(toolset);
    ok(RUN_FAILED_TOOL in toolset, "job kit: it SURVIVES the real restricted-wake filter over a realistic assembled toolset — the filter, not the table, is what the model sees");
  }

  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const lockPath = join(repoRoot, "roster.lock.json");
  ok(existsSync(lockPath), "roster.lock.json exists — it is the app's committed record of what it mounts");
  const lock = JSON.parse(readFileSync(lockPath, "utf8")) as { packages: Record<string, { contributions: Record<string, string> }> };
  ok(
    lock.packages["@open-everywhere/core"]?.contributions[`tool/${RUN_FAILED_TOOL}`] === "mounted",
    "the roster MOUNTS report_run_failed — without that line the app mounts nothing and the tool is dead in prod",
  );

  const block = renderFailureBlock();
  ok(block.includes(RUN_FAILED_TOOL), "instruction: the health block names the tool");
  ok(
    block.includes(String(MAX_CONSECUTIVE_FAILURES)),
    "instruction: the threshold in the block is INTERPOLATED from MAX_CONSECUTIVE_FAILURES, not spelled out — a threshold change must not leave every fire quoting the old number",
  );
  ok(
    /did not|DID NOT/u.test(block) && /news/u.test(block),
    "instruction: it draws the ONLY distinction checkable from inside the turn — did the WORK happen, not was the NEWS good. Without the second clause a routine whose job is to report problems disables itself for doing it correctly (the classifier this design refuses)",
  );

  const plain: Routine = {
    id: "r-msg",
    org: "acme",
    surfaceKey: "slack/T/C",
    trigger: { kind: "interval", everyMinutes: 15 },
    prompt: "check the payments API and report",
    createdAt: "2026-07-01T00:00:00.000Z",
    status: "active",
    consecutiveFailures: 0,
  };
  ok(renderScheduledMessage(plain).includes(RUN_FAILED_TOOL), "instruction: a plain interval/cron fire is told");
  ok(
    renderWatchMessage({ id: plain.id, prompt: plain.prompt, createdAt: plain.createdAt }).includes(RUN_FAILED_TOOL),
    "instruction: a WATCH fire is told (its check can fail as easily as any other)",
  );
  ok(
    renderJobMessage({ id: plain.id, prompt: plain.prompt, createdAt: plain.createdAt }).includes(RUN_FAILED_TOOL),
    "instruction: a durable JOB fire is told",
  );
  ok(renderFireMessage({ ...plain, report: { kind: "silent" } }).includes(RUN_FAILED_TOOL), "instruction: a SILENT fire is told — its healthy state is also 'you hear nothing', so it is the one that most needs a non-prose way to say it broke");
  ok(renderFireMessage({ ...plain, trigger: { kind: "once", at: "2026-07-02T00:00:00.000Z" } }).includes(RUN_FAILED_TOOL), "instruction: a `once` fire is told");
  {
    const msg = eventPrompt({ prompt: "triage the issue" }, { summary: "issue opened: Fix the thing", url: "https://example.test/1" });
    ok(msg.includes(RUN_FAILED_TOOL), "instruction: an EVENT fire is told too — eventPrompt bypasses renderFireMessage, so it needs its own line");
    ok(
      msg.indexOf(RUN_FAILED_TOOL) < msg.indexOf("issue opened"),
      "instruction: and the trusted block sits BEFORE the untrusted payload — trusted instructions above the fence, attacker-controlled text below, which is the ordering the fence exists to keep",
    );
  }
}

const ORG = "acme";
const TEAM = "T_SEM";
const CHAN = "C_SEM";
const SURFACE = `slack/${TEAM}/${CHAN}`;

const { registerSlackTestBridge, registerSlackFixtureMapper } = await import("./_slack-test-stubs.js");
const { registerConfig } = await import("../agent/access/config.js");
const { defineDomain } = await import("../agent/memory/domain.js");

registerSlackTestBridge({ channel: { __fixture: "slack" } as never, confirmChannelInternal: async () => true });
registerSlackFixtureMapper();
const semDomain = defineDomain({ name: "payments", channels: [SURFACE] });
const DOMAINS: readonly Domain[] = [semDomain];
registerConfig({
  loadBundles: () => [],
  loadBindings: () => [],
  pluginRegistry: {},
  skillContent: {},
  loadDomains: () => [...DOMAINS],
  loadSilos: () => [],
  domainsForSurface: ({ surface }) => (surface === CHAN ? ["payments"] : []),
});

const dispatch = await import("../agent/schedules/dispatch.js");
const routineStore = await import("../agent/routines/store.js");
const { foldRoutineOutcome } = await import("../agent/routines/outcome-fold.js");
const { readAudit } = await import("../agent/audit/audit.js");
const { ROUTINE_AUDIT, resetRoutineSkipThrottle } = await import("../agent/routines/fire-audit.js");
const reportRunFailedTool = (await import("../agent/tools/report_run_failed.js")).default;

function routine(over: Partial<Routine> & Pick<Routine, "id">): Routine {
  return {
    org: ORG,
    surfaceKey: SURFACE,
    target: { channelId: CHAN },
    trigger: { kind: "interval", everyMinutes: 15 },
    prompt: "Check the payments API and report.",
    createdAt: "2026-07-01T00:00:00.000Z",
    status: "active",
    consecutiveFailures: 0,
    nextRunAt: "2026-07-02T12:00:00.000Z",
    ...over,
  };
}

interface Fire {
  readonly message: string;
  readonly attrs: Record<string, unknown>;
}
let fires: Fire[] = [];

const capturingReceive = (() => ({
  send: async (message: string, opts: { auth?: { attributes?: Record<string, unknown> } }) => {
    fires.push({ message: message ?? "", attrs: opts.auth?.attributes ?? {} });
  },
})) as never;

async function tick(now: Date): Promise<void> {
  const pending: Promise<unknown>[] = [];
  await dispatch.dispatchTick({
    now,
    to: capturingReceive,
    waitUntil: (p: Promise<unknown>) => void pending.push(p),
    appAuth: { attributes: {} },
    postJobKickoff: async () => "1700000000.0001",
  } as never);
  await Promise.all(pending);
}

async function runSession(fire: Fire, declare: string | undefined, sessionId: string): Promise<void> {
  const ctx = { channel: { kind: "slack" }, session: { id: sessionId, auth: { current: { attributes: fire.attrs, principalId: "", principalType: "slack-user" } } } };
  if (declare !== undefined) await reportRunFailedTool.execute({ reason: declare }, ctx as never);
  const marker = routineMarker(fire.attrs as never);
  ok(marker !== undefined && marker !== null, "e2e: the fire carries the routine marker the tool locates itself by");
  await foldRoutineOutcome({ marker: marker!, sessionOutcome: "ok", at: new Date(), sessionId });
}

{
  resetRoutineSkipThrottle();
  const id = "r-semantic";
  await routineStore.addRoutine({} as never, routine({ id }));

  const ticks = ["2026-07-02T12:05:00.000Z", "2026-07-02T12:20:00.000Z", "2026-07-02T12:40:00.000Z"];
  const reasons = ["payments API returned 500", "payments API returned 500 again", "payments API still 500"];
  for (let i = 0; i < ticks.length; i++) {
    fires = [];
    await tick(new Date(ticks[i]!));
    const fire = fires.find((f) => (f.attrs[ROUTINE_MARKER.id] as string | undefined) === id);
    ok(fire !== undefined, `e2e/${i + 1}: the routine fired and the delivery was ACCEPTED (a session started — the case the delivery fold cannot see)`);
    ok(fire!.message.includes(RUN_FAILED_TOOL), `e2e/${i + 1}: the message the model actually receives names the tool — end to end, not just in a renderer unit test`);

    await runSession(fire!, reasons[i]!, `sess-sem-${i + 1}`);
    const after = await routineStore.getRoutine(ORG, SURFACE, id);
    ok(
      after?.consecutiveFailures === i + 1,
      `e2e/${i + 1}: the counter is at ${i + 1} even though the SESSION COMPLETED CLEANLY — before this ticket it stayed 0 forever`,
    );
    ok(after?.lastOutcome === "failed", `e2e/${i + 1}: the run is recorded as failed, not ok`);
    if (i + 1 < MAX_CONSECUTIVE_FAILURES) {
      ok(after?.status === "active", `e2e/${i + 1}: not disabled yet — the three-strike rule is unchanged`);
      ok(after?.lastFailureReason === reasons[i]!, `e2e/${i + 1}: the declared words are on the row for the next fold to audit`);
    }
  }

  const final = await routineStore.getRoutine(ORG, SURFACE, id);
  ok(final?.status === "disabled", `e2e: THE FIX — ${MAX_CONSECUTIVE_FAILURES} cleanly-completing but SEMANTICALLY FAILED runs disable the routine`);
  ok(final?.nextRunAt === null, "e2e: and it stops consuming a per-tick concurrency slot");
  ok((final?.disabledReason ?? "").includes("consecutive failures"), "e2e: with the same host-composed reason a session-crash disable gets");

  fires = [];
  await tick(new Date("2026-07-02T13:00:00.000Z"));
  ok(!fires.some((f) => (f.attrs[ROUTINE_MARKER.id] as string | undefined) === id), "e2e: once disabled it is never dispatched again");

  const rows = await readAudit({ org: ORG, limit: 500 });
  const detail = (r: (typeof rows)[number]) => (r.detail ?? {}) as { routineId?: string; outcome?: string; declaredFailure?: string; consecutiveFailures?: number };
  const fireRows = rows.filter((r) => r.action === ROUTINE_AUDIT.fire && detail(r).routineId === id);
  ok(fireRows.length === MAX_CONSECUTIVE_FAILURES, `forensics: one routine.fire row per run (${MAX_CONSECUTIVE_FAILURES})`);
  ok(fireRows.every((r) => detail(r).outcome === "failed"), "forensics: every fire row says `failed`, not `ok` — the join row and the routine row agree");
  ok(
    reasons.every((reason) => fireRows.some((r) => detail(r).declaredFailure === reason)),
    "forensics: each run's own declared words ride ITS routine.fire row (`declaredFailure`) — so 'why is this about to disable itself' is answerable one run at a time",
  );
  const disabledRows = rows.filter((r) => r.action === ROUTINE_AUDIT.disabled && detail(r).routineId === id);
  ok(disabledRows.length === 1, "forensics: exactly ONE routine.disabled row — written on the transition");
  ok(detail(disabledRows[0]!).declaredFailure === reasons[MAX_CONSECUTIVE_FAILURES - 1]!, "forensics: the disable row carries the LAST declared reason — the diagnosis an operator reads before deciding whether to enable_routine");
  ok(detail(disabledRows[0]!).consecutiveFailures === MAX_CONSECUTIVE_FAILURES, "forensics: and the counter a reader will then see on the row");

  await routineStore.removeRoutine({ org: ORG, surfaceKey: SURFACE } as never, id);
}

{
  const id = "r-stale";
  await routineStore.addRoutine({} as never, routine({ id, nextRunAt: "2026-07-03T12:00:00.000Z" }));
  fires = [];
  await tick(new Date("2026-07-03T12:05:00.000Z"));
  const first = fires.find((f) => (f.attrs[ROUTINE_MARKER.id] as string | undefined) === id)!;
  await runSession(first, "transient DNS failure", "sess-stale-1");
  ok((await routineStore.getRoutine(ORG, SURFACE, id))?.lastFailureReason === "transient DNS failure", "staleness: run 1 declared, so its reason is on the row");

  fires = [];
  await tick(new Date("2026-07-03T12:20:00.000Z"));
  const second = fires.find((f) => (f.attrs[ROUTINE_MARKER.id] as string | undefined) === id)!;
  ok(
    (await routineStore.getRoutine(ORG, SURFACE, id))?.lastFailureReason === undefined,
    "staleness: THE FIRE CLEARED IT — a reason present when a fold reads the row was written by THAT run, the same invariant lastOutcome rests on",
  );
  await runSession(second, undefined, "sess-stale-2");
  const recovered = await routineStore.getRoutine(ORG, SURFACE, id);
  ok(recovered?.lastOutcome === "ok" && recovered.consecutiveFailures === 0, "recovery: a run that declares nothing and completes is still an `ok` — the mechanism is opt-in per run, so nothing regresses for a healthy routine");
  ok(recovered?.lastFailureReason === undefined, "recovery: and no diagnosis is left behind on a healthy row");
  const okFireRow = (await readAudit({ org: ORG, action: ROUTINE_AUDIT.fire, limit: 500 })).find(
    (r) => (r.detail as { routineId?: string; outcome?: string })?.routineId === id && (r.detail as { outcome?: string }).outcome === "ok",
  );
  ok(okFireRow !== undefined && !("declaredFailure" in ((okFireRow.detail ?? {}) as object)), "recovery: the healthy fire row carries NO declaredFailure — absence means 'nobody declared anything', so no reader has to learn a new default");
  await routineStore.removeRoutine({ org: ORG, surfaceKey: SURFACE } as never, id);
}

{
  await throwsAsync(
    async () => await reportRunFailedTool.execute({ reason: "x" }, { channel: { kind: "slack" }, session: { auth: { current: { attributes: {}, principalId: "U1", principalType: "slack-user" } } } } as never),
    /no routine attached/u,
    "isolation: an ordinary (non-fire) session cannot declare a routine failure — there is no id to supply, so one routine can never fail another",
  );
  await throwsAsync(
    async () =>
      await reportRunFailedTool.execute({ reason: "x" }, {
        channel: { kind: "slack" },
        session: {
          auth: {
            current: {
              attributes: { [ROUTINE_MARKER.id]: "r-ghost", [ROUTINE_MARKER.surface]: SURFACE, [ROUTINE_MARKER.org]: ORG },
              principalId: "",
              principalType: "slack-user",
            },
          },
        },
      } as never),
    /no longer exists/u,
    "isolation: a routine cancelled mid-run gets a legible error, not a silent write to nothing",
  );
}

{
  const id = "r-silent-fail";
  await routineStore.addRoutine({} as never, routine({ id, report: { kind: "silent" }, nextRunAt: "2026-07-04T12:00:00.000Z" }));
  fires = [];
  await tick(new Date("2026-07-04T12:05:00.000Z"));
  const fire = fires.find((f) => (f.attrs[ROUTINE_MARKER.id] as string | undefined) === id)!;
  ok(fire.attrs[ROUTINE_MARKER.silent] !== undefined, "silence: the fire is stamped silent (so its terminal prose WILL be dropped)");
  ok(fire.message.includes(RUN_FAILED_TOOL), "silence: and it is still told how to declare failure");
  await runSession(fire, "the report source was unreachable", "sess-silent-1");
  const after = await routineStore.getRoutine(ORG, SURFACE, id);
  ok(after?.consecutiveFailures === 1 && after.lastOutcome === "failed", "silence: a SILENT routine's declared failure lands — the gate only ever touches terminal prose, never a tool call");
  ok(after?.lastFailureReason === "the report source was unreachable", "silence: with its reason, so a routine whose healthy state is silence can still be diagnosed");
  await routineStore.removeRoutine({ org: ORG, surfaceKey: SURFACE } as never, id);
}

rmSync(dir, { recursive: true, force: true });
console.log(`✓ routine semantic failure (OPE-177): ${passed} assertions passed`);
