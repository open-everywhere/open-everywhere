import { afterAll, expect, test } from "vitest";

import { NO_REPLY_SENTINEL } from "@open-everywhere/core/agent/channels/normalized-wake.js";

import {
  armSettlement,
  auditCursor,
  awaitWorkResult,
  bootAgent,
  DISCORD_LISTED_CHANNEL_ID,
  discordAmbientWake,
  discordMentionWake,
  registerScript,
  rowsSinceCursor,
  WAKE_FROM_ENVELOPE,
  WAKE_FROM_REPORT,
  waitFor,
  workTaskIdOfCall,
  type ScriptedHandle,
} from "../harness";
import { wakeIdFromPrompt } from "../../../agent/model/scripted-model";

const live = new Set<ScriptedHandle>();
afterAll(() => {
  for (const h of live) h.dispose();
  live.clear();
});
function open(handle: ScriptedHandle): ScriptedHandle {
  live.add(handle);
  return handle;
}
function close(handle: ScriptedHandle): void {
  handle.dispose();
  live.delete(handle);
}

const TASK_CONTINUATION_ADMITTED = "delegation.continuation_admitted";
const QUESTION_PROMPT = "the runbook says to write into the shared bucket — should I use staging instead?";
const ANSWER_TEXT = "use staging, never the shared bucket";
const CHILD_WAITING = "asked the room which bucket to use; the job waits for that answer";
const CHILD_DONE = "understood, wrote it to staging and finished";
const CHILD_REPORT = `${CHILD_DONE}\n\nfor wake ${WAKE_FROM_REPORT}`;
const SEAT_PASSED_ON = "passed your answer on";
const SEAT_REPORT = "staging it is, and the report is written";

async function getStore() {
  const provider = await import("@open-everywhere/core/agent/operational/provider.js");
  return provider.getOperationalStore();
}

