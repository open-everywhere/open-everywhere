import { afterAll, expect, test } from "vitest";

import { NO_REPLY_SENTINEL } from "@open-everywhere/core/agent/channels/normalized-wake.js";
import {
  afterThisTest,
  armSettlement,
  auditCursor,
  awaitWindowQuiet,
  bootAgent,
  consumeSettlement,
  disposeLater,
  installSlackWebApiStub,
  registerScript,
  rowsSinceCursor,
  SETTLEMENT_DRAIN_CLOSING_SCRIPT,
  SLACK_TEAM_ID,
  slackMentionWake,
  slackTs,
  taskIdOfWorkDelegation,
  waitFor,
  WAKE_FROM_ENVELOPE,
  workTaskIdOfCall,
  type AuditCursor,
  type AuditRow,
  type RecordedRequest,
  type ScriptedHandle,
  type SeatScript,
} from "../harness";

const SLACK_CHANNEL = "C0EXCHAN003";
const SLACK_BOT = "U0OPE2269BOT";
const MEMBER_A = "U0OPE2269AAA";
const MEMBER_B = "U0OPE2269BBB";

const WORKER_HOLD_MS = 120_000;
const SEAT_TURN_START_BOUND_MS = 10_000;
const SEAT_ANSWER_BOUND_MS = 15_000;
const A_TURN_END_CEILING_MS = 60_000;

const A_BRIEF = "ope2269 worker brief: take a long measured time over this";
const A_PENDING = "ope2269: I have started a worker for you.";
const B_REPLY = "ope2269: answering you now, while the other worker is still running.";
const CHILD_RESULT = "ope2269 worker result";
const WORKER_QUESTION = "ope2269 probe: the connector write needs a decision — approve it?";
const CHILD_WAITING = "ope2269: I asked the room; the job waits for that answer.";

const B_ASK = "a quick question from someone else";
function bAskFor(micros: number): string {
  return `${B_ASK} ${micros}`;
}

const cleanups: (() => void)[] = [];
afterAll(() => {
  for (const c of cleanups.splice(0).reverse()) c();
});

let slackArmed = false;
function armSlack(): void {
  if (slackArmed) return;
  slackArmed = true;
  const slack = installSlackWebApiStub((method, params) => {
    if (method === "auth.test") return { ok: true, user_id: SLACK_BOT, bot_id: "B0OPE2269BOT", team_id: SLACK_TEAM_ID };
    if (method === "users.info") {
      const id = params.get("user") ?? "";
      const name = id === SLACK_BOT ? "ottobot" : `ope2269-${id.slice(-3).toLowerCase()}`;
      return { ok: true, user: { id, team_id: SLACK_TEAM_ID, name, real_name: name, profile: { display_name: name, real_name: name } } };
    }
    if (method === "conversations.members") return { ok: true, members: [], response_metadata: { next_cursor: "" } };
    if (method === "conversations.info") {
      return {
        ok: true,
        channel: {
          id: params.get("channel"),
          name: "it-ope2269",
          is_channel: true,
          is_private: false,
          is_ext_shared: false,
          is_org_shared: false,
          is_shared: false,
          is_pending_ext_shared: false,
          num_members: 9,
        },
      };
    }
    if (method === "conversations.history" || method === "conversations.replies") return { ok: true, messages: [] };
    if (method === "chat.postMessage") return { ok: true, channel: params.get("channel"), ts: slackTs(Date.now(), 22690) };
    return undefined;
  });
  cleanups.push(() => slack.uninstall());
}

function detailOf(row: AuditRow | undefined): Record<string, unknown> {
  return (row?.detail ?? {}) as Record<string, unknown>;
}

function promptOf(request: RecordedRequest): string {
  return request.messages.map((message) => message.text).join("\n");
}

async function mention(input: { readonly userId: string; readonly text: string; readonly micros: number }): Promise<void> {
  const ts = slackTs(Date.now(), input.micros);
  const res = await slackMentionWake({
    channelId: SLACK_CHANNEL,
    userId: input.userId,
    text: `<@${SLACK_BOT}> ${input.text}`,
    ts,
    eventId: `EvOPE2269${input.micros}${ts.replace(".", "")}`,
  });
  expect(res.status, `the Slack front refused the mention: ${res.body.slice(0, 300)}`).toBe(200);
}

function seatStepsForA(callIdPrefix: string): SeatScript["parent"] {
  return [
    { calls: [{ tool: "work", input: { message: A_BRIEF }, id: `${callIdPrefix}-dispatch` }] },
    { calls: [{ tool: "reply", input: { wake: WAKE_FROM_ENVELOPE, text: A_PENDING, done: false }, id: `${callIdPrefix}-a-reply` }] },
    { say: NO_REPLY_SENTINEL },
  ];
}

