
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

const dir = join(tmpdir(), `open-everywhere-event-strike-test-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");
process.env.OE_ORG = "acme";
delete process.env.OE_EVENT_MAX_FANOUT;

const { registerSlackTestBridge, registerSlackFixturePostArm } = await import("./_slack-test-stubs.js");
const { fanOutDelivery } = await import("../agent/routines/github-fanout.js");
const routineStore = await import("../agent/routines/store.js");
const { readAudit } = await import("../agent/audit/audit.js");
const { ROUTINE_AUDIT, resetRoutineSkipThrottle } = await import("../agent/routines/fire-audit.js");
const { MAX_CONSECUTIVE_FAILURES } = await import("../agent/routines/lifecycle.js");
const { getOperationalStore, registerOperationalStore, resetOperationalStore } = await import("../agent/operational/provider.js");
const { registerEntityRead } = await import("../agent/routines/entity-read.js");
type Routine = import("../agent/routines/routine.js").Routine;
type AuditInput = import("../agent/operational/store.js").AuditInput;
type HydrationOutcome = import("../agent/routines/entity-read.js").HydrationOutcome;
type OperationalStore = import("../agent/operational/store.js").OperationalStore;

const ORG = "acme";
const SURFACE = "slack/T1/C1";
const NOW = new Date("2026-03-30T11:30:00.000Z");

const SLACK_CHANNEL = { __fixture: "slack" } as never;
const posts: Array<{ operation: string; body: string }> = [];
registerSlackTestBridge({
  channel: SLACK_CHANNEL,
  confirmChannelInternal: async () => true,
  form: async (operation: string, body: string) => {
    posts.push({ operation, body });
    return { ok: true, ts: `ts-${posts.length}` };
  },
});
registerSlackFixturePostArm();

registerEntityRead({ platform: "github", read: async () => ({ status: "gone" }) });

function routine(over: Partial<Routine> & Pick<Routine, "id">): Routine {
  return {
    org: ORG,
    surfaceKey: SURFACE,
    target: { channelId: "C1" },
    trigger: { kind: "event", source: "github" },
    prompt: "Summarise the PR.",
    createdAt: "2026-07-01T00:00:00.000Z",
    status: "active",
    consecutiveFailures: 0,
    ...over,
  };
}

const PR_BODY = JSON.stringify({
  action: "opened",
  pull_request: { number: 42, title: "Add caching", html_url: "https://github.com/me/proj/pull/42" },
  repository: { full_name: "me/proj" },
  sender: { login: "alice" },
});

interface HarnessOpts {
  readonly reject?: string;
  readonly hydrate?: HydrationOutcome;
  readonly listRoutines?: () => Promise<Routine[]>;
}

function harness(opts: HarnessOpts = {}) {
  const fired: Array<{ message: string }> = [];
  const audited: AuditInput[] = [];
  return {
    fired,
    audited,
    rows: (action: string) => audited.filter((a) => a.action === action),
    deps: {
      receive: ((_channel: unknown, o: unknown) => {
        if (opts.reject !== undefined) return Promise.reject(new Error(opts.reject));
        fired.push(o as { message: string });
        return Promise.resolve();
      }) as never,
      audit: async (e: AuditInput) => {
        audited.push(e);
      },
      grant: { resolve: () => ({ repos: ["me/proj"] }) as never },
      now: () => NOW,
      ...(opts.listRoutines ? { listRoutines: opts.listRoutines } : {}),
      ...(opts.hydrate ? { hydrate: { read: async (): Promise<HydrationOutcome> => opts.hydrate! } } : {}),
    },
  };
}

const seed = async (r: Routine): Promise<void> => {
  await routineStore.addRoutine({} as never, r);
};
const drop = async (id: string, surfaceKey = SURFACE): Promise<void> => {
  await routineStore.removeRoutine({ org: ORG, surfaceKey } as never, id);
};
const read = (id: string, surfaceKey = SURFACE) => routineStore.getRoutine(ORG, surfaceKey, id);

{
  await seed(routine({ id: "r-strike" }));
  const h = harness({ reject: "channel_not_found" });
  await fanOutDelivery(PR_BODY, "pull_request", "d-strike-1", h.deps);

  const after = await read("r-strike");
  ok(
    after?.consecutiveFailures === 1,
    "🔴 strike: a REJECTED delivery on the EVENT leg increments consecutiveFailures — before OPE-180 it stayed 0 forever, so an event routine on a surface the bot was removed from retried on every matching delivery, indefinitely",
  );
  ok(after?.lastOutcome === "failed", "strike: the run is recorded as FAILED, not left pending — a lost delivery is a failed run by any reading");
  ok(after?.status === "active", "strike: one failure does not disable (the three-strike rule is the clock leg's, unchanged)");
  ok(after?.lastRunAt === NOW.toISOString(), "strike: the fold is stamped at the DELIVERY instant this leg was given, not a fresh clock read");
  ok(h.rows(ROUTINE_AUDIT.fireLost).length === 1, "strike: the OPE-145 `routine.fire_lost` row is UNMOVED — the fold is added beside the row, never instead of it");
  ok(h.fired.length === 0, "strike: nothing was delivered (the fire is genuinely lost)");
  await drop("r-strike");
}

{
  resetRoutineSkipThrottle();
  await seed(routine({ id: "r-dead", prompt: "Reconcile the release board." }));
  const before = posts.length;
  const h = harness({ reject: "channel_not_found" });

  await fanOutDelivery(PR_BODY, "pull_request", "d-dead-1", h.deps);
  await fanOutDelivery(PR_BODY, "pull_request", "d-dead-2", h.deps);
  ok((await read("r-dead"))?.consecutiveFailures === 2, "disable: failures ACCUMULATE across deliveries (the store is the counter, not the in-memory match set)");
  ok((await read("r-dead"))?.status === "active", "disable: still active at two");

  await fanOutDelivery(PR_BODY, "pull_request", "d-dead-3", h.deps);
  const dead = await read("r-dead");
  ok(dead?.consecutiveFailures === MAX_CONSECUTIVE_FAILURES, `disable: the counter reaches the threshold (${MAX_CONSECUTIVE_FAILURES})`);
  ok(dead?.status === "disabled", "🔴 disable: an EVENT routine that can no longer be delivered to SELF-DISABLES — the protection clock routines have had since OPE-146");
  ok((dead?.disabledReason ?? "").includes("consecutive failures"), "disable: the disable carries a legible reason");

  const lostBefore = h.rows(ROUTINE_AUDIT.fireLost).length;
  await fanOutDelivery(PR_BODY, "pull_request", "d-dead-4", h.deps);
  ok(h.rows(ROUTINE_AUDIT.fireLost).length === lostBefore, "🔴 disable: a FOURTH delivery no longer matches it at all — the forever-retry loop is closed, which is the entire product claim");
  ok(lostBefore === 3, "disable: exactly one fire_lost row per lost delivery, and none after");

  const disabledRows = (await readAudit({ org: ORG, action: ROUTINE_AUDIT.disabled, limit: 500 })).filter(
    (r) => (r.detail as { routineId?: string } | undefined)?.routineId === "r-dead",
  );
  ok(disabledRows.length === 1, "disable: exactly ONE `routine.disabled` row — written on the TRANSITION, from the event ingress that caused it");
  ok(
    (disabledRows[0]?.detail as { consecutiveFailures?: number } | undefined)?.consecutiveFailures === MAX_CONSECUTIVE_FAILURES,
    "disable: the row carries the counter a reader will then see on the routine itself",
  );
  ok(!("sessionId" in ((disabledRows[0]?.detail ?? {}) as object)), "disable: no sessionId is invented for a fire that never started a session");

  const notices = posts.slice(before);
  ok(notices.length === 1, "🔴 announce: the self-disable posts EXACTLY one notice, resolved through the LIVE routine target — an event routine's death is not a silent store update");
  ok(notices[0]!.operation === "chat.postMessage", "announce: it goes out as an ordinary surface post, not a second delivery mechanism");
  const body = new URLSearchParams(notices[0]!.body);
  ok(body.get("channel") === "C1", "announce: into the routine's OWN channel — the same place its fires would have landed");
  const text = body.get("text") ?? "";
  ok(text.includes("r-dead") && /will not run again/i.test(text), "announce: the notice names the routine and says it STOPPED");
  ok(text.includes("Reconcile the release board"), "announce: and quotes what it was for, so the reader knows what they lost");

  await drop("r-dead");
}

{
  resetRoutineSkipThrottle();
  for (const id of ["r-n1", "r-n2", "r-n3"]) await seed(routine({ id }));
  const h = harness({ reject: "channel_not_found" });
  await fanOutDelivery(PR_BODY, "pull_request", "d-fanout-1", h.deps);

  for (const id of ["r-n1", "r-n2", "r-n3"]) {
    const r = await read(id);
    ok(r?.consecutiveFailures === 1, `🔴 fan-out: ${id} took EXACTLY ONE strike from one delivery — a routine matched once cannot be struck twice for the same fire attempt`);
    ok(r?.status === "active", `fan-out: ${id} is nowhere near disabled after a single delivery`);
  }
  ok(h.rows(ROUTINE_AUDIT.fireLost).length === 3, "fan-out: three routines, three lost fires, three rows — the strike count tracks the ATTEMPTS, not the surface");

  await fanOutDelivery(PR_BODY, "pull_request", "d-fanout-2", h.deps);
  await fanOutDelivery(PR_BODY, "pull_request", "d-fanout-3", h.deps);
  for (const id of ["r-n1", "r-n2", "r-n3"]) {
    ok((await read(id))?.status === "disabled", `🔴 fan-out: ${id} disabled ITSELF — every routine on a dead surface converges, not just whichever one the loop reached first`);
  }
  for (const id of ["r-n1", "r-n2", "r-n3"]) await drop(id);
}

{
  resetRoutineSkipThrottle();
  await seed(routine({ id: "r-replay" }));
  const h = harness({ reject: "channel_not_found" });
  await fanOutDelivery(PR_BODY, "pull_request", "d-replay", h.deps);
  await fanOutDelivery(PR_BODY, "pull_request", "d-replay", h.deps);
  ok((await read("r-replay"))?.consecutiveFailures === 1, "🔴 dedupe: the SAME delivery id twice strikes ONCE — a vendor redelivery of one event is one failed run, not two");
  ok(h.rows(ROUTINE_AUDIT.fireLost).length === 1, "dedupe: and writes one row, unchanged from before the fold existed");
  await drop("r-replay");
}

{
  resetRoutineSkipThrottle();
  await seed(routine({ id: "r-403" }));
  const h = harness({ reject: "channel_not_found", hydrate: { status: "forbidden" } });
  await fanOutDelivery(PR_BODY, "pull_request", "d-403", h.deps);
  const r = await read("r-403");
  ok(
    r?.consecutiveFailures === 0 && r?.status === "active",
    "🔴 taxonomy/403: a hydration REFUSAL does NOT strike, with the fold live — otherwise a repo the agent lost access to would silently disable every routine watching it",
  );
  ok(r?.lastOutcome === undefined, "taxonomy/403: and nothing is recorded as a run at all — a skip is not an outcome");
  ok(h.rows(ROUTINE_AUDIT.skip).length === 1 && h.rows(ROUTINE_AUDIT.fireLost).length === 0, "taxonomy/403: it is still a skip row and still no fire_lost row (OPE-178's switch is untouched)");
  await drop("r-403");
}
{
  resetRoutineSkipThrottle();
  await seed(routine({ id: "r-404" }));
  const h = harness({ hydrate: { status: "gone" } });
  await fanOutDelivery(PR_BODY, "pull_request", "d-404", h.deps);
  const r = await read("r-404");
  ok(h.fired.length === 1, "taxonomy/404: a deleted entity still FIRES on the summary alone");
  ok(r?.consecutiveFailures === 0, "🔴 taxonomy/404: and takes no strike — otherwise create-and-delete ×3 would disable a routine on demand");
  await drop("r-404");
}
{
  resetRoutineSkipThrottle();
  await seed(routine({ id: "r-502" }));
  const h = harness({ hydrate: { status: "error", error: "502 Bad Gateway" } });
  await fanOutDelivery(PR_BODY, "pull_request", "d-502", h.deps);
  const r = await read("r-502");
  ok(
    r?.consecutiveFailures === 1 && r?.lastOutcome === "failed",
    "🔴 taxonomy/5xx: a TRANSIENT hydration failure DOES strike — the arm OPE-178 deliberately routed to fire_lost so that this would be true the day a fold existed, with no edit to its switch",
  );
  ok(h.rows(ROUTINE_AUDIT.fireLost).length === 1 && h.rows(ROUTINE_AUDIT.skip).length === 0, "taxonomy/5xx: still the fire_lost row, still not a skip — the two no-strike rules and this one stay on different rows");
  ok(h.fired.length === 0, "taxonomy/5xx: and it did not fire a half-informed session");
  await drop("r-502");
}

{
  resetRoutineSkipThrottle();
  const ghost = routine({ id: "r-ghost" });
  const h = harness({ reject: "channel_not_found", listRoutines: async () => [ghost] });
  await fanOutDelivery(PR_BODY, "pull_request", "d-ghost", h.deps);
  ok(h.rows(ROUTINE_AUDIT.fireLost).length === 1, "gone-routine: the loss is still RECORDED for a routine that is no longer in the store — the row does not depend on the fold succeeding");
  ok((await read("r-ghost")) === null, "gone-routine: and no row is resurrected by folding onto it");
}

{
  resetRoutineSkipThrottle();
  await seed(routine({ id: "r-soft-1" }));
  await seed(routine({ id: "r-soft-2" }));
  const live = getOperationalStore();
  const broken = new Proxy(live, {
    get(t, p, r) {
      if (p === "updateRoutine") {
        return async () => {
          throw new Error("operational store down");
        };
      }
      const v = Reflect.get(t, p, r) as unknown;
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    },
  }) as OperationalStore;
  registerOperationalStore(broken);
  resetOperationalStore();
  ok(getOperationalStore() === broken, "fail-soft: the broken store is actually the one in play (else this whole section would assert nothing)");
  const h = harness({ reject: "channel_not_found" });
  let threw = false;
  try {
    await fanOutDelivery(PR_BODY, "pull_request", "d-soft", h.deps);
  } catch {
    threw = true;
  }
  registerOperationalStore(live);
  resetOperationalStore();

  ok(!threw, "🔴 fail-soft: a FAILING fold does not throw out of the fan-out — a bookkeeping step must never become an unhandled rejection from a background task");
  ok(
    h.rows(ROUTINE_AUDIT.fireLost).length === 2,
    "🔴 fail-soft: BOTH routines still got their `routine.fire_lost` row — the row is written BEFORE the fold, so the loss survives the fold being the broken thing, and routine 2 is not collateral of routine 1's fold",
  );
  ok((await read("r-soft-1"))?.consecutiveFailures === 0, "fail-soft: the counter is simply not advanced when the store refuses the write (no phantom strike)");
  await drop("r-soft-1");
  await drop("r-soft-2");
}

console.log(`✓ event-leg outcome fold (OPE-180): ${passed} assertions passed`);
