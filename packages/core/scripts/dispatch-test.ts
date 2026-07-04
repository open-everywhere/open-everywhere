import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { routineMarker, type Routine } from "../agent/routines/routine.js";
import { WATCH_SILENCE_SENTINEL, WATCH_STATE_TOOL } from "../agent/routines/watch.js";
import { NO_REPLY_SENTINEL } from "../agent/channels/slack-events.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

const dir = join(tmpdir(), `open-everywhere-dispatch-test-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");
process.env.OE_ROUTINE_MAX_CONCURRENCY = "2";

const store = await import("../agent/routines/store.js");
const dispatch = await import("../agent/schedules/dispatch.js");

const now = new Date("2026-07-02T12:00:00.000Z");
const past = new Date(now.getTime() - 60_000).toISOString();
const N = 5;

for (let i = 0; i < N; i++) {
  const r: Routine = {
    id: `r-${i}`,
    org: "default",
    surfaceKey: "slack/T1/C1",
    trigger: { kind: "interval", everyMinutes: 60 },
    prompt: `routine ${i}`,
    createdAt: now.toISOString(),
    status: "active",
    consecutiveFailures: 0,
    nextRunAt: past,
    target: { channelId: "C1" },
  };
  await store.addRoutine({} as never, r);
}
ok((await store.listAllRoutines()).length === N, "seeded all N due routines");

const firedMessages: Record<string, string> = {};
async function tick(): Promise<string[]> {
  const started: string[] = [];
  const receive = ((_channel: unknown, opts: { message?: string; auth?: { attributes?: Record<string, unknown> } }) => {
    const mk = routineMarker(opts.auth?.attributes as never);
    if (mk) {
      started.push(mk.id);
      firedMessages[mk.id] = opts.message ?? "";
    }
    return Promise.resolve();
  }) as never;
  const args = {
    now,
    receive,
    waitUntil: (_p: Promise<unknown>) => {},
    appAuth: { attributes: {} } as never,
  };
  await dispatch.dispatchTick(args as never);
  return started;
}

const cap = 2;
const allFired: string[] = [];
let ticks = 0;
while (allFired.length < N && ticks < 10) {
  const started = await tick();
  ok(started.length <= cap, `tick ${ticks}: started ${started.length} <= cap ${cap}`);
  for (const id of started) ok(!allFired.includes(id), `routine ${id} fired only once (no double-fire)`);
  allFired.push(...started);
  ticks++;
}

ok(allFired.length === N, "every routine eventually fired");
ok(new Set(allFired).size === N, "all N distinct routines fired exactly once");
ok(ticks === Math.ceil(N / cap), `took the expected number of ticks (${Math.ceil(N / cap)}) at cap ${cap}`);

ok((await tick()).length === 0, "no routine is left over-due after the backlog drains");

ok(WATCH_SILENCE_SENTINEL === NO_REPLY_SENTINEL, "watch protocol's silence sentinel matches the channel's NO_REPLY sentinel");

ok(firedMessages["r-0"] === "routine 0", "an interval fire sends the BARE prompt (no watch protocol)");

const watch: Routine = {
  id: "r-watch",
  org: "default",
  surfaceKey: "slack/T1/C1",
  trigger: { kind: "watch", everyMinutes: 15 },
  prompt: "watch the status page for incidents",
  createdAt: now.toISOString(),
  status: "active",
  consecutiveFailures: 0,
  nextRunAt: past,
  lastOutcome: "skipped",
  target: { channelId: "C1" },
};
await store.addRoutine({} as never, watch);
ok((await tick()).includes("r-watch"), "a due watch routine fires");

const wmsg = firedMessages["r-watch"] ?? "";
ok(wmsg !== watch.prompt && wmsg.includes(watch.prompt), "a watch fire wraps the prompt (not bare interval execution)");
ok(wmsg.includes(WATCH_STATE_TOOL), "the watch turn is told to record its observation via record_watch_state");
ok(wmsg.includes(WATCH_SILENCE_SENTINEL), "the watch turn is taught the silence sentinel for the unchanged case");

const watchAfter = await store.getRoutine("default", "slack/T1/C1", "r-watch");
ok(watchAfter?.lastOutcome === undefined, "a fire CLEARS lastOutcome (outcome pending — the settleOutcome invariant)");
ok(watchAfter?.lastStateHash === undefined, "dispatch never invents a state hash (the tool records the observation)");

const opStore = (await import("../agent/operational/provider.js")).getOperationalStore();
await opStore.setSpendLimit("default", "slack/T1/C2", "surface", 100);
await opStore.recordUsage("default", "slack/T1/C2", "2026-07", { inputTokens: 90, outputTokens: 20 });

const capped: Routine = {
  id: "r-capped",
  org: "default",
  surfaceKey: "slack/T1/C2",
  trigger: { kind: "interval", everyMinutes: 30 },
  prompt: "expensive recurring work",
  createdAt: now.toISOString(),
  status: "active",
  consecutiveFailures: 0,
  nextRunAt: past,
  target: { channelId: "C2" },
};
await store.addRoutine({} as never, capped);
ok((await tick()).length === 0, "an over-budget routine does NOT start a session");

const cappedAfter = await store.getRoutine("default", "slack/T1/C2", "r-capped");
ok(cappedAfter?.lastOutcome === "skipped", "a budget-declined fire records `skipped` (a correct nothing-to-do, not a failure)");
ok(cappedAfter?.consecutiveFailures === 0, "a budget decline never counts toward self-disable");
ok(
  cappedAfter?.nextRunAt !== undefined && cappedAfter?.nextRunAt !== null && Date.parse(cappedAfter.nextRunAt) > now.getTime(),
  "a budget decline advances the schedule (retries at its cadence, not every tick)",
);

rmSync(dir, { recursive: true, force: true });
console.log(`✓ dispatch: ${passed} assertions passed`);