function seatStepsForB(callIdPrefix: string): SeatScript["parent"] {
  return [
    { calls: [{ tool: "reply", input: { wake: WAKE_FROM_ENVELOPE, text: B_REPLY, done: false }, id: `${callIdPrefix}-b-reply` }] },
    { say: NO_REPLY_SENTINEL },
  ];
}

interface AnsweredWake {
  readonly reply: AuditRow;
  readonly ingressMs: number;
  readonly turnStartMs: number;
  readonly sessionId: string;
  readonly turnId: string;
}

async function awaitAnsweredWake(
  cursor: AuditCursor,
  input: { readonly principalId: string; readonly chars: number; readonly label: string },
): Promise<AnsweredWake> {
  const reply = await waitFor(async () => {
    const rows = await rowsSinceCursor(cursor, ["reply.post"], { limit: 300 });
    return rows.find((r) => r.principalId === input.principalId && detailOf(r).chars === input.chars);
  }, `${input.label}: a reply.post row attributed to ${input.principalId}`);
  const wakeId = detailOf(reply).wakeId;
  expect(typeof wakeId, `${input.label}: the reply row carries no wake id, so no anchor can be joined to it`).toBe("string");
  const ingress = await waitFor(async () => {
    const rows = await rowsSinceCursor(cursor, ["wake.ingress"], { limit: 300 });
    return rows.find((r) => detailOf(r).wakeId === wakeId);
  }, `${input.label}: the wake.ingress anchor for wake ${String(wakeId)}`);
  const turnStart = await waitFor(async () => {
    const rows = await rowsSinceCursor(cursor, ["wake.turn_start"], { limit: 300 });
    return rows.find((r) => detailOf(r).wakeId === wakeId);
  }, `${input.label}: the wake.turn_start anchor for wake ${String(wakeId)}`);
  const sessionId = detailOf(turnStart).sessionId;
  const turnId = detailOf(turnStart).turnId;
  expect(typeof sessionId, `${input.label}: the turn-start row names no session, so the same-seat compare would prove nothing`).toBe("string");
  expect(typeof turnId, `${input.label}: the turn-start row names no turn, so the separate-turn compare would prove nothing`).toBe("string");
  return {
    reply,
    ingressMs: Date.parse(detailOf(ingress).ingressTs as string),
    turnStartMs: Date.parse(detailOf(turnStart).turnStartTs as string),
    sessionId: sessionId as string,
    turnId: turnId as string,
  };
}

function assertBoundsAreUnderTheHold(): void {
  expect(SEAT_TURN_START_BOUND_MS, "a turn-start bound at or above the worker's hold is green against a seat that waits").toBeLessThan(WORKER_HOLD_MS);
  expect(SEAT_ANSWER_BOUND_MS, "an answer bound at or above the worker's hold is green against a seat that waits").toBeLessThan(WORKER_HOLD_MS);
}

function assertSnappy(b: AnsweredWake, a: AnsweredWake, label: string): void {
  const startMs = b.turnStartMs - b.ingressMs;
  const answerMs = Date.parse(b.reply.ts) - b.ingressMs;
  expect(b.sessionId, `${label}: B was served by a DIFFERENT session, so this is not the same domain seat`).toBe(a.sessionId);
  expect(b.turnId, `${label}: B's answer came on A's own turn, so nothing here measures a second caller`).not.toBe(a.turnId);
  expect(startMs, `${label}: B's wake.turn_start row is stamped BEFORE its own wake.ingress row (${startMs} ms) — the host's clock stepped, so the bound below is not a measurement`).toBeGreaterThanOrEqual(0);
  expect(
    answerMs,
    `${label}: B's reply row is stamped BEFORE its own wake.ingress row (answer ${answerMs} ms, turn start ${startMs} ms) — the host's clock stepped, so neither latency is a measurement`,
  ).toBeGreaterThanOrEqual(startMs);
  expect(
    startMs,
    `🔴 ${label}: B's turn started ${startMs} ms after arrival, over the ${SEAT_TURN_START_BOUND_MS} ms bound. ` +
      `A's worker was still working, so a seat that waits on it lands here — which is the eve 0.69 behaviour ` +
      "OPE-2246 measured (15.7 s on a 20 s worker) and OPE-2267 must answer.",
  ).toBeLessThan(SEAT_TURN_START_BOUND_MS);
  expect(
    answerMs,
    `🔴 ${label}: B was answered ${answerMs} ms after arrival, over the ${SEAT_ANSWER_BOUND_MS} ms bound (turn start was ${startMs} ms).`,
  ).toBeLessThan(SEAT_ANSWER_BOUND_MS);
  console.log(
    `[ope2269] ${label}: B's turn started +${startMs} ms, answered +${answerMs} ms ` +
      `(bounds ${SEAT_TURN_START_BOUND_MS} / ${SEAT_ANSWER_BOUND_MS} ms)`,
  );
}

