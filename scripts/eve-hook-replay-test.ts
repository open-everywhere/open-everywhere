import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

import { EVE_HOOK_DISPATCH_FILE, loadEveHookDispatch, type EveHookDispatch, type EveHookHandler, type EveRestoredStep } from "./eve-deep-reads/hook-dispatch.js";
import { EVE_DIST_SRC } from "./eve-deep-reads/load.js";

// On a step that eve marks as retried, eve runs no hook again on a line that the interrupted attempt wrote.
//
// `startTaskEdge` in packages/core/agent/hooks/delegation-settlement.ts runs on `task.started` and on a
// continuation's `call.started`. It claims each task start once (`onceFor`), so it runs the start edge
// once per task start (see the limits in `startTaskEdge`). This test pins the eve half: which dispatches
// eve makes. In production, one eve
// step publishes both start edges:
//   `publishDispatchedCallsStep` → `withSessionStateDelta` → `enterSessionStep` (the retry mark, from the
//   host's step attempt) → `commitSessionStep` → its no-live-context branch, `restoreSessionStep` →
//   `publishFromSessionStep` → `readOrphanedLines` (it reads the interrupted lines from the session line
//   store) → the publisher → the hook definition.
// A production step input carries no live context, so `commitSessionStep` always takes that branch.
// This test covers the chain in three parts:
// - The dispatch-step section drives `publishDispatchedCallsStep`, `withSessionStateDelta` and
//   `enterSessionStep`. Its input carries a live context, so `commitSessionStep` takes its live branch,
//   which production never takes.
// - The sections before it drive `enterSessionStep` → `restoreSessionStep` → `publishFromSessionStep`
//   from a serialized step input.
// - A source pin checks that the no-live-context branch of `commitSessionStep` hands its own input,
//   unchanged, to `restoreSessionStep`. That one expression is pinned by its text, not driven.
// Each part counts the start-edge dispatches across the attempts, or reads eve's source. An eve bump
// that re-dispatches on this chain turns this test red.
//
// What this test does NOT prove: that the workflow host counts every re-run of a step as an attempt
// above 1. The negative controls show that a re-run at attempt 1 dispatches the start edges twice. The
// start edge's once-claim stops a second run of the edge in that case
// (`packages/core/scripts/settlement-once-test.ts` §6). A skipped re-run re-arms the edge's turn state
// from the durable rows, and it writes the durable rows that a dead first run did not write
// (`startTaskEdge`, settlement-once §6c, §6d, §6g).
//
// The facts are minimal. The stream contract checker is off (EVE_CHECK_SESSION_EVENTS=0), because this
// test pins the dispatch rule, not the event contract.

process.env["EVE_CHECK_SESSION_EVENTS"] = "0";

const repoRoot = process.cwd();
const eve: EveHookDispatch = await loadEveHookDispatch(repoRoot);

