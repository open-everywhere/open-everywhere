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
const SLACK_BOT = "U0OPE2339BOT";
const MEMBER_A = "U0OPE2339AAA";
const MEMBER_B = "U0OPE2339BBB";
const CHILD_HOLD_MS = 120_000;
const TURN_END_CEILING_MS = 60_000;

const A_BRIEF = "ope2339 parallel job A: count the widgets";
const B_BRIEF = "ope2339 parallel job B: count the gadgets";
const A_PENDING = "ope2339: started job A.";
const B_PENDING = "ope2339: started job B, alongside the other job.";
const A_RESULT = "ope2339 job A result";
const B_RESULT = "ope2339 job B result";

const cleanups: (() => void)[] = [];
afterAll(() => {
  for (const c of cleanups.splice(0).reverse()) c();
});

function armSlack(): void {
  const slack = installSlackWebApiStub((method, params) => {
    if (method === "auth.test") return { ok: true, user_id: SLACK_BOT, bot_id: "B0OPE2339BOT", team_id: SLACK_TEAM_ID };
    if (method === "users.info") {
      const id = params.get("user") ?? "";
      const name = id === SLACK_BOT ? "ottobot" : `ope2339-${id.slice(-3).toLowerCase()}`;
      return { ok: true, user: { id, team_id: SLACK_TEAM_ID, name, real_name: name, profile: { display_name: name, real_name: name } } };
    }
    if (method === "conversations.members") return { ok: true, members: [], response_metadata: { next_cursor: "" } };
    if (method === "conversations.info") {
      return {
        ok: true,
        channel: { id: params.get("channel"), name: "it-ope2339", is_channel: true, is_private: false, is_ext_shared: false, is_org_shared: false, is_shared: false, is_pending_ext_shared: false, num_members: 9 },
      };
    }
    if (method === "conversations.history" || method === "conversations.replies") return { ok: true, messages: [] };
    if (method === "chat.postMessage") return { ok: true, channel: params.get("channel"), ts: slackTs(Date.now(), 23390) };
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
  const res = await slackMentionWake({ channelId: SLACK_CHANNEL, userId, text: `<@${SLACK_BOT}> ${text}`, ts, eventId: `EvOPE2339${micros}${ts.replace(".", "")}` });
  expect(res.status, `the Slack front refused the mention: ${res.body.slice(0, 300)}`).toBe(200);
}

function seatSteps(tag: string, brief: string, pending: string): SeatScript["parent"] {
  return [
    { calls: [{ tool: "work", input: { message: brief }, id: `${tag}-work` }] },
    { calls: [{ tool: "reply", input: { wake: WAKE_FROM_ENVELOPE, text: pending, done: false }, id: `${tag}-reply` }] },
    { say: NO_REPLY_SENTINEL },
  ];
}

function assertNoFault(handle: ScriptedHandle, label: string): void {
  expect(
    handle.requests.filter((r) => r.fault !== undefined).map((r) => `${r.role}#${r.stepIndex}: ${String(r.fault)}`),
    `${label}: a scripted request degraded instead of answering the script`,
  ).toEqual([]);
}

test("two principals' jobs run at once in one work session, each keyed to its own requester and answered under its own request", async () => {
  armSlack();
  await bootAgent();
  const cursor = await auditCursor();

  const forA = disposeLater(registerScript({ parent: seatSteps("ope2339-a", A_BRIEF, A_PENDING), child: [{ delayMs: CHILD_HOLD_MS, say: A_RESULT }] }));
  afterThisTest(() => forA.releaseHolds());
  await mention(MEMBER_A, "ope2339 please count the widgets", 23391);
  await waitFor(() => forA.requests.find((r) => r.role === "parent" && r.stepIndex === 1), "A's seat turn to serve its last step (it forwarded and ended)", TURN_END_CEILING_MS);
  const childA = await waitFor(() => forA.requests.find((r) => r.role === "child" && promptOf(r).includes(A_BRIEF)), "A's child's first (held) model call");
  const taskA = await workTaskIdOfCall(cursor, forA, "ope2339-a-work", "A's job");
  assertNoFault(forA, "A's turn");

  forA.dispose();
  const forB = disposeLater(registerScript({ parent: seatSteps("ope2339-b", B_BRIEF, B_PENDING), child: [{ delayMs: CHILD_HOLD_MS, say: B_RESULT }] }));
  afterThisTest(() => forB.releaseHolds());
  await mention(MEMBER_B, "ope2339 please count the gadgets", 23392);
  await waitFor(() => forB.requests.find((r) => r.role === "parent" && r.stepIndex === 1), "B's seat turn to serve its last step", TURN_END_CEILING_MS);
  const childB = await waitFor(() => forB.requests.find((r) => r.role === "child" && promptOf(r).includes(B_BRIEF)), "B's child's first model call, while A's child is still held", TURN_END_CEILING_MS);
  const taskB = await workTaskIdOfCall(cursor, forB, "ope2339-b-work", "B's job");
  assertNoFault(forB, "B's turn");

  expect(await rowsSinceCursor(cursor, ["delegation.task_settled", "delegation.task_failed"], { limit: 50 }), "a job settled before both were in flight — this run measured no parallelism").toEqual([]);
  expect(childA.sessionId, "A's child recorded no session id").toEqual(expect.any(String));
  expect(childB.sessionId, "the two jobs ran in ONE child session").not.toBe(childA.sessionId);
  expect(taskB, "the two forwards started ONE task").not.toBe(taskA);

  const started = await rowsSinceCursor(cursor, ["delegation.task_started"], { limit: 50 });
  const startedFor = (task: string) => started.find((r) => detailOf(r).task === task);
  expect(startedFor(taskA), "A's task_started row").toBeDefined();
  expect(startedFor(taskB), "B's task_started row").toBeDefined();
  const sessionOf = (row: AuditRow | undefined) => detailOf(row).session ?? detailOf(row).parentSession ?? detailOf(row).sessionId;
  expect(sessionOf(startedFor(taskB)), "the two jobs started in DIFFERENT work sessions — not one conversation's W").toBe(sessionOf(startedFor(taskA)));

  const keyed = await waitFor(async () => {
    const rows = await rowsSinceCursor(cursor, ["work.task_keyed"], { limit: 50 });
    return rows.length >= 2 ? rows : undefined;
  }, "both work.task_keyed rows");
  const keyOf = (task: string) => keyed.find((r) => detailOf(r).taskId === task);
  expect([detailOf(keyOf(taskA)).verdict, keyOf(taskA)?.principalId, detailOf(keyOf(taskA)).requester], "🔴 A's task is not keyed to A").toEqual(["keyed", MEMBER_A, MEMBER_A]);
  expect([detailOf(keyOf(taskB)).verdict, keyOf(taskB)?.principalId, detailOf(keyOf(taskB)).requester], "🔴 B's task is not keyed to B").toEqual(["keyed", MEMBER_B, MEMBER_B]);
  const requestA = detailOf(keyOf(taskA)).requestId;
  const requestB = detailOf(keyOf(taskB)).requestId;
  expect(requestB, "both tasks keyed on ONE request").not.toBe(requestA);
  expect(await rowsSinceCursor(cursor, ["work.needs_reissue"], { limit: 50 }), "a job was refused — each was started on its own step, so none should be").toEqual([]);

  forB.dispose();
  const closingA = disposeLater(armSettlement(forA, SETTLEMENT_DRAIN_CLOSING_SCRIPT));
  forA.releaseHolds();
  const readA = await consumeSettlement({ armed: closingA, dispatched: forA, taskId: taskA, label: "A's result wake" });
  await waitFor(() => closingA.requests.find((r) => r.role === "parent" && r.stepIndex === 1), "A's result turn to close", TURN_END_CEILING_MS);
  closingA.dispose();
  const closingB = disposeLater(armSettlement(forB, SETTLEMENT_DRAIN_CLOSING_SCRIPT));
  forB.releaseHolds();
  const readB = await consumeSettlement({ armed: closingB, dispatched: forB, taskId: taskB, label: "B's result wake" });
  await waitFor(() => closingB.requests.find((r) => r.role === "parent" && r.stepIndex === 1), "B's result turn to close", TURN_END_CEILING_MS);
  expect(promptOf(readA), "A's result turn did not carry A's result").toContain(A_RESULT);
  expect(promptOf(readB), "B's result turn did not carry B's result").toContain(B_RESULT);
  expect(readB.turnId, "both results were read in ONE seat turn").not.toBe(readA.turnId);
  expect(readB.sessionId, "the results woke two different seats").toBe(readA.sessionId);

  const wakes = await waitFor(async () => {
    const rows = (await rowsSinceCursor(cursor, ["work.result_wake"], { limit: 50 })).filter((r) => detailOf(r).outcome === "delivered");
    return rows.length >= 2 ? rows : undefined;
  }, "both delivered work.result_wake rows");
  expect(wakes.map((r) => [detailOf(r).taskId, detailOf(r).requestId]).sort(), "🔴 each result woke the seat under its OWN request id").toEqual(
    [
      [taskA, requestA],
      [taskB, requestB],
    ].sort(),
  );
  assertNoFault(closingA, "A's result turn");
  assertNoFault(closingB, "B's result turn");
});