function assertNoFault(handle: ScriptedHandle, label: string): void {
  expect(
    handle.requests.filter((r) => r.fault !== undefined).map((r) => `${r.role}#${r.stepIndex}: ${String(r.fault)}`),
    `${label}: a scripted request degraded instead of answering the script`,
  ).toEqual([]);
}

async function driveAAndAwaitTurnEnd(handle: ScriptedHandle, label: string, micros: number): Promise<void> {
  await mention({ userId: MEMBER_A, text: "ope2269 please delegate this", micros });
  await waitFor(
    () => handle.requests.find((r) => r.role === "parent" && r.stepIndex === 1),
    `${label}: A's dispatch turn to serve its last step. 🔴 A seat that HOLDS ITS TURN OPEN while the worker works never ` +
      "gets here — which is the eve 0.69/0.70 behaviour OPE-2246 measured and OPE-2267 must answer, not a defect in this test",
    A_TURN_END_CEILING_MS,
  );
  assertNoFault(handle, `${label}: A's dispatch turn`);
}

test("the domain seat answers a second principal while the first one's worker holds a long job", async () => {
  assertBoundsAreUnderTheHold();
  armSlack();
  await bootAgent();
  const cursor = await auditCursor();
  const label = "arm ① worker in flight";

  const forA = disposeLater(
    registerScript({
      parent: seatStepsForA("ope2269"),
      child: [{ delayMs: WORKER_HOLD_MS, say: CHILD_RESULT }],
    }),
  );
  afterThisTest(() => forA.releaseHolds());

  await driveAAndAwaitTurnEnd(forA, label, 22691);

  const worker = await waitFor(() => forA.requests.find((r) => r.role === "child" && r.stepIndex === 0), `${label}: the delegated worker's first model call`);
  expect(promptOf(worker), `${label}: the worker was dispatched without A's brief, so this is not the delegation the arm set up`).toContain(A_BRIEF);
  const started = await waitFor(async () => {
    const rows = await rowsSinceCursor(cursor, ["delegation.task_started"], { limit: 50 });
    return rows.length > 0 ? rows : undefined;
  }, `${label}: a delegation.task_started row for A's worker`);
  expect(started).toHaveLength(1);

  forA.dispose();
  const forB = disposeLater(registerScript({ parent: seatStepsForB("ope2269") }));

  const bAsk = bAskFor(22692);
  await mention({ userId: MEMBER_B, text: `ope2269 ${bAsk}`, micros: 22692 });

  const bAnswer = await awaitAnsweredWake(cursor, { principalId: MEMBER_B, chars: B_REPLY.length, label });
  const aAnswer = await awaitAnsweredWake(cursor, { principalId: MEMBER_A, chars: A_PENDING.length, label: `${label} (A's own hand-off)` });

  expect(
    await rowsSinceCursor(cursor, ["delegation.task_settled", "delegation.task_failed"], { limit: 50 }),
    `${label}: A's worker had already settled when B was answered, so this run never measured a seat under load`,
  ).toEqual([]);

  expect(bAnswer.reply.principalId, `${label}: B's reply row names someone else as the asker`).toBe(MEMBER_B);
  expect(bAnswer.reply.surface, `${label}: B was answered in a different room`).toBe(SLACK_CHANNEL);

  assertSnappy(bAnswer, aAnswer, label);

  const bTurn = forB.requests.find((r) => r.role === "parent" && r.stepIndex === 0);
  expect(bTurn, `${label}: the seat never reached the step scripted for B's turn`).toBeDefined();
  expect(promptOf(bTurn!), `${label}: B's served prompt does not carry B's own message`).toContain(bAsk);
  expect(typeof bTurn!.sessionId, `${label}: B's model call recorded no session id, so the same-seat compare would prove nothing`).toBe("string");
  expect(bTurn!.sessionId, `${label}: B's model call ran in a different session from A's — not one domain seat`).toBe(
    forA.requests.find((r) => r.role === "parent" && r.stepIndex === 0)?.sessionId,
  );

  assertNoFault(forB, label);

  const taskId = await taskIdOfWorkDelegation(cursor, "arm ①'s worker");
  await waitFor(
    () => forB.requests.find((r) => r.role === "parent" && r.stepIndex === 0),
    `${label}: B's own turn to serve its LAST step before the key is swapped`,
    A_TURN_END_CEILING_MS,
  );
  forB.dispose();
  const closing = disposeLater(armSettlement(forA, SETTLEMENT_DRAIN_CLOSING_SCRIPT));
  forA.releaseHolds();
  await waitFor(() => (forA.holdsCutShort() > 0 ? true : undefined), `${label}: the worker's hold to end on the release rather than on its own delayMs`);
  await consumeSettlement({ armed: closing, dispatched: forA, taskId, label: `${label}: the worker's settlement wake, keyed on its own task id` });
  await waitFor(() => closing.requests.find((r) => r.role === "parent" && r.stepIndex === 1), `${label}: the closing drain's second no_reply`, 60_000);
  assertNoFault(closing, `${label}: the closing drain`);
  await awaitWindowQuiet();
}, 600_000);