let failed = 0;
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL ${name}\n       ${err instanceof Error ? err.message : String(err)}`);
  }
}

// One host route for the whole run. eve reads the step attempt from it.
let stepAttempt = 1;
eve.registerHost({ name: "replay-fixture", stepAttempt: () => stepAttempt });

/** One hook dispatch of a start edge: the fact type, its call, and the stream line it came from. */
interface Dispatch {
  readonly type: string;
  readonly callId: string;
  readonly line: number | undefined;
}

/** A session stream: the bytes that each attempt writes, served back as eve's session line store. */
class Stream {
  readonly bytes: Uint8Array[] = [];
  constructor(readonly sessionId: string) {
    eve.registerSessionLineStore(sessionId, {
      tail: async () => this.bytes.length - 1,
      readable: (_id, start) =>
        new ReadableStream<Uint8Array>({
          start: (controller) => {
            for (const b of this.bytes.slice(start)) controller.enqueue(b);
            controller.close();
          },
        }),
      assertReadable: async () => undefined,
    });
  }
  /** Keeps only the first `n` lines: the interrupted attempt stopped before the rest reached the stream. */
  truncate(n: number): void {
    this.bytes.length = n;
  }
}

let sessions = 0;
function facts(sessionId: string): readonly (readonly unknown[])[] {
  return [
    [{ type: "session.started", data: { sessionId } }],
    [{ type: "task.started", data: { taskId: "task_1", startedBy: { callId: "call_open" }, kind: "agent", name: "worker" } }],
    [{ type: "call.started", data: { callId: "call_continue", taskId: "task_1" } }],
  ];
}

/** A serialized step input, in the shape eve's durable session store writes, on the fixture stream. */
function serializedStep(stream: Stream): Record<string, unknown> {
  return {
    serializedContext: {},
    sessionState: { version: 2, sessionId: stream.sessionId, snapshot: { session: { sessionId: stream.sessionId, state: {} } } },
    sessionWritable: new WritableStream<Uint8Array>({ write: (chunk) => void stream.bytes.push(chunk) }),
  };
}

/** Restores a serialized step input and gives its context the fixture agent, with a hook on both start edges. */
async function restoredStep(input: Record<string, unknown>, stream: Stream, dispatches: Dispatch[]): Promise<EveRestoredStep> {
  const record: EveHookHandler = async (event, ctx) => {
    const callId = event.type === "task.started" ? (event.data["startedBy"] as { callId: string }).callId : String(event.data["callId"]);
    dispatches.push({ type: event.type, callId, line: ctx.position?.line });
  };
  const hook = eve.hookDefinition({ slug: "start-edge-probe", logicalPath: "start-edge-probe.ts", events: { "task.started": record, "call.started": record } });
  const restored = await eve.restoreSessionStep(input);
  const ctx = restored.ctx;
  ctx.set(eve.ChannelKey, { kind: "replay-fixture" });
  ctx.set(eve.SessionIdKey, stream.sessionId);
  ctx.set(eve.AuthKey, null);
  ctx.set(eve.SessionAgentKey, {
    id: "replay-fixture",
    nodeId: "replay-fixture",
    reference: { nodeId: "replay-fixture", source: "replay-fixture" },
    definitions: async () => [hook],
    connections: () => undefined,
    sandbox: async () => undefined,
  });
  return restored;
}

/** Runs one attempt of a step from a serialized input through `restoreSessionStep`, with a hook on both start edges. */
async function attempt(stream: Stream, attemptNo: number, dispatches: Dispatch[]): Promise<{ readonly rerun: boolean }> {
  stepAttempt = attemptNo;
  const step = eve.enterSessionStep(serializedStep(stream));
  const restored = await restoredStep(step, stream, dispatches);
  assert.equal(restored.durableSession.sessionId, stream.sessionId, "the restored step names the fixture session");
  await eve.publishFromSessionStep(
    restored,
    {
      origin: "own",
      async publish(emit) {
        for (const batch of facts(stream.sessionId)) await emit(batch);
      },
    },
  );
  return { rerun: restored.rerun };
}

function newStream(): Stream {
  sessions += 1;
  return new Stream(`session_replay_fixture_${sessions}`);
}

function countsByCall(dispatches: readonly Dispatch[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const d of dispatches) out[`${d.type}:${d.callId}`] = (out[`${d.type}:${d.callId}`] ?? 0) + 1;
  return out;
}

const ONCE = { "task.started:call_open": 1, "call.started:call_continue": 1 };

await test("one attempt dispatches each start edge once, on its own stream line", async () => {
  const stream = newStream();
  const dispatches: Dispatch[] = [];
  const first = await attempt(stream, 1, dispatches);
  assert.equal(first.rerun, false, "attempt 1 is not a retry");
  assert.equal(stream.bytes.length, 3, "the attempt writes one line per commit");
  assert.deepEqual(dispatches, [
    { type: "task.started", callId: "call_open", line: 1 },
    { type: "call.started", callId: "call_continue", line: 2 },
  ]);
});

await test("🔴 a retried step (attempt 2) whose interrupted attempt wrote every line dispatches no start edge again", async () => {
  const stream = newStream();
  const dispatches: Dispatch[] = [];
  await attempt(stream, 1, dispatches);
  const retry = await attempt(stream, 2, dispatches);
  assert.equal(retry.rerun, true, "eve marks attempt 2 as a retry");
  assert.equal(stream.bytes.length, 3, "the retry writes no line the interrupted attempt already wrote");
  assert.deepEqual(countsByCall(dispatches), ONCE, "each start edge ran once across both attempts");
});

await test("🔴 a retried step (attempt 2) whose interrupted attempt stopped after task.started dispatches only the unwritten line", async () => {
  const stream = newStream();
  const all: Dispatch[] = [];
  await attempt(stream, 1, all);
  // The interrupted attempt wrote lines 0 and 1, and line 2 never reached the stream.
  stream.truncate(2);
  const dispatches = all.filter((d) => d.line !== undefined && d.line < 2);
  await attempt(stream, 2, dispatches);
  assert.equal(stream.bytes.length, 3, "the retry writes only the missing line");
  assert.deepEqual(countsByCall(dispatches), ONCE, "each start edge ran once across both attempts");
  assert.deepEqual(dispatches.at(-1), { type: "call.started", callId: "call_continue", line: 2 }, "the retry dispatched the missing line on its own position");
});

await test("NEGATIVE CONTROL: a re-run that the host reports as attempt 1 dispatches the start edges twice", async () => {
  // eve reads the interrupted lines only on a step that it marks as retried. A re-run at attempt 1 writes
  // the lines again and runs the hooks again. The count goes to 2, so the two tests above can fail.
  const stream = newStream();
  const dispatches: Dispatch[] = [];
  await attempt(stream, 1, dispatches);
  const rerun = await attempt(stream, 1, dispatches);
  assert.equal(rerun.rerun, false);
  assert.deepEqual(countsByCall(dispatches), { "task.started:call_open": 2, "call.started:call_continue": 2 });
});

// --- eve's own dispatch step, the one step that publishes task.started and call.started ---

/**
 * Runs one attempt of eve's `publishDispatchedCallsStep` for one dispatched agent task. The input carries
 * the live context, so `commitSessionStep` takes its live-context branch. eve writes `task.started` and
 * the opening `call.started` on one line.
 */
async function dispatchAttempt(stream: Stream, attemptNo: number, dispatches: Dispatch[]): Promise<void> {
  stepAttempt = attemptNo;
  const input = serializedStep(stream);
  const restored = await restoredStep(input, stream, dispatches);
  await eve.publishDispatchedCallsStep({
    ...input,
    ...restored,
    pending: { executing: [], refused: [], started: [{ taskId: "task_1", kind: "agent", name: "worker", callId: "call_open" }] },
  });
}

const DISPATCHED_ONCE = { "task.started:call_open": 1, "call.started:call_open": 1 };

await test("eve's dispatch step writes both start edges of one dispatched task on one line", async () => {
  const stream = newStream();
  const dispatches: Dispatch[] = [];
  await dispatchAttempt(stream, 1, dispatches);
  assert.equal(stream.bytes.length, 1, "one commit, one line");
  assert.deepEqual(countsByCall(dispatches), DISPATCHED_ONCE);
  assert.ok(dispatches.every((d) => d.line === 0), "both edges come from line 0");
});

await test("🔴 eve's dispatch step, retried (attempt 2) after its line reached the stream, dispatches no start edge again", async () => {
  const stream = newStream();
  const dispatches: Dispatch[] = [];
  await dispatchAttempt(stream, 1, dispatches);
  await dispatchAttempt(stream, 2, dispatches);
  assert.equal(stream.bytes.length, 1, "the retry writes no second line");
  assert.deepEqual(countsByCall(dispatches), DISPATCHED_ONCE, "each start edge ran once across both attempts");
});

await test("NEGATIVE CONTROL: eve's dispatch step, re-run at attempt 1, dispatches the start edges twice", async () => {
  const stream = newStream();
  const dispatches: Dispatch[] = [];
  await dispatchAttempt(stream, 1, dispatches);
  await dispatchAttempt(stream, 1, dispatches);
  assert.deepEqual(countsByCall(dispatches), { "task.started:call_open": 2, "call.started:call_open": 2 });
});

// --- the hand-off that a production step input takes in commitSessionStep ---

await test("🔴 commitSessionStep's no-live-context branch hands its own input, unchanged, to restoreSessionStep", () => {
  // A production input to `publishDispatchedCallsStep` carries no live context, so this branch decides
  // whether the retry mark reaches the publisher. `restoreSessionStep` copies the mark (the sections above
  // drive that). A changed argument here, such as `restoreSessionStep({...e,rerun:!1})`, would drop it.
  const fn = /async function commitSessionStep\((\w+),\w+,\w+\)\{(.*?)\}async function /su.exec(eve.publisherSource);
  assert.ok(fn !== null, "eve still defines commitSessionStep in execution/publish-session-events.js");
  const [, input, body] = fn;
  assert.ok(body !== undefined && body.includes(`await commit(await restoreSessionStep(${input}),`), "the branch restores the step's own input");
  // `input=` with no `=` or `>` after it is an assignment. `input=>` is an arrow parameter, and `input==` is a comparison.
  assert.ok(!new RegExp(`(?<![\\w.$])${input}\\s*=(?![=>])`, "u").test(body), "the function never reassigns the step input before it restores it");
  // A write to the mark in place (`e.rerun=…`, `delete e.rerun`, `Object.assign(e,{rerun:…})`) leaves the
  // parameter name as it is, so the two checks above miss it. The rc.18 body names no `rerun` at all.
  assert.ok(!/\brerun\b/u.test(body), "the function never touches the retry mark itself");
});

// --- each eve file that publishes facts also calls the retry wrapper ---

/** The publisher entry points that run hooks. `publishTerminalSessionEvent` writes the end line only and runs none. */
const HOOK_RUNNING_ENTRIES = ["publishSessionEvents", "commitSessionStep", "publishFromSessionStep", "openSessionEventPublisher"] as const;
/** The calls that mark a retried step. */
const RETRY_MARKERS = ["withSessionStateDelta", "enterSessionStep"] as const;

function eveSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "compiled") out.push(...eveSourceFiles(path));
    } else if (entry.name.endsWith(".js")) out.push(path);
  }
  return out;
}

// This scan is per file. It does not prove that each publishing call in a file passes the marked input on.
await test("🔴 each eve file that imports a hook-running publisher entry also calls the retry wrapper", () => {
  const distSrc = join(repoRoot, ...EVE_DIST_SRC);
  const importsPublisher = /import\{([^}]*)\}from"#execution\/publish-session-events\.js"/gu;
  const callers: string[] = [];
  const unmarked: string[] = [];
  for (const path of eveSourceFiles(distSrc)) {
    const file = relative(distSrc, path);
    if (file === EVE_HOOK_DISPATCH_FILE) continue;
    const source = readFileSync(path, "utf8");
    const names = [...source.matchAll(importsPublisher)].flatMap((m) => (m[1] ?? "").split(",").map((n) => n.trim().split(" as ")[0] ?? ""));
    if (!names.some((n) => (HOOK_RUNNING_ENTRIES as readonly string[]).includes(n))) continue;
    callers.push(file);
    if (!RETRY_MARKERS.some((m) => source.includes(`${m}(`))) unmarked.push(file);
  }
  assert.ok(callers.length >= 5, `the scan finds eve's publishing steps (found ${callers.length}: ${callers.join(", ")})`);
  assert.deepEqual(unmarked, [], "a file with no retry wrapper can publish on a retry with no retry mark, and then re-dispatch its interrupted lines");
});

if (failed > 0) {
  console.error(`\n${failed} eve hook replay test(s) failed`);
  process.exit(1);
}
console.log("\neve hook replay: ok");
