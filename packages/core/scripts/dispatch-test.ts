import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { routineMarker, type Routine } from "../agent/routines/routine.js";

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

async function tick(): Promise<string[]> {
  const started: string[] = [];
  const receive = ((_channel: unknown, opts: { auth?: { attributes?: Record<string, unknown> } }) => {
    const mk = routineMarker(opts.auth?.attributes as never);
    if (mk) started.push(mk.id);
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

rmSync(dir, { recursive: true, force: true });
console.log(`✓ dispatch: ${passed} assertions passed`);
