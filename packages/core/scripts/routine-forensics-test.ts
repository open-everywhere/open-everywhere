
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { overrideSettingsForTest } from "../agent/settings/settings.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

const dir = join(tmpdir(), `open-everywhere-routine-forensics-test-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");
process.env.OE_ORG = "acme";
overrideSettingsForTest({ routines: { maxConcurrency: 3 } });
overrideSettingsForTest({ routines: { eventMaxFanout: 3 } });

const { registerSlackTestBridge, registerSlackFixtureMapper } = await import("./_slack-test-stubs.js");
const fireAudit = await import("../agent/routines/fire-audit.js");
const { ROUTINE_AUDIT } = fireAudit;
const { readAudit, appendAudit } = await import("../agent/audit/audit.js");
const store = await import("../agent/routines/store.js");
const usageEvents = await import("../agent/spend/usage-events.js");
const { FakeEveContext, inEveContext } = await import("./_eve-context-stub.js");
const { ROUTINE_MARKER } = await import("../agent/routines/routine.js");
const { OE_WAKE_ID_ATTR } = await import("../agent/channels/unified-window.js");
const { SCHEDULE_APP_AUTHENTICATOR, SCHEDULE_APP_PRINCIPAL_ID, SCHEDULE_APP_PRINCIPAL_TYPE } = await import("../agent/identity/binding.js");
const { MAX_CONSECUTIVE_FAILURES } = await import("../agent/routines/lifecycle.js");
const outcomeHook = (await import("../agent/hooks/routine-outcome.js")).default;
const spendHook = (await import("../agent/hooks/spend.js")).default;
const { routineIdOf } = await import("../agent/hooks/spend.js");
const listRoutinesTool = (await import("../agent/tools/list_routines.js")).default;
const { fanOutDelivery } = await import("../agent/routines/github-fanout.js");
const dispatch = await import("../agent/schedules/dispatch.js");
type Routine = import("../agent/routines/routine.js").Routine;
type AuditInput = import("../agent/operational/store.js").AuditInput;

const SLACK_CHANNEL = { __fixture: "slack" } as never;
registerSlackTestBridge({ channel: SLACK_CHANNEL, confirmChannelInternal: async () => true });
registerSlackFixtureMapper();

const ORG = "acme";
const SURFACE = "slack/T1/C1";

function routine(over: Partial<Routine> & Pick<Routine, "id">): Routine {
  return {
    org: ORG,
    surfaceKey: SURFACE,
    target: { channelId: "C1" },
    trigger: { kind: "interval", everyMinutes: 30 },
    prompt: "Post the morning digest.",
    createdAt: "2026-07-01T00:00:00.000Z",
    status: "active",
    consecutiveFailures: 0,
    ...over,
  };
}

function firedCtx(r: Routine, sessionId: string, wakeId = `wake-${sessionId}`): never {
  return {
    channel: { kind: "slack" },
    session: {
      id: sessionId,
      auth: {
        current: {
          attributes: {
            team_id: "T1",
            channel_id: "C1",
            channel_type: "channel",
            [OE_WAKE_ID_ATTR]: wakeId,
            [ROUTINE_MARKER.id]: r.id,
            [ROUTINE_MARKER.surface]: r.surfaceKey,
            [ROUTINE_MARKER.org]: r.org,
          },
          authenticator: SCHEDULE_APP_AUTHENTICATOR,
          principalId: SCHEDULE_APP_PRINCIPAL_ID,
          principalType: SCHEDULE_APP_PRINCIPAL_TYPE,
        },
      },
    },
  } as never;
}

async function fireOnce(ctx: never, end: "turn.completed" | "turn.failed" = "turn.completed"): Promise<void> {
  await inEveContext(new FakeEveContext(), async () => {
    await outcomeHook.events!["turn.started"]!({} as never, ctx);
    await outcomeHook.events![end]!({} as never, ctx);
  });
}

const rowsFor = async (action: string): Promise<AuditInput[]> => (await readAudit({ org: ORG, action })) as AuditInput[];
const detailOf = (row: AuditInput | undefined, key: string): unknown => row?.detail?.[key];

{
  const r = routine({ id: "r-join" });
  await store.addRoutine({ org: ORG, surfaceKey: SURFACE } as never, r);
  await fireOnce(firedCtx(r, "sess-join"));

  const fires = await rowsFor(ROUTINE_AUDIT.fire);
  ok(fires.length === 1, "join: a completed fire writes exactly ONE routine.fire row");
  ok(detailOf(fires[0], "routineId") === "r-join", "join: the row names the ROUTINE");
  ok(detailOf(fires[0], "sessionId") === "sess-join", "join: the SAME row names the resulting SESSION — the handle for GET /control/v1/session/:id/transcript");
  ok(detailOf(fires[0], "outcome") === "ok", "join: the row carries the settled outcome");
  ok(fires[0]!.platform === "slack" && fires[0]!.workspace === "T1" && fires[0]!.surface === "C1", "join: the row is attributed to the routine's own partition");
  ok(fires[0]!.principalId === fireAudit.ROUTINE_DISPATCHER_PRINCIPAL, "join: the actor is the synthetic dispatcher principal — a fire invents no human");
}

{
  const before = (await rowsFor(ROUTINE_AUDIT.fire)).length;
  await fireOnce({
    channel: { kind: "slack" },
    session: { id: "sess-human", auth: { current: { attributes: { team_id: "T1", channel_id: "C1" }, principalId: "U1" } } },
  } as never);
  ok((await rowsFor(ROUTINE_AUDIT.fire)).length === before, "join: an ordinary (non-routine) turn writes NO fire row");
}

{
  const r = routine({ id: "r-once", consecutiveFailures: 2 });
  await store.addRoutine({ org: ORG, surfaceKey: SURFACE } as never, r);
  const ctx = firedCtx(r, "sess-once");

  const fireSession = new FakeEveContext();
  await inEveContext(fireSession, async () => {
    await outcomeHook.events!["turn.started"]!({} as never, ctx);
    await outcomeHook.events!["turn.completed"]!({} as never, ctx);
    await outcomeHook.events!["turn.failed"]!({} as never, ctx);
    await outcomeHook.events!["session.failed"]!({} as never, ctx);
  });
  const fires = (await rowsFor(ROUTINE_AUDIT.fire)).filter((e) => detailOf(e, "routineId") === "r-once");
  ok(fires.length === 1, "idempotence: one armed fire folds exactly ONCE across turn.completed + turn.failed + session.failed");
  ok(detailOf(fires[0], "outcome") === "ok", "idempotence: the FIRST turn end wins — the trailing failure edges are no-ops, not a re-settle");
  ok((await store.getRoutine(ORG, SURFACE, "r-once"))?.consecutiveFailures === 0, "idempotence: the single `ok` fold reset the streak, and nothing folded it back up");

  const beforeUnarmed = (await rowsFor(ROUTINE_AUDIT.fire)).length;
  await inEveContext(fireSession, async () => {
    await outcomeHook.events!["turn.completed"]!({} as never, ctx);
  });
  ok((await rowsFor(ROUTINE_AUDIT.fire)).length === beforeUnarmed, "idempotence: an UNARMED turn end folds nothing");

  await inEveContext(fireSession, async () => {
    await outcomeHook.events!["turn.started"]!({} as never, ctx);
    await outcomeHook.events!["turn.completed"]!({} as never, ctx);
  });
  ok(
    (await rowsFor(ROUTINE_AUDIT.fire)).filter((e) => detailOf(e, "routineId") === "r-once").length === 1,
    "idempotence: the fire's SETTLEMENT turn — a second armed turn on the same session, same wake id — folds nothing",
  );
  ok((await store.getRoutine(ORG, SURFACE, "r-once"))?.consecutiveFailures === 0, "idempotence: …and the streak it reset stays reset, rather than being folded a second time");
}

{
  const r = routine({ id: "r-job-refire", consecutiveFailures: 0 });
  await store.addRoutine({ org: ORG, surfaceKey: SURFACE } as never, r);
  const jobSeat = new FakeEveContext();
  const fireA = firedCtx(r, "sess-job-seat", "wake-fire-A");
  const fireB = firedCtx(r, "sess-job-seat", "wake-fire-B");

  await inEveContext(jobSeat, async () => {
    await outcomeHook.events!["turn.started"]!({} as never, fireA);
    await outcomeHook.events!["turn.completed"]!({} as never, fireA);
    await outcomeHook.events!["turn.started"]!({} as never, fireB);
    await outcomeHook.events!["turn.completed"]!({} as never, fireB);
  });
  const fires = (await rowsFor(ROUTINE_AUDIT.fire)).filter((e) => detailOf(e, "routineId") === "r-job-refire");
  ok(fires.length === 2, "idempotence: a JOB seat folds EVERY fire — two fires on one durable session write two join rows, because the latch keys on the wake id");
}

{
  const r = routine({ id: "r-job-human", consecutiveFailures: 2 });
  await store.addRoutine({ org: ORG, surfaceKey: SURFACE } as never, r);
  const humanTurnInJobSeat = {
    channel: { kind: "slack" },
    session: {
      id: "sess-job",
      auth: {
        current: { attributes: { team_id: "T1", channel_id: "C1" }, principalId: "U1", principalType: "user" },
        initiator: {
          attributes: { team_id: "T1", channel_id: "C1", [ROUTINE_MARKER.id]: r.id, [ROUTINE_MARKER.surface]: r.surfaceKey, [ROUTINE_MARKER.org]: r.org },
          authenticator: SCHEDULE_APP_AUTHENTICATOR,
          principalId: SCHEDULE_APP_PRINCIPAL_ID,
          principalType: SCHEDULE_APP_PRINCIPAL_TYPE,
        },
      },
    },
  } as never;
  const before = (await rowsFor(ROUTINE_AUDIT.fire)).length;
  await fireOnce(humanTurnInJobSeat);
  ok((await rowsFor(ROUTINE_AUDIT.fire)).length === before, "idempotence: a HUMAN turn in a job seat writes no fire row, though the seat's initiator still carries the marker");
  ok((await store.getRoutine(ORG, SURFACE, "r-job-human"))?.consecutiveFailures === 2, "idempotence: …and it does not reset the failure streak that was two strikes from disabling the job");
}

{
  const r = routine({ id: "r-quiet", trigger: { kind: "watch", everyMinutes: 30 }, lastOutcome: "skipped" });
  await store.addRoutine({ org: ORG, surfaceKey: SURFACE } as never, r);
  await fireOnce(firedCtx(r, "sess-quiet"));
  const row = (await rowsFor(ROUTINE_AUDIT.fire)).find((e) => detailOf(e, "routineId") === "r-quiet");
  ok(row !== undefined && detailOf(row, "outcome") === "skipped", "join: a watch that saw no change is recorded as a fire with outcome `skipped`, not as silence");
  ok(detailOf(row, "sessionId") === "sess-quiet", "join: even a silent fire carries its session id (the transcript is the 'why quiet' story)");
}

{
  const r = routine({ id: "r-broken", consecutiveFailures: MAX_CONSECUTIVE_FAILURES - 1 });
  await store.addRoutine({ org: ORG, surfaceKey: SURFACE } as never, r);
  await fireOnce(firedCtx(r, "sess-strike3"), "turn.failed");

  const disabled = await rowsFor(ROUTINE_AUDIT.disabled);
  ok(disabled.length === 1, "self-disable: the transition writes exactly one routine.disabled row");
  ok(detailOf(disabled[0], "routineId") === "r-broken", "self-disable: the row names the routine that stopped itself");
  ok(detailOf(disabled[0], "consecutiveFailures") === MAX_CONSECUTIVE_FAILURES, "self-disable: the row carries the strike count that tripped it");
  ok(detailOf(disabled[0], "sessionId") === "sess-strike3", "self-disable: the row names the session of the fire that tripped it");
  ok((await store.getRoutine(ORG, SURFACE, "r-broken"))?.status === "disabled", "self-disable: the routine really is disabled on the row too");

  await fireOnce(firedCtx(r, "sess-after"), "turn.failed");
  ok((await rowsFor(ROUTINE_AUDIT.disabled)).length === 1, "self-disable: an already-disabled routine does NOT write a second disabled row");
}

{
  const r = routine({ id: "r-cost" });
  const ctx = firedCtx(r, "sess-cost");
  ok(routineIdOf(ctx) === "r-cost", "usage: routineIdOf reads the dispatcher's marker off the fired session's auth");
  ok(routineIdOf({ session: { auth: { current: { attributes: { team_id: "T1" } } } } } as never) === undefined, "usage: an ordinary turn has no routine id (the column stays NULL)");

  await spendHook.events!["step.completed"]!({ data: { usage: { inputTokens: 120, outputTokens: 30, cacheReadTokens: 10, cacheWriteTokens: 0 } } } as never, ctx);
  const rows = await usageEvents.usageForSession(ORG, "sess-cost");
  ok(rows.length === 1, "usage: the fired turn records a usage event");
  ok(rows[0]!.kind === "routine", "usage: it is still tagged kind=routine (unchanged)");
  ok(rows[0]!.routineId === "r-cost", "usage: …and now ALSO names WHICH routine — per-routine cost was unanswerable without this");

  const rollup = await usageEvents.usageSummary(ORG, { surfaceKeyPrefix: SURFACE });
  const mine = rollup.filter((g) => g.routineId === "r-cost");
  ok(mine.length === 1, "usage: usageSummary groups by routineId");
  ok(mine[0]!.inputTokens === 120 && mine[0]!.outputTokens === 30 && mine[0]!.cacheReadTokens === 10, "usage: the per-routine group sums the real token legs");

  await spendHook.events!["step.completed"]!({ data: { usage: { inputTokens: 5, outputTokens: 5 } } } as never, {
    channel: { kind: "slack" },
    session: { id: "sess-human-cost", auth: { current: { attributes: { team_id: "T1", channel_id: "C1", channel_type: "channel" }, principalId: "U1" } } },
  } as never);
  const humanRows = await usageEvents.usageForSession(ORG, "sess-human-cost");
  ok(humanRows.length === 1 && humanRows[0]!.routineId === undefined, "usage: a human turn's row carries NO routine id");
}

{
  const receive = (() => ({ send: () => Promise.resolve() })) as never;
  const tickArgs = (now: Date) => ({ now, to: receive, waitUntil: (_p: Promise<unknown>) => {}, appAuth: { attributes: {} } as never });

  await store.addRoutine({ org: ORG, surfaceKey: "linear/W1/S1" } as never, routine({ id: "r-unwired", surfaceKey: "linear/W1/S1", nextRunAt: "2026-07-20T00:00:00.000Z" }));
  await dispatch.dispatchTick(tickArgs(new Date("2026-07-20T01:00:00.000Z")) as never);
  const unwired = (await rowsFor(ROUTINE_AUDIT.skip)).filter((e) => detailOf(e, "routineId") === "r-unwired");
  ok(unwired.length === 1, "clock skip: an unresolvable target writes a routine.skip row");
  ok(detailOf(unwired[0], "reason") === "unresolved_target", "clock skip: the reason is machine-readable, so a decline and a dry-run are distinguishable");
  ok(unwired[0]!.platform === "linear" && unwired[0]!.workspace === "W1", "clock skip: attributed to the skipped routine's own partition");

  await store.addRoutine({ org: ORG, surfaceKey: SURFACE } as never, routine({ id: "r-future", nextRunAt: "2099-01-01T00:00:00.000Z" }));
  await dispatch.dispatchTick(tickArgs(new Date("2026-07-20T01:00:00.000Z")) as never);
  const futureRows = [...(await rowsFor(ROUTINE_AUDIT.skip)), ...(await rowsFor(ROUTINE_AUDIT.fire))].filter((e) => detailOf(e, "routineId") === "r-future");
  ok(futureRows.length === 0, "never-ran: a not-yet-due routine writes NO rows — the absence is itself the signal");
}

{
  overrideSettingsForTest({ routines: { maxConcurrency: 1 } });
  const ids = ["r-burst1", "r-burst2", "r-burst3"];
  for (const id of ids) await store.addRoutine({ org: ORG, surfaceKey: SURFACE } as never, routine({ id, nextRunAt: "2026-07-21T00:00:00.000Z" }));
  const before = (await rowsFor(ROUTINE_AUDIT.skip)).length;
  await dispatch.dispatchTick({ now: new Date("2026-07-21T00:05:00.000Z"), to: (() => ({ send: () => Promise.resolve() })) as never, waitUntil: () => {}, appAuth: { attributes: {} } as never } as never);
  const after = (await rowsFor(ROUTINE_AUDIT.skip)).filter((e) => ids.includes(String(detailOf(e, "routineId"))));
  ok(after.length === 0, "deferred: an over-cap routine writes NO skip row (it is going to fire, just on a later tick)");
  ok((await rowsFor(ROUTINE_AUDIT.skip)).length === before, "deferred: nothing else was written either");
  overrideSettingsForTest({ routines: { maxConcurrency: 3 } });
}

{
  const r = routine({ id: "r-lost", nextRunAt: "2026-07-22T00:00:00.000Z" });
  await store.addRoutine({ org: ORG, surfaceKey: SURFACE } as never, r);
  const rejecting = (() => ({ send: () => Promise.reject(new Error("channel_not_found")) })) as never;
  const pending: Promise<unknown>[] = [];
  overrideSettingsForTest({ routines: { maxConcurrency: 20 } });
  await dispatch.dispatchTick({
    now: new Date("2026-07-22T00:05:00.000Z"),
    to: rejecting,
    waitUntil: (p: Promise<unknown>) => void pending.push(p),
    appAuth: { attributes: {} } as never,
  } as never);
  await Promise.all(pending);
  overrideSettingsForTest({ routines: { maxConcurrency: 3 } });

  const lost = (await rowsFor(ROUTINE_AUDIT.fireLost)).filter((e) => detailOf(e, "routineId") === "r-lost");
  ok(lost.length === 1, "fire_lost: a rejected receive writes a routine.fire_lost row (the fire used to vanish into a console line)");
  ok(detailOf(lost[0], "routineId") === "r-lost", "fire_lost: the row names the routine");
  ok(detailOf(lost[0], "sessionId") === null, "fire_lost: sessionId is explicitly null — no session started, and an ABSENT field would read as a recording bug");
  ok(String(detailOf(lost[0], "error")).includes("channel_not_found"), "fire_lost: the row carries the rejection reason");
  ok((await rowsFor(ROUTINE_AUDIT.fire)).every((e) => detailOf(e, "routineId") !== "r-lost"), "fire_lost: no fire row exists for it — the outcome hook never ran, because no session ever started");
}

{
  fireAudit.resetRoutineSkipThrottle();
  const capped = routine({ id: "r-throttled", trigger: { kind: "event", source: "github" } });
  const audited: AuditInput[] = [];
  const seenKeys: string[] = [];
  const closed = new Set<string>();
  const deps = {
    to: (() => ({ send: () => Promise.resolve() })) as never,
    listRoutines: async () => [routine({ id: "r-ev1", trigger: { kind: "event", source: "github" } }), capped],
    audit: async (e: AuditInput) => void audited.push(e),
    markSeen: async (_o: string, k: string) => {
      seenKeys.push(k);
      if (closed.has(k)) return false;
      closed.add(k);
      return true;
    },
    grant: { resolve: () => ({ repos: ["me/proj"] }) as never },
    hydrate: { read: async () => ({ status: "gone" }) as never },
  };
  const body = JSON.stringify({
    action: "opened",
    pull_request: { number: 7, title: "t", html_url: "https://github.com/me/proj/pull/7" },
    repository: { full_name: "me/proj" },
    sender: { login: "alice" },
  });
  overrideSettingsForTest({ routines: { eventMaxFanout: 1 } });
  for (let i = 0; i < 5; i++) await fanOutDelivery(body, "pull_request", undefined, deps);

  const skips = audited.filter((e) => e.action === ROUTINE_AUDIT.skip);
  ok(skips.length === 1, "throttle: five identical over-cap deliveries write ONE audit row, not five");
  ok(skips[0]!.detail?.["reason"] === "fanout_cap", "throttle: that row is the cap skip");
  ok(skips[0]!.principalId === "github:webhook", "throttle: the event leg stamps the WEBHOOK as the actor, not the clock dispatcher");
  ok(skips[0]!.detail?.["suppressed"] === undefined, "throttle: the FIRST row carries no suppressed count (its absence means 'exactly one')");
  ok(
    seenKeys.filter((k) => k.startsWith("routineskip:")).every((k) => k === "routineskip:r-throttled:fanout_cap"),
    "throttle: the key is built ONLY from OE-minted parts (routine id + a closed reason set) — a hostile delivery stream cannot mint fresh keys to defeat it",
  );
  ok(
    seenKeys.every((k) => /^(routineskip:r-[A-Za-z0-9_-]+:[a-z_]+|routinematch:r-[A-Za-z0-9_-]+)$/.test(k)),
    "throttle: every throttle key this leg mints is OE-minted parts only — the match stamp's included",
  );
  ok(
    seenKeys.some((k) => k === "routinematch:r-throttled"),
    "throttle: …and the OVER-CAP routine's match stamp really did run (the stamp is before the cap, so a capped subscription can still prove its filter works)",
  );

  closed.clear();
  await fanOutDelivery(body, "pull_request", undefined, deps);
  overrideSettingsForTest({ routines: { eventMaxFanout: 3 } });
  const second = audited.filter((e) => e.action === ROUTINE_AUDIT.skip)[1];
  ok(second !== undefined && Number(second.detail?.["suppressed"]) === 4, "throttle: the next emitted row reports the 4 it suppressed — the throttle never hides itself");
  ok(Number(second!.detail?.["windowMs"]) === fireAudit.SKIP_WINDOW_MS, "throttle: …and names the window that count is over");

  const opStore = (await import("../agent/operational/provider.js")).getOperationalStore();
  const probe = fireAudit.skipThrottleKey("r-probe", "over_budget");
  ok((await opStore.markEventSeen(ORG, probe, new Date().toISOString(), fireAudit.SKIP_WINDOW_MS)) === true, "throttle: the backing first-sighting primitive is the durable event_dedupe mark");
  ok((await opStore.markEventSeen(ORG, probe, new Date().toISOString(), fireAudit.SKIP_WINDOW_MS)) === false, "throttle: …and it really does hold the window");
}

{
  const ctx = {
    channel: { kind: "slack" },
    session: { auth: { current: { attributes: { team_id: "T1", channel_id: "C1", channel_type: "channel" }, principalId: "U1", principalType: "slack-user" } } },
  } as never;

  await appendAudit({ org: ORG, platform: "slack", workspace: "T1", surface: "C1", action: "reply.post", detail: { id: "1.1", platform: "slack", chars: 12, route: "tool", sessionId: "sess-join" } });

  const all = (await listRoutinesTool.execute({ includeDisabled: true } as never, ctx)) as {
    routines: { id: string; lastSessionId: string | null; lastPostedAt: string | null; fires7d: number; tokens7d: number; consecutiveFailures: number; createdBy: string | null; taintedAtCreation: boolean }[];
  };
  const join = all.routines.find((x) => x.id === "r-join");
  ok(join !== undefined, "list_routines: the routine is listed");
  ok(join!.lastSessionId === "sess-join", "list_routines: it now reports the LAST FIRE'S SESSION ID — the transcript was previously unreachable from a routine");
  ok(join!.fires7d === 1, "list_routines: it reports how many times the routine actually fired in the window");
  ok(join!.lastPostedAt !== null, "list_routines: it reports when the routine last POSTED (joined through reply.post's sessionId)");

  const quiet = all.routines.find((x) => x.id === "r-quiet");
  ok(quiet !== undefined && quiet.fires7d === 1 && quiet.lastPostedAt === null, "list_routines: a routine that RAN but never posted is distinguishable from one that never ran");

  const cost = all.routines.find((x) => x.id === "r-cost");
  ok(cost === undefined, "list_routines: r-cost was never stored, so nothing invents a row for it");

  const future = all.routines.find((x) => x.id === "r-future");
  ok(future !== undefined && future.fires7d === 0 && future.lastSessionId === null, "list_routines: a never-run routine reads as zero fires and no session — the honest answer, not an error");

  const broken = all.routines.find((x) => x.id === "r-broken");
  ok(broken !== undefined && broken.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES, "list_routines: consecutiveFailures is in the ROOM now, not only in the operator CLI and the MCP view");

  const one = (await listRoutinesTool.execute({ includeDisabled: false, id: "r-broken" } as never, ctx)) as { routines: { id: string; status: string }[] };
  ok(one.routines.length === 1 && one.routines[0]!.id === "r-broken" && one.routines[0]!.status === "disabled", "list_routines: the id filter returns exactly that routine, disabled or not");
}

{
  const { actionKind } = await import("../agent/approvals/actions.js");
  await import("../agent/approvals/routine-create.js");
  const kind = actionKind("routine.create")!;
  const partition = { org: ORG, platform: "slack", workspace: "T1", surface: "C1", workspaceKey: "slack/T1", surfaceKey: SURFACE, key: SURFACE };
  const armed = await kind.execute(
    {
      org: ORG,
      partition: partition as never,
      surfaceKey: SURFACE,
      target: { channelId: "C1" },
      trigger: { kind: "interval", everyMinutes: 60 },
      prompt: "Summarise the page I just read.",
      tainted: true,
    } as never,
    "U_ARMER",
  );
  const id = /routine (r-[0-9a-f]+)/.exec(String(armed))?.[1];
  ok(id !== undefined, "taint: the armed routine reports its id");
  const stored = await store.getRoutine(ORG, SURFACE, id!);
  ok(stored?.taintedAtCreation === true, "taint: the propose-time verdict is FROZEN ONTO THE ROW (it used to live only on the card and the routine.create audit row)");

  const ctx = {
    channel: { kind: "slack" },
    session: { auth: { current: { attributes: { team_id: "T1", channel_id: "C1", channel_type: "channel" }, principalId: "U1", principalType: "slack-user" } } },
  } as never;
  const listed = (await listRoutinesTool.execute({ includeDisabled: true, id } as never, ctx)) as { routines: { taintedAtCreation: boolean }[] };
  ok(listed.routines[0]!.taintedAtCreation === true, "taint: list_routines can finally say WHICH standing autonomy was authored in a turn that had read external content");

  const cleanArmed = await kind.execute(
    {
      org: ORG,
      partition: partition as never,
      surfaceKey: SURFACE,
      target: { channelId: "C1" },
      trigger: { kind: "interval", everyMinutes: 60 },
      prompt: "Post the standup reminder.",
    } as never,
    "U_ARMER",
  );
  const cleanId = /routine (r-[0-9a-f]+)/.exec(String(cleanArmed))?.[1];
  const cleanStored = await store.getRoutine(ORG, SURFACE, cleanId!);
  ok(cleanStored !== null && !("taintedAtCreation" in cleanStored), "taint: a clean arm stores NO taint key (absent, never `false`)");
  const cleanListed = (await listRoutinesTool.execute({ includeDisabled: true, id: cleanId } as never, ctx)) as { routines: { taintedAtCreation: boolean }[] };
  ok(cleanListed.routines[0]!.taintedAtCreation === false, "taint: the tool reports a clean routine as untainted");
}

rmSync(dir, { recursive: true, force: true });
console.log(`✓ routine-forensics: ${passed} assertions passed`);
