import { __setTestValveForTest } from "@open-everywhere/core/agent/testing/test-valves.js";
import { registerScript, SCRIPTED_MODEL_VALVE } from "../agent/model/scripted-model.js";
import { frameFacts, frameStepIndex, scriptedModelFor } from "../agent/model/scripted-resolve.js";
import { emptySessionView, foldEvents, type SessionView } from "eve/events";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

const TURN = "turn_frame_1";

const AT = "2000-01-01T00:00:00.000Z";

type Fact = { readonly type: string; readonly data: unknown };

function viewOf(facts: readonly Fact[]): SessionView {
  const events = facts.map((f, line) => ({ ...f, meta: { position: { line, index: 0 }, at: AT, endOfLine: true } }));
  return foldEvents(emptySessionView(), events);
}

const STARTED: Fact = { type: "turn.started", data: { turnId: TURN, cause: { kind: "delivery" }, follows: null } };
const requested = (runId: string, owner: { turnId: string } | { changeId: string } = { turnId: TURN }): Fact => ({ type: "model.requested", data: { runId, owner } });
const settled = (runId: string): Fact => ({ type: "model.settled", data: { runId, outcome: "completed" } });

const raw = viewOf([STARTED, requested("r0"), settled("r0")]);
ok((raw as unknown as { runs?: unknown }).runs === undefined, "negative control: eve's view snapshot exposes no raw runs table");

ok(frameStepIndex({}, TURN) === 0, "no view: step 0");
ok(frameStepIndex({ view: { runs: { r0: { owner: { turnId: TURN }, status: "settled", step: 0 } } } }, TURN) === 0, "a plain object that is not an eve snapshot: step 0");
ok(frameStepIndex({ view: viewOf([STARTED]) }, TURN) === 0, "no run yet: step 0");
ok(frameStepIndex({ view: viewOf([STARTED, requested("r0")]) }, TURN) === 0, "the call's own requested run 0: step 0");
ok(frameStepIndex({ view: viewOf([STARTED, requested("r0"), settled("r0")]) }, TURN) === 1, "run 0 settled, next run not yet requested: step 1");
ok(frameStepIndex({ view: viewOf([STARTED, requested("r0"), settled("r0"), requested("r1")]) }, TURN) === 1, "run 0 settled, run 1 open: step 1");
ok(
  frameStepIndex({ view: viewOf([STARTED, requested("r0"), settled("r0"), requested("r1"), settled("r1"), requested("c0", { changeId: "change_1" }), settled("c0")]) }, TURN) === 2,
  "a context change's run does not count",
);
ok(frameStepIndex({ view: viewOf([STARTED, requested("r0"), settled("r0")]) }, "turn_other") === 0, "another turn's runs do not count");
ok(frameStepIndex({ view: viewOf([STARTED, requested("r0"), settled("r0")]) }, undefined) === 0, "no turn id: step 0");

ok(frameFacts({ turn: { id: TURN, status: "running" } }).turnId === TURN, "a running frame turn gives the turn id");
ok(frameFacts({ turn: { id: TURN, status: "settled" } }).turnId === undefined, "a settled frame turn gives no turn id");
ok(frameFacts({ turn: null }).turnId === undefined, "a frame before the first turn gives no turn id");

__setTestValveForTest(SCRIPTED_MODEL_VALVE, true);
const SESSION = "session_frame_1";
const handle = registerScript({ parent: [{ say: "hello" }] }, SESSION);
let messageReads = 0;
const frame = {
  session: { id: SESSION, auth: {} },
  channel: { kind: "local" },
  turn: { id: TURN, status: "running", input: [] },
  view: viewOf([STARTED, requested("r0"), settled("r0"), requested("r1")]),
  now: new Date(0),
  memo: async (_key: unknown, fn: () => unknown) => await fn(),
  messages: async () => {
    messageReads += 1;
    return [{ role: "user", content: "hello" }];
  },
};
const model = await scriptedModelFor(undefined, frame);
ok(model !== null, "an armed valve answers from the script");
ok(handle.resolves.length === 1, "one resolve is recorded");
ok(handle.resolves[0]?.turnId === TURN, `the resolve takes its turn id from the frame (got ${String(handle.resolves[0]?.turnId)})`);
ok(handle.resolves[0]?.stepIndex === 1, `the resolve takes its step from the frame's runs (got ${String(handle.resolves[0]?.stepIndex)})`);
ok(handle.resolves[0]?.sessionId === SESSION, "the resolve takes its session id from the frame");
ok(messageReads === 1, `the wake-attachment read calls the frame's messages() once (got ${messageReads})`);
handle.dispose();
__setTestValveForTest(SCRIPTED_MODEL_VALVE, false);

console.log(`✓ scripted-resolve-frame: ${passed} assertion(s) on the scripted model's v27 frame reads.`);
