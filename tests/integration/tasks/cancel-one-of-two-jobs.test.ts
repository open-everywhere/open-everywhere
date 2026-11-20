import { afterAll, expect, test } from "vitest";

import { NO_REPLY_SENTINEL } from "@open-everywhere/core/agent/channels/normalized-wake.js";
import {
  afterThisTest,
  armSettlement,
  auditCursor,
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
  waitFor,
  WAKE_FROM_ENVELOPE,
  workTaskIdOfCall,
  type AuditRow,
  type RecordedRequest,
  type ScriptedHandle,
  type SeatScript,
} from "../harness";

const SLACK_CHANNEL = "C0EXCHAN003";
const SLACK_BOT = "U0OPE2343BOT";
const MEMBER_A = "U0OPE2343AAA";
const MEMBER_B = "U0OPE2343BBB";
const CHILD_HOLD_MS = 120_000;
const STOP_HOLD_MS = 120_000;
const TURN_END_CEILING_MS = 60_000;

const A_BRIEF = "ope2343 job A: count the widgets";
const B_BRIEF = "ope2343 job B: count the gadgets";
const A_PENDING = "ope2343: started job A.";
const B_PENDING = "ope2343: started job B.";
const STOP_ACK = "ope2343: stopping job A.";
const A_RESULT = "ope2343 job A result, which a cancelled job never reports";
const B_RESULT = "ope2343 job B result";

const cleanups: (() => void)[] = [];
afterAll(() => {
  for (const c of cleanups.splice(0).reverse()) c();
});