test("a worker's pending question card holds no turn, and the domain seat still answers a second principal", async () => {
  assertBoundsAreUnderTheHold();
  armSlack();
  await bootAgent();
  const cursor = await auditCursor();
  const label = "arm ② question card pending";

  const forA = disposeLater(
    registerScript({
      parent: seatStepsForA("ope2269-card"),
      child: [
        { delayMs: WORKER_HOLD_MS, calls: [{ tool: "ask_room", input: { question: WORKER_QUESTION }, id: "ope2269-ask" }] },
        { say: CHILD_WAITING },
      ],
    }),
  );
  afterThisTest(() => forA.releaseHolds());

  await driveAAndAwaitTurnEnd(forA, label, 22693);
  const taskId = await workTaskIdOfCall(cursor, forA, "ope2269-card-dispatch", "arm ②'s worker");
  const closing = disposeLater(armSettlement(forA, SETTLEMENT_DRAIN_CLOSING_SCRIPT));
  forA.releaseHolds();

  const asked = await waitFor(async () => {
    const rows = await rowsSinceCursor(cursor, ["work.question_posted"], { limit: 50 });
    return rows.length > 0 ? rows : undefined;
  }, `${label}: the work.question_posted row for the worker's card`);
  expect(asked).toHaveLength(1);
  expect(JSON.stringify(asked), `${label}: the worker's model-authored question reached the audit plane`).not.toContain(WORKER_QUESTION);
  const cardResult = await waitFor(
    () => forA.requests.find((r) => r.role === "child" && r.toolResults.some((t) => t.name === "ask_room"))?.toolResults.find((t) => t.name === "ask_room"),
    `${label}: the worker's step that read the ask_room result`,
  );
  expect(cardResult.isError, `${label}: ask_room failed: ${JSON.stringify(cardResult.output)}`).toBe(false);
  const askingStep = forA.requests.find((r) => r.role === "child" && r.stepIndex === 0);
  expect(askingStep?.tools, `${label}: the work-session child still holds ask_question`).not.toContain("ask_question");
  expect(askingStep?.tools, `${label}: the work-session child does not hold ask_room`).toContain("ask_room");

  await consumeSettlement({ armed: closing, dispatched: forA, taskId, label: `${label}: the worker's result wake, keyed on its own task id` });
  await waitFor(() => closing.requests.find((r) => r.role === "parent" && r.stepIndex === 1), `${label}: the closing drain's second no_reply`, 60_000);
  assertNoFault(closing, `${label}: the closing drain`);
  const settled = await rowsSinceCursor(cursor, ["delegation.task_settled"], { limit: 50 });
  expect(settled.length, `${label}: the worker did not settle while its card was pending, so a turn still holds on the question`).toBeGreaterThan(0);
  closing.dispose();
  await awaitWindowQuiet();

  const forB = disposeLater(registerScript({ parent: seatStepsForB("ope2269-card") }));
  const bAsk = bAskFor(22694);
  await mention({ userId: MEMBER_B, text: `ope2269 ${bAsk}`, micros: 22694 });

  const bAnswer = await awaitAnsweredWake(cursor, { principalId: MEMBER_B, chars: B_REPLY.length, label });
  const aAnswer = await awaitAnsweredWake(cursor, { principalId: MEMBER_A, chars: A_PENDING.length, label: `${label} (A's own hand-off)` });

  expect(
    forA.requests.filter((r) => r.role === "child").map((r) => r.stepIndex),
    `${label}: the worker resumed, so the card was answered and this arm measured the wrong thing`,
  ).toEqual([0, 1]);
  expect((await rowsSinceCursor(cursor, ["work.forwarded"], { limit: 50 })).length, `${label}: a second job was forwarded — B's mention was taken as the card's answer`).toBe(1);
  expect(await rowsSinceCursor(cursor, ["input_response.routed"], { limit: 50 }), `${label}: a room message was routed as an answer`).toEqual([]);

  expect(bAnswer.reply.principalId, `${label}: B's reply row names someone else as the asker`).toBe(MEMBER_B);
  assertSnappy(bAnswer, aAnswer, label);

  const bTurn = forB.requests.find((r) => r.role === "parent" && r.stepIndex === 0);
  expect(bTurn, `${label}: the seat never reached the step scripted for B's turn`).toBeDefined();
  expect(promptOf(bTurn!), `${label}: B's served prompt does not carry B's own message`).toContain(bAsk);

  assertNoFault(forB, label);
}, 600_000);
