
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

const dir = join(tmpdir(), `open-everywhere-routine-reliability-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");
process.env.OE_ORG = "acme";
overrideSettingsForTest({ delegation: { oneshotAgent: false } });
overrideSettingsForTest({ window: { topology: false } });

const { computeNextRun, DISPATCH_TICK_MINUTES } = await import("../agent/routines/schedule.js");
const { firesPerDay } = await import("../agent/spend/reporting.js");
const { registerSlackTestBridge, registerSlackFixtureMapper } = await import("./_slack-test-stubs.js");
const { registerConfig } = await import("../agent/access/config.js");
const { defineDomain } = await import("../agent/memory/domain.js");
const { MAX_CONSECUTIVE_FAILURES } = await import("../agent/routines/lifecycle.js");
const { readAudit } = await import("../agent/audit/audit.js");
const { ROUTINE_AUDIT, resetRoutineSkipThrottle } = await import("../agent/routines/fire-audit.js");

type Routine = import("../agent/routines/routine.js").Routine;
type Domain = import("../agent/memory/domain.js").Domain;

const MIN = 60_000;

{
  const due = new Date("2026-07-02T12:00:00.000Z");
  const firedAt = new Date(due.getTime() + 5 * MIN);

  const iv = computeNextRun({ kind: "interval", everyMinutes: 15 }, due, firedAt);
  ok(iv?.toISOString() === "2026-07-02T12:15:00.000Z", "interval: the next run is due + 15 min — NOT fired + 15 (the 33% dilation this ticket removes)");

  const tickAtOrAfter = (t: Date): Date => new Date(Math.ceil(t.getTime() / (DISPATCH_TICK_MINUTES * MIN)) * (DISPATCH_TICK_MINUTES * MIN));
  let anchor = new Date("2026-07-02T12:00:00.000Z");
  const period: number[] = [];
  for (let i = 0; i < 4; i++) {
    const next = computeNextRun({ kind: "interval", everyMinutes: 15 }, anchor, tickAtOrAfter(anchor))!;
    period.push((next.getTime() - anchor.getTime()) / MIN);
    anchor = next;
  }
  ok(period.every((p) => p === 15), `interval: the period stays exactly 15 min across successive fires (was ${period.join("/")} before the anchor fix)`);

  ok(
    computeNextRun({ kind: "watch", everyMinutes: 15 }, due, firedAt)?.toISOString() === "2026-07-02T12:15:00.000Z",
    "watch-by-cadence: shares the interval arithmetic, so it gets the same anchoring (it is the same drift bug)",
  );

  const stale = new Date("2026-07-02T00:00:00.000Z");
  const late = new Date("2026-07-02T12:07:00.000Z");
  const caught = computeNextRun({ kind: "interval", everyMinutes: 15 }, stale, late)!;
  ok(caught.getTime() > late.getTime(), "interval/catch-up: after a 12-hour gap the next run is strictly in the FUTURE — a missed window is never replayed as a burst");
  ok((caught.getTime() - stale.getTime()) % (15 * MIN) === 0, "interval/catch-up: it lands on the routine's OWN grid (a whole number of periods from the anchor), not on `now + period`");
  ok(caught.toISOString() === "2026-07-02T12:15:00.000Z", "interval/catch-up: exactly the first grid slot after now");

  ok(
    computeNextRun({ kind: "interval", everyMinutes: 15 }, due)?.toISOString() === "2026-07-02T12:15:00.000Z",
    "interval: the two-argument (creation-time) call is unchanged — notBefore defaults to from",
  );
  ok(
    computeNextRun({ kind: "cron", expr: "0 9 * * *" }, due, firedAt)?.toISOString() === "2026-07-03T09:00:00.000Z",
    "cron: unaffected by the anchor split — it resolves against the wall clock, from whichever instant is later",
  );
  ok(computeNextRun({ kind: "once", at: due.toISOString() }, due, firedAt) === null, "once: still has no next occurrence, whatever the anchoring");
}

{
  ok(DISPATCH_TICK_MINUTES === 10, "the tick floor is a single exported constant (the dispatcher's cron is BUILT from it, so the two cannot drift)");
  ok(firesPerDay({ kind: "interval", everyMinutes: 5 }) === 144, "firesPerDay: a 5-minute interval predicts 144/day (the achievable rate), not 288 (the requested one)");
  ok(firesPerDay({ kind: "interval", everyMinutes: 1 }) === 144, "firesPerDay: an every-minute interval is floored at the tick too");
  ok(firesPerDay({ kind: "interval", everyMinutes: 60 }) === 24, "firesPerDay: a cadence COARSER than the tick is untouched");
  ok(firesPerDay({ kind: "cron", expr: "* * * * *" }) === 144, "firesPerDay: an every-minute CRON is dispatched once per tick — 144/day, not 1440");
  ok(firesPerDay({ kind: "cron", expr: "*/5 * * * *" }) === 144, "firesPerDay: two cron matches inside one tick window are ONE fire");
  ok(firesPerDay({ kind: "cron", expr: "0 * * * *" }) === 24, "firesPerDay: an hourly cron is unchanged (one match per tick window)");
  ok(firesPerDay({ kind: "cron", expr: "*/15 * * * *" }) === 96, "firesPerDay: a 15-minute cron is unchanged (each match is its own tick window)");
  ok(firesPerDay({ kind: "cron", expr: "not a cron" }) === undefined, "firesPerDay: a malformed cron still degrades to undefined, never a throw");
}

const ORG = "acme";
const TEAM = "T_REL";
const CHAN = "C_REL";
const SURFACE = `slack/${TEAM}/${CHAN}`;
const OTHER_ORG = "other-tenant";

registerSlackTestBridge({ channel: { __fixture: "slack" } as never, confirmChannelInternal: async () => true });
registerSlackFixtureMapper();

const relDomain = defineDomain({ name: "payments", channels: [SURFACE] });
const DOMAINS: readonly Domain[] = [relDomain];
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

function routine(over: Partial<Routine> & Pick<Routine, "id">): Routine {
  return {
    org: ORG,
    surfaceKey: SURFACE,
    target: { channelId: CHAN },
    trigger: { kind: "interval", everyMinutes: 15 },
    prompt: "Post the daily digest.",
    createdAt: "2026-07-01T00:00:00.000Z",
    status: "active",
    consecutiveFailures: 0,
    nextRunAt: "2026-07-02T12:00:00.000Z",
    ...over,
  };
}

async function tick(now: Date, receive: unknown): Promise<void> {
  const pending: Promise<unknown>[] = [];
  await dispatch.dispatchTick({
    now,
    to: receive,
    waitUntil: (p: Promise<unknown>) => void pending.push(p),
    appAuth: { attributes: {} },
    postJobKickoff: async () => "1700000000.0001",
  } as never);
  await Promise.all(pending);
}

const rejectingReceive = (() => ({
  send: async () => {
    throw new Error("channel_not_found");
  },
})) as never;

const okReceive = (() => ({ send: async () => undefined })) as never;

{
  resetRoutineSkipThrottle();
  const id = "r-lost-1";
  await routineStore.addRoutine({} as never, routine({ id }));

  await tick(new Date("2026-07-02T12:05:00.000Z"), rejectingReceive);
  const after1 = await routineStore.getRoutine(ORG, SURFACE, id);
  ok(after1?.consecutiveFailures === 1, "delivery/1: a REJECTED delivery increments consecutiveFailures — before this it stayed 0 forever (no session ⇒ the outcome hook never ran)");
  ok(after1?.lastOutcome === "failed", "delivery/1: the run is recorded as failed, not left pending");
  ok(after1?.status === "active", "delivery/1: one failure does not disable — the three-strike rule is unchanged");
  ok(
    after1?.nextRunAt === "2026-07-02T12:15:00.000Z",
    "delivery/1: the DISPATCHER advances from the routine's DUE instant (12:00 + 15), not from the late tick that ran it (12:05 + 15 = 12:20) — the §S11 dilation, pinned where it actually happens",
  );

  await tick(new Date("2026-07-02T12:20:00.000Z"), rejectingReceive);
  const after2 = await routineStore.getRoutine(ORG, SURFACE, id);
  ok(after2?.consecutiveFailures === 2, "delivery/2: failures accumulate across ticks");
  ok(after2?.status === "active", "delivery/2: still active at two");
  ok(after2?.nextRunAt === "2026-07-02T12:30:00.000Z", "delivery/2: and the grid holds across fires — 12:15 + 15, still exactly 15 minutes apart");

  await tick(new Date("2026-07-02T12:40:00.000Z"), rejectingReceive);
  const after3 = await routineStore.getRoutine(ORG, SURFACE, id);
  ok(after3?.consecutiveFailures === MAX_CONSECUTIVE_FAILURES, `delivery/3: the counter reaches the threshold (${MAX_CONSECUTIVE_FAILURES})`);
  ok(after3?.status === "active", "🔴 delivery/3: OPE-506 — 3 failures within 35 minutes do NOT yet disable; the streak has not spanned an hour");
  ok(after3?.nextRunAt === "2026-07-02T12:45:00.000Z", "delivery/3: still active, so the schedule keeps advancing on the routine's own grid — 12:30 + 15");

  await tick(new Date("2026-07-02T12:50:00.000Z"), rejectingReceive);
  const after4 = await routineStore.getRoutine(ORG, SURFACE, id);
  ok(after4?.consecutiveFailures === 4 && after4?.status === "active", "delivery/4: a fourth failure keeps accumulating — still only 45 minutes since the first, still under the span floor");

  await tick(new Date("2026-07-02T13:05:00.000Z"), rejectingReceive);
  const after5 = await routineStore.getRoutine(ORG, SURFACE, id);
  ok(after5?.consecutiveFailures === 5, "delivery/5: the counter keeps counting past the bare threshold — it was never gated on count alone");
  ok(after5?.status === "disabled", "delivery/5: THE FIX — once the streak ALSO spans an hour, the routine that can no longer be delivered to SELF-DISABLES instead of retrying forever");
  ok((after5?.disabledReason ?? "").includes("consecutive failures"), "delivery/5: the disable carries a legible reason");
  ok(after5?.nextRunAt === null, "delivery/5: a disabled routine has no next run — it stops consuming a per-tick concurrency slot");

  const beforeNext = (await readAudit({ org: ORG, limit: 500 })).length;
  await tick(new Date("2026-07-02T13:20:00.000Z"), rejectingReceive);
  ok((await readAudit({ org: ORG, limit: 500 })).length === beforeNext, "delivery/6: once disabled it is not dispatched again — no further rows of any kind");

  const rows = await readAudit({ org: ORG, limit: 500 });
  const lost = rows.filter((r) => r.action === ROUTINE_AUDIT.fireLost && (r.detail as { routineId?: string } | undefined)?.routineId === id);
  const disabled = rows.filter((r) => r.action === ROUTINE_AUDIT.disabled && (r.detail as { routineId?: string } | undefined)?.routineId === id);
  ok(lost.length === 5, "forensics: one `routine.fire_lost` row per lost delivery (the OPE-145 trail is unmoved by the fold)");
  ok(disabled.length === 1, "forensics: exactly ONE `routine.disabled` row — written on the TRANSITION, from the dispatcher ingress that caused it");
  ok((disabled[0]?.detail as { consecutiveFailures?: number } | undefined)?.consecutiveFailures === 5, "forensics: the disable row carries the counter a reader will then see on the row — 5, not the bare 3-strike threshold, because OPE-506 also gated on the streak's span");
  ok(!("sessionId" in ((disabled[0]?.detail ?? {}) as object)), "forensics: no sessionId is invented for a fire that never started a session");

  await routineStore.removeRoutine({ org: ORG, surfaceKey: SURFACE } as never, id);
}

{
  const id = "r-ok-1";
  await routineStore.addRoutine({} as never, routine({ id }));
  await tick(new Date("2026-07-02T12:00:00.000Z"), okReceive);
  const after = await routineStore.getRoutine(ORG, SURFACE, id);
  ok(after?.consecutiveFailures === 0, "success: a delivered fire folds NOTHING here — the outcome is still the session-end hook's to settle");
  ok(after?.lastOutcome === undefined, "success: lastOutcome stays CLEARED (`outcome pending`) — the invariant settleOutcome rests on");
  ok(after?.status === "active", "success: still active");
  await routineStore.removeRoutine({ org: ORG, surfaceKey: SURFACE } as never, id);
}

{
  const id = "r-recover";
  await routineStore.addRoutine({} as never, routine({ id, consecutiveFailures: 2 }));
  const { foldRoutineOutcome } = await import("../agent/routines/outcome-fold.js");
  const folded = await foldRoutineOutcome({ marker: { id, surfaceKey: SURFACE, org: ORG }, sessionOutcome: "ok", at: new Date("2026-07-02T12:00:00.000Z"), sessionId: "sess-1" });
  ok(folded.folded && folded.consecutiveFailures === 0, "recovery: one good run resets the counter — two ingresses, ONE fold, so the counter can't be half-maintained");
  const rows = await readAudit({ org: ORG, action: ROUTINE_AUDIT.fire, limit: 500 });
  ok(rows.some((r) => (r.detail as { routineId?: string; sessionId?: string } | undefined)?.routineId === id && (r.detail as { sessionId?: string }).sessionId === "sess-1"), "recovery: the session-carrying ingress still writes the `routine.fire` JOIN row (the transcript handle)");

  const gone = await foldRoutineOutcome({ marker: { id: "r-cancelled-meanwhile", surfaceKey: SURFACE, org: ORG }, sessionOutcome: "failed" });
  ok(!gone.folded, "fold: a routine cancelled between the fire and the outcome is a no-op, not an error");
  await routineStore.removeRoutine({ org: ORG, surfaceKey: SURFACE } as never, id);
}

{
  const { routinesView } = await import("../agent/control/views.js");
  const { buildControlServer } = await import("../agent/control/server.js");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

  await routineStore.addRoutine({} as never, routine({ id: "r-mine", prompt: "OURS: post the digest." }));
  await routineStore.addRoutine({} as never, routine({ id: "r-mine-2", surfaceKey: "slack/T_REL/C_OTHER", target: { channelId: "C_OTHER" }, prompt: "OURS: elsewhere." }));
  await routineStore.addRoutine(
    {} as never,
    routine({ id: "r-theirs", org: OTHER_ORG, surfaceKey: "slack/T_THEM/C_THEM", target: { channelId: "C_THEM" }, prompt: "TENANT SECRET: rotate the prod keys nightly." }),
  );

  const mine = await routinesView({ org: ORG });
  ok(mine.routines.length === 2 && mine.total === 2, "view: only THIS org's routines are returned (it used to be listAllRoutines(), every tenant)");
  ok(!mine.routines.some((r) => r.org === OTHER_ORG), "view: another tenant's row is absent");
  ok(!JSON.stringify(mine).includes("TENANT SECRET"), "view: and so is its PROMPT — the whole exposure was that prompts crossed the tenant line");
  const theirs = await routinesView({ org: OTHER_ORG });
  ok(theirs.routines.length === 1 && theirs.routines[0]!.id === "r-theirs", "view: the filter is a real partition, not a hard-coded self-org");
  const scoped = await routinesView({ org: ORG, surfaceKey: SURFACE });
  ok(scoped.routines.length === 1 && scoped.routines[0]!.id === "r-mine", "view: surfaceKey narrows further, which is what lets a domain role read its own channel");
  const defaulted = await routinesView();
  ok(defaulted.routines.length === 2, "view: an UNSCOPED call defaults to the deployment's own org — the widest it can now be is one tenant");

  async function call(roles: readonly string[], args: Record<string, unknown>) {
    const server = buildControlServer({ roles });
    const client = new Client({ name: "t", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(b), client.connect(a)]);
    const res = await client.callTool({ name: "routines_list", arguments: args });
    const text = (res.content as { type: string; text: string }[])[0].text;
    return { isError: res.isError === true, text };
  }

  const admin = await call(["admin"], {});
  ok(!admin.isError && JSON.parse(admin.text).routines.length === 2, "tool/admin: an org admin still gets the org-wide listing (no capability lost)");

  const domainOrgWide = await call(["domain:payments"], {});
  ok(domainOrgWide.isError, "tool/DEFECT: a `domain:<name>` identity asking ORG-WIDE is now DENIED — it used to receive every routine in every org, prompts included");
  ok(domainOrgWide.text.includes("forbidden"), "tool: the denial is the same legible scopeDenial message overrides_list/usage_window use");
  ok(!domainOrgWide.text.includes("TENANT SECRET"), "tool: nothing leaks in the denial body either");

  const domainScoped = await call(["domain:payments"], { surfaceKey: SURFACE });
  ok(!domainScoped.isError && JSON.parse(domainScoped.text).routines.length === 1, "tool: the same identity CAN read the surface its domain covers — scoped down, not locked out");

  const foreignSurface = await call(["domain:payments"], { surfaceKey: "slack/T_THEM/C_THEM" });
  ok(foreignSurface.isError, "tool: a surface outside the role's domain resolves to no domain and fails CLOSED");

  const crossOrg = await call(["domain:payments"], { org: OTHER_ORG });
  ok(crossOrg.isError, "tool: naming another org does not widen anything");

  await routineStore.removeRoutine({ org: ORG, surfaceKey: SURFACE } as never, "r-mine");
  await routineStore.removeRoutine({ org: ORG, surfaceKey: "slack/T_REL/C_OTHER" } as never, "r-mine-2");
  await routineStore.removeRoutine({ org: OTHER_ORG, surfaceKey: "slack/T_THEM/C_THEM" } as never, "r-theirs");
}

{
  const id = "r-kicked";
  await routineStore.addRoutine({} as never, routine({ id, trigger: { kind: "cron", expr: "0 9 * * *" }, nextRunAt: "2026-07-02T09:00:00.000Z" }));
  for (let i = 0; i < MAX_CONSECUTIVE_FAILURES; i++) {
    await tick(new Date(`2026-07-0${2 + i}T09:00:00.000Z`), rejectingReceive);
  }
  const dead = await routineStore.getRoutine(ORG, SURFACE, id);
  ok(dead?.status === "disabled", "surface-removal: a routine the agent can no longer post to ENDS — within three of its own cadences, which is what the docs now say");
  await routineStore.removeRoutine({ org: ORG, surfaceKey: SURFACE } as never, id);
}

rmSync(dir, { recursive: true, force: true });
console.log(`✓ routine reliability + exposure (OPE-146): ${passed} assertions passed`);