test("a worker's question card reaches the room, and the room's answer reaches the same worker as a continuation", async () => {
  await bootAgent({ sharedSqlite: true });
  const org = (await import("@open-everywhere/core/agent/identity/binding.js")).deploymentOrg();
  const cursor = await auditCursor();

  const asking = open(
    registerScript({
      parent: [
        { calls: [{ tool: "work", input: { message: "write the report into the bucket" }, id: "t4-delegate" }] },
        { say: "handing this off" },
      ],
      child: [
        {
          delayMs: 120_000,
          calls: [{ tool: "ask_room", input: { question: QUESTION_PROMPT, options: ["Use staging", "Use the shared bucket"] }, id: "t4-ask" }],
        },
        { say: CHILD_WAITING },
      ],
    }),
  );

  await discordMentionWake({ channelId: DISCORD_LISTED_CHANNEL_ID, text: "<@9000000000000000001> please write the report into the bucket" });
  await waitFor(
    () => asking.requests.find((r) => r.role === "parent" && r.toolResults.some((t) => t.name === "work")),
    "the parent's resumed step carrying the forward receipt",
  );
  const firstResult = open(armSettlement(asking, { parent: [{ say: NO_REPLY_SENTINEL }] }));
  const taskId = await workTaskIdOfCall(cursor, asking, "t4-delegate", "the worker-question forward");
  asking.releaseHolds();

  const childCall = await waitFor(() => asking.requests.find((r) => r.role === "child" && r.stepIndex === 0), "the worker's own first model call");
  expect(childCall.tools).toContain("ask_room");
  expect(childCall.tools).not.toContain("ask_question");
  const worker = String(childCall.sessionId);
  const posted = await waitFor(async () => {
    const rows = await rowsSinceCursor(cursor, ["work.question_posted"]);
    return rows.length > 0 ? rows : undefined;
  }, "the work.question_posted row — the worker's card posted into the room");
  expect(posted).toHaveLength(1);
  expect(JSON.stringify(posted)).not.toContain(QUESTION_PROMPT);
  expect(await rowsSinceCursor(cursor, ["turn.question_dropped"])).toEqual([]);

  const waitingResult = await awaitWorkResult({ handle: firstResult, taskId, label: "the seat step that read the worker's waiting result" });
  expect(waitingResult.messages.some((m) => m.text.includes(CHILD_WAITING))).toBe(true);
  expect((await rowsSinceCursor(cursor, ["delegation.task_settled"])).length).toBeGreaterThan(0);
  expect(asking.requests.filter((r) => r.fault !== undefined)).toEqual([]);
  expect(firstResult.requests.filter((r) => r.fault !== undefined)).toEqual([]);
  close(firstResult);
  close(asking);

  const answering = open(
    registerScript({
      parent: [
        { calls: [{ tool: "work", input: { message: ANSWER_TEXT, taskId }, id: "t4-answer" }] },
        { calls: [{ tool: "reply", input: { wake: WAKE_FROM_ENVELOPE, text: SEAT_PASSED_ON, done: false }, id: "t4-answer-handoff" }] },
      ],
    }),
  );
  const continued = open(registerScript({ parent: [], child: [{ delayMs: 120_000, say: CHILD_REPORT }] }, worker));

  await discordAmbientWake({ channelId: DISCORD_LISTED_CHANNEL_ID, text: ANSWER_TEXT });
  await waitFor(() => answering.requests.find((r) => r.role === "parent" && r.stepIndex === 1), "the seat's answer turn to serve its receipt step");
  const secondResult = open(
    armSettlement(answering, {
      parent: [{ calls: [{ tool: "reply", input: { wake: WAKE_FROM_REPORT, text: SEAT_REPORT, done: true }, id: "t4-report" }] }, { say: "reported" }],
    }),
  );
  continued.releaseHolds();

  expect(await rowsSinceCursor(cursor, ["input_response.routed"])).toEqual([]);
  const seatAnswerStep = answering.requests.find((r) => r.role === "parent" && r.stepIndex === 0)!;
  expect(seatAnswerStep.messages.some((m) => m.text.includes(ANSWER_TEXT)), "the seat's answer turn never saw the room's message").toBe(true);

  const continuations = await waitFor(async () => {
    const rows = await rowsSinceCursor(cursor, [TASK_CONTINUATION_ADMITTED], { limit: 50 });
    const admitted = rows.filter((r) => r.detail?.task === taskId);
    return admitted.length > 0 ? admitted : undefined;
  }, "the admitted task-continuation row for the seat's forward of the answer");
  expect(continuations.length).toBeGreaterThan(0);

  const resumed = await waitFor(() => continued.requests.find((r) => r.role === "child" && r.stepIndex === 0), "the worker's continued turn");
  expect(resumed.sessionId, "a FRESH child answered, not the worker that asked").toBe(worker);
  expect(resumed.turnId).not.toBe(childCall.turnId);
  expect(resumed.messages.some((m) => m.text.includes(ANSWER_TEXT)), "the continued worker was not told what the human answered").toBe(true);

  const doneResult = await awaitWorkResult({ handle: secondResult, taskId, label: "the seat step that read the answered worker's result" });
  expect(doneResult.messages.some((m) => m.text.includes(CHILD_DONE))).toBe(true);
  for (const h of [answering, continued, secondResult]) expect(h.requests.filter((r) => r.fault !== undefined)).toEqual([]);

  const answerWake = wakeIdFromPrompt(seatAnswerStep.messages);
  expect(answerWake, "the seat's answer turn carried no wake envelope").toBeDefined();
  const store = await getStore();
  const settled = await waitFor(async () => {
    const row = await store.getUnifiedWakeRecord(org, answerWake!);
    return row?.answeredAt !== undefined ? row : undefined;
  }, "the answer wake's row carrying answered_at");
  expect(typeof settled.answeredAt).toBe("string");
  expect(settled.answeredTurnId, "the hand-off settled the wake, or a turn other than the settlement turn did").toBe(doneResult.turnId);
  expect(settled.answeredTurnId).not.toBe(seatAnswerStep.turnId);
});
