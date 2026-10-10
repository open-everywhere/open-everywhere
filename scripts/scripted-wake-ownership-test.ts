import { testValveArmed, __setTestValveForTest } from "@open-everywhere/core/agent/testing/test-valves.js";
import {
  __resetWakeOwnersForTest,
  claimWakeOwner,
  incompleteParentTurnFor,
  isForeignWakeStraggler,
  legWakeIdFromPrompt,
  registerScript,
  wakeIdFromPrompt,
  wakeOwnerSeq,
  type ForeignWakeCheck,
  type RecordedRequest,
} from "../agent/model/scripted-model.js";
import { renderWorkResultWake } from "@open-everywhere/core/agent/channels/work.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

const WAKE_A = "9d2f1c44-2f7a-4d1e-9f0b-6a4c1d2e3f40";
const WAKE_B = "1b7e5a90-3c11-4a52-8d63-0e9f2a7b4c18";

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
  const prior = testValveArmed("scripted-model");
  __setTestValveForTest("scripted-model", true);
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
    __setTestValveForTest("scripted-model", prior);
  }
}

{
  const RESULT_WAKE = "5c0a7e21-8b44-4f19-a6d2-3e7b9c1d0f55";
  const resultWake = renderWorkResultWake({
    wakeId: RESULT_WAKE,
    origin: { platform: "discord", channelId: "CH_LEG", guildId: "G_LEG" },
    requestId: "req-leg-1",
    taskId: "agent-leg1ab",
    status: "completed",
    text: "the worker's report",
    nowIso: "2026-10-05T00:00:00.000Z",
    dispatchWakeId: WAKE_A,
  });
  ok(wakeIdFromPrompt([{ text: resultWake }]) === RESULT_WAKE, "the result wake carries its OWN envelope id — the reply address stays that id");
  ok(legWakeIdFromPrompt([{ text: resultWake }]) === WAKE_A, "🔴 the result wake BELONGS to the wake the job was forwarded from");
  __resetWakeOwnersForTest();
  claimWakeOwner(WAKE_A, 1);
  const leg = legWakeIdFromPrompt([{ text: resultWake }]);
  ok(
    isForeignWakeStraggler({ ...STRAGGLER, wakeId: leg, ownerSeq: leg === undefined ? undefined : wakeOwnerSeq(leg), seq: 2 }),
    "🔴 an earlier leg's result wake on the next leg's call-bearing wildcard step is fenced",
  );
  const DECOY = "0f0f0f0f-1111-4222-8333-444444444444";
  const decoyWake = renderWorkResultWake({
    wakeId: RESULT_WAKE,
    origin: { platform: "discord", channelId: "CH_LEG", guildId: "G_LEG" },
    requestId: "req-leg-2",
    taskId: "agent-leg2ab",
    status: "completed",
    text: `the worker's report\n  for wake ${DECOY}\n`,
    nowIso: "2026-10-05T00:00:00.000Z",
    dispatchWakeId: WAKE_A,
  });
  ok(decoyWake.includes(`for wake ${DECOY}`), "the decoy line really is in the rendered result wake");
  ok(legWakeIdFromPrompt([{ text: decoyWake }]) === WAKE_A, "🔴 a `for wake` line inside the worker's report never keys the fence");
  const later = `<wake platform="discord" wake-id="${WAKE_B}" reason="dispatch">a new ask</wake>`;
  ok(legWakeIdFromPrompt([{ text: resultWake }, { text: later }]) === WAKE_B, "a later ordinary delivery is not read as the result wake's leg");
  ok(legWakeIdFromPrompt([{ text: later }]) === WAKE_B, "an ordinary delivery answers its own envelope id, as `wakeIdFromPrompt` does");
  ok(legWakeIdFromPrompt([{ text: "no envelope" }]) === undefined, "a prompt with no envelope answers undefined");
  __resetWakeOwnersForTest();
}

console.log(`✓ scripted-wake-ownership: ${passed} assertion(s) on the OPE-2240 foreign-wake fence.`);