function armSlack(): void {
  const slack = installSlackWebApiStub((method, params) => {
    if (method === "auth.test") return { ok: true, user_id: SLACK_BOT, bot_id: "B0OPE2343BOT", team_id: SLACK_TEAM_ID };
    if (method === "users.info") {
      const id = params.get("user") ?? "";
      const name = id === SLACK_BOT ? "ottobot" : `ope2343-${id.slice(-3).toLowerCase()}`;
      return { ok: true, user: { id, team_id: SLACK_TEAM_ID, name, real_name: name, profile: { display_name: name, real_name: name } } };
    }
    if (method === "conversations.members") return { ok: true, members: [], response_metadata: { next_cursor: "" } };
    if (method === "conversations.info") {
      return {
        ok: true,
        channel: { id: params.get("channel"), name: "it-ope2343", is_channel: true, is_private: false, is_ext_shared: false, is_org_shared: false, is_shared: false, is_pending_ext_shared: false, num_members: 9 },
      };
    }
    if (method === "conversations.history" || method === "conversations.replies") return { ok: true, messages: [] };
    if (method === "chat.postMessage") return { ok: true, channel: params.get("channel"), ts: slackTs(Date.now(), 23430) };
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

async function mention(userId: string, text: string, micros: number): Promise<void> {
  const ts = slackTs(Date.now(), micros);
  const res = await slackMentionWake({ channelId: SLACK_CHANNEL, userId, text: `<@${SLACK_BOT}> ${text}`, ts, eventId: `EvOPE2343${micros}${ts.replace(".", "")}` });
  expect(res.status, `the Slack front refused the mention: ${res.body.slice(0, 300)}`).toBe(200);
}

function seatSteps(tag: string, brief: string, pending: string): SeatScript["parent"] {
  return [
    { calls: [{ tool: "work", input: { message: brief }, id: `${tag}-work` }] },
    { calls: [{ tool: "reply", input: { wake: WAKE_FROM_ENVELOPE, text: pending, done: false }, id: `${tag}-reply` }] },
    { say: NO_REPLY_SENTINEL },
  ];
}

function requestIdOfWork(handle: ScriptedHandle, callId: string): string | undefined {
  const result = handle.requests.flatMap((r) => r.toolResults).find((t) => t.name === "work" && t.id === callId);
  if (result === undefined) return undefined;
  const raw = result.output;
  return /"requestId"\s*:\s*"([^"]+)"/.exec(typeof raw === "string" ? raw : (JSON.stringify(raw) ?? ""))?.[1];
}

function assertNoFault(handle: ScriptedHandle, label: string): void {
  expect(
    handle.requests.filter((r) => r.fault !== undefined).map((r) => `${r.role}#${r.stepIndex}: ${String(r.fault)}`),
    `${label}: a scripted request degraded instead of answering the script`,
  ).toEqual([]);
}

async function statusRows(cursor: Awaited<ReturnType<typeof auditCursor>>): Promise<AuditRow[]> {
  return await rowsSinceCursor(cursor, ["work.status"], { limit: 100 });
}

test("stop on one request id cancels that job's task only, and the other job settles with its result", async () => {
  armSlack();
  await bootAgent();
  const cursor = await auditCursor();

  const forA = disposeLater(
    registerScript({
      parent: seatSteps("ope2343-a", A_BRIEF, A_PENDING),
      child: [{ delayMs: CHILD_HOLD_MS, holdUntilCancelled: true, say: A_RESULT }],
    }),
  );
  afterThisTest(() => forA.releaseHolds());
  await mention(MEMBER_A, "ope2343 please count the widgets", 23431);
  await waitFor(() => forA.requests.find((r) => r.role === "parent" && r.stepIndex === 1), "A's seat turn to serve its last step", TURN_END_CEILING_MS);
  await waitFor(() => forA.requests.find((r) => r.role === "child" && promptOf(r).includes(A_BRIEF)), "A's child's first (held) model call");
  const taskA = await workTaskIdOfCall(cursor, forA, "ope2343-a-work", "A's job");
  const requestA = requestIdOfWork(forA, "ope2343-a-work");
  expect(requestA, "A's `work` receipt named no request id").toEqual(expect.any(String));
  assertNoFault(forA, "A's turn");
  forA.releaseHolds();

  forA.dispose();
  const forB = disposeLater(registerScript({ parent: seatSteps("ope2343-b", B_BRIEF, B_PENDING), child: [{ delayMs: CHILD_HOLD_MS, say: B_RESULT }] }));
  afterThisTest(() => forB.releaseHolds());
  await mention(MEMBER_B, "ope2343 please count the gadgets", 23432);
  await waitFor(() => forB.requests.find((r) => r.role === "parent" && r.stepIndex === 1), "B's seat turn to serve its last step", TURN_END_CEILING_MS);
  await waitFor(() => forB.requests.find((r) => r.role === "child" && promptOf(r).includes(B_BRIEF)), "B's child's first (held) model call, while A's child is still held", TURN_END_CEILING_MS);
  const taskB = await workTaskIdOfCall(cursor, forB, "ope2343-b-work", "B's job");
  expect(taskB, "the two forwards started ONE task").not.toBe(taskA);
  assertNoFault(forB, "B's turn");

  const working = await waitFor(async () => {
    const rows = (await statusRows(cursor)).filter((r) => detailOf(r).state === "working");
    return rows.length >= 2 ? rows : undefined;
  }, "both jobs' `working` status rows");
  expect(working.map((r) => [detailOf(r).requestId === requestA, detailOf(r).taskId]).sort(), "each job's status names its own task").toEqual(
    [
      [false, taskB],
      [true, taskA],
    ].sort(),
  );

  forB.dispose();
  const stopCallId = "ope2343-a-stop";
  const stopA = disposeLater(
    registerScript({
      parent: [
        { calls: [{ tool: "cancel_work", input: { requestId: requestA }, id: stopCallId }] },
        { delayMs: STOP_HOLD_MS, calls: [{ tool: "reply", input: { wake: WAKE_FROM_ENVELOPE, text: STOP_ACK, done: false }, id: "ope2343-a-stop-reply" }] },
        { say: NO_REPLY_SENTINEL },
      ],
    }),
  );
  afterThisTest(() => stopA.releaseHolds());
  await mention(MEMBER_A, "ope2343 stop my widget job", 23433);

  const stopStep = await waitFor(() => stopA.requests.find((r) => r.role === "parent" && r.toolResults.some((t) => t.id === stopCallId)), "the stop turn's cancel_work result");
  const stop = stopStep.toolResults.find((t) => t.id === stopCallId)!;
  const stopText = JSON.stringify(stop.output);
  expect(stop.isError, `the stop's cancel_work was refused: ${stopText}`).toBe(false);
  expect(stopText, "🔴 cancel_work did not resolve A's request id to A's task").toContain(taskA);
  expect(stopText).not.toContain(taskB);

  const relayed = await waitFor(async () => {
    const rows = (await rowsSinceCursor(cursor, ["work.cancel_relayed"], { limit: 50 })).filter((r) => detailOf(r).outcome === "relayed");
    return rows.length > 0 ? rows : undefined;
  }, "the work.cancel_relayed row");
  expect(relayed.map((r) => detailOf(r).taskId), "🔴 the stop relayed a cancel for a task other than A's").toEqual([taskA]);
  await waitFor(
    async () => ((await rowsSinceCursor(cursor, ["work.cancel_redeemed"], { limit: 50 })).some((r) => detailOf(r).taskId === taskA && detailOf(r).outcome === "admitted") ? true : undefined),
    "the work session's fenced eve__task_cancel to be ADMITTED for A's task",
  );

  await waitFor(() => (forA.holdsCancelDelivered() === 1 ? true : undefined), "🔴 A's child's model call to see its abort — the cancel stopped the running child");
  const cancelledA = await waitFor(
    async () => (await statusRows(cursor)).find((r) => detailOf(r).taskId === taskA && detailOf(r).state !== "working"),
    "A's settled status row",
  );
  expect(detailOf(cancelledA).state, "🔴 A's job did not settle as a stop").toBe("cancelled");

  const closingA = disposeLater(armSettlement(stopA, SETTLEMENT_DRAIN_CLOSING_SCRIPT));
  stopA.releaseHolds();
  const readA = await consumeSettlement({ armed: closingA, dispatched: stopA, taskId: taskA, label: "A's (cancelled) result wake" });
  expect(promptOf(readA), "🔴 a cancelled job's result carried its child's answer").not.toContain(A_RESULT);
  await waitFor(() => closingA.requests.find((r) => r.role === "parent" && r.stepIndex === 1), "A's result turn to close", TURN_END_CEILING_MS);

  expect(forB.requests.filter((r) => r.role === "child" && r.stepIndex !== 0), "B's child moved past its held call before its release").toEqual([]);
  expect(forB.holdsCutShort(), "B's child's hold ended before its release").toBe(0);
  expect((await statusRows(cursor)).filter((r) => detailOf(r).taskId === taskB).map((r) => detailOf(r).state), "🔴 B's job settled when only A's was stopped").toEqual(["working"]);
  expect((await rowsSinceCursor(cursor, ["work.cancel_redeemed"], { limit: 50 })).filter((r) => detailOf(r).taskId === taskB), "🔴 W ran a stop for B's task").toEqual([]);
  closingA.dispose();

  const closingB = disposeLater(armSettlement(forB, SETTLEMENT_DRAIN_CLOSING_SCRIPT));
  forB.releaseHolds();
  const readB = await consumeSettlement({ armed: closingB, dispatched: forB, taskId: taskB, label: "B's result wake" });
  await waitFor(() => closingB.requests.find((r) => r.role === "parent" && r.stepIndex === 1), "B's result turn to close", TURN_END_CEILING_MS);
  expect(promptOf(readB), "B's result turn did not carry B's result").toContain(B_RESULT);
  expect(forB.holdsCancelDelivered(), "🔴 B's child saw an abort: the stop reached the wrong job").toBe(0);
  const settledB = await waitFor(
    async () => (await statusRows(cursor)).find((r) => detailOf(r).taskId === taskB && detailOf(r).state !== "working"),
    "B's settled status row",
  );
  expect(detailOf(settledB).state, "B's job did not settle as completed").toBe("completed");
  const wakes = await waitFor(async () => {
    const rows = (await rowsSinceCursor(cursor, ["work.result_wake"], { limit: 50 })).filter((r) => detailOf(r).outcome === "delivered" && detailOf(r).taskId === taskB);
    return rows.length > 0 ? rows : undefined;
  }, "B's delivered work.result_wake row");
  expect(detailOf(wakes[0]).requestId, "B's result woke the seat under A's request").not.toBe(requestA);

  for (const [h, label] of [
    [stopA, "the stop turn"],
    [closingA, "A's result turn"],
    [closingB, "B's result turn"],
  ] as const) {
    assertNoFault(h, label);
  }
});
