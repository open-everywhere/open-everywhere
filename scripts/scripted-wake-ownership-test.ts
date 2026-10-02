import {
  __resetWakeOwnersForTest,
  claimWakeOwner,
  incompleteParentTurnFor,
  isForeignWakeStraggler,
  registerScript,
  SCRIPTED_MODEL_ENV,
  wakeOwnerSeq,
  type ForeignWakeCheck,
  type RecordedRequest,
} from "../agent/model/scripted-model.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

const WAKE_A = "00000000-0000-4000-8000-000000000064";
const WAKE_B = "00000000-0000-4000-8000-000000000065";

const STRAGGLER: ForeignWakeCheck = {
  role: "parent",
  wildcard: true,
  callBearing: true,
  absorbsStragglers: false,
  wakeId: WAKE_A,
  ownerSeq: 7,
  seq: 9,
};

function withCheck(over: Partial<ForeignWakeCheck>): ForeignWakeCheck {
  return { ...STRAGGLER, ...over };
}

{
  __resetWakeOwnersForTest();
  ok(wakeOwnerSeq(WAKE_A) === undefined, "a wake no script has served has no owner");
  claimWakeOwner(WAKE_A, 7);
  ok(wakeOwnerSeq(WAKE_A) === 7, "the first registration to serve a wake owns it");
  claimWakeOwner(WAKE_A, 9);
  ok(wakeOwnerSeq(WAKE_A) === 7, "🔴 a LATER registration never takes ownership away from the first");
  ok(wakeOwnerSeq(WAKE_B) === undefined, "…and claiming one wake says nothing about another");
  __resetWakeOwnersForTest();
  ok(wakeOwnerSeq(WAKE_A) === undefined, "the test-only reset forgets every owner");
}

{
  ok(isForeignWakeStraggler(STRAGGLER), "🔴 a call-bearing wildcard step is REFUSED a parent turn of a wake ANOTHER registration owns");
}

{
  ok(!isForeignWakeStraggler(withCheck({ wildcard: false })), "🔴 a SESSION-KEYED entry is never fenced");

  ok(!isForeignWakeStraggler(withCheck({ callBearing: false })), "🔴 a TEXT-ONLY step still answers a straggler — that is what a drain is");

  ok(!isForeignWakeStraggler(withCheck({ role: "child" })), "🔴 the CHILD arm is outside this fence");

  ok(!isForeignWakeStraggler(withCheck({ absorbsStragglers: true })), "🔴 a declared ABSORBER stands the fence aside");
}

{
  ok(!isForeignWakeStraggler(withCheck({ ownerSeq: undefined })), "🔴 a wake NOBODY owns is this leg's own turn and is served");

  ok(!isForeignWakeStraggler(withCheck({ ownerSeq: 9, seq: 9 })), "🔴 a wake THIS registration owns is left to the OPE-727 guard");

  ok(!isForeignWakeStraggler(withCheck({ wakeId: undefined })), "a prompt carrying no envelope is outside the fence");

  ok(!isForeignWakeStraggler(withCheck({ wakeId: undefined, ownerSeq: undefined })), "…and neither half alone makes it one");
}

{
  ok(isForeignWakeStraggler(withCheck({ ownerSeq: 11, seq: 4 })), "an owner registered LATER than this entry still fences it");
}

{
  const prior = process.env[SCRIPTED_MODEL_ENV];
  process.env[SCRIPTED_MODEL_ENV] = "1";
  try {
    const served = (turnId: string, sessionId: string, stepIndex: number): RecordedRequest => ({
      sequence: 1,
      role: "parent",
      sessionId,
      turnId,
      stepIndex,
      pid: process.pid,
      tools: [],
      toolDefinitions: [],
      toolResults: [],
      messages: [],
    });

    const ownSession = "wrun-own";
    const own = registerScript({ parent: [{ say: "a" }, { say: "b" }, { say: "c" }] }, ownSession);
    (own.requests as RecordedRequest[]).push(served("turn_1", ownSession, 0));
    own.dispose();
    ok(
      incompleteParentTurnFor(ownSession)?.turnId === "turn_1",
      "a TEST's own script disposed mid-arm still records its unfinished turn (OPE-995 unchanged)",
    );

    const barrierSession = "wrun-barrier";
    const barrier = registerScript({ parent: [{ say: "a" }, { say: "b" }, { say: "c" }] }, barrierSession, { absorbsStragglers: true });
    (barrier.requests as RecordedRequest[]).push(served("turn_1", barrierSession, 0));
    barrier.dispose();
    ok(
      incompleteParentTurnFor(barrierSession) === undefined,
      "🔴 a declared ABSORBER disposed mid-arm records NOTHING — its straggler goes to the fence, not to an OPE-995 fault",
    );
  } finally {
    if (prior === undefined) delete process.env[SCRIPTED_MODEL_ENV];
    else process.env[SCRIPTED_MODEL_ENV] = prior;
  }
}

console.log(`✓ scripted-wake-ownership: ${passed} assertion(s) on the OPE-2240 foreign-wake fence.`);
