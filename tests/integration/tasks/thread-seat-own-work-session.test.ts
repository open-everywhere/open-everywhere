import { afterAll, expect, test } from "vitest";

import { NO_REPLY_SENTINEL } from "@open-everywhere/core/agent/channels/normalized-wake.js";
import { parseWindowToken } from "@open-everywhere/core/agent/channels/window-key.js";

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
  waitFor,
  WAKE_FROM_ENVELOPE,
  workTaskIdOfCall,
  type AuditRow,
  type RecordedRequest,
  type ScriptedHandle,
} from "../harness";

const SLACK_CHANNEL = "C0EXCHAN003";
const BOT_USER_ID = "U0OPE2350BOT";
const MEMBER = "U0OPE2350MEM";
const CHILD_HOLD_MS = 120_000;
const TURN_END_CEILING_MS = 60_000;

const BRIEF = "ope2350 thread job: count the thread's widgets";
const PENDING = "ope2350: started the thread's job.";
const RESULT = "ope2350 thread job result";

const cleanups: (() => void)[] = [];
afterAll(() => {
  for (const c of cleanups.splice(0).reverse()) c();
});

let tsCounter = 2350;

function armSlack(): void {
  const slack = installSlackWebApiStub((method, params) => {
    if (method === "auth.test") return { ok: true, user_id: BOT_USER_ID, bot_id: "B0OPE2350BOT", team_id: SLACK_TEAM_ID };
    if (method === "users.info") {
      const id = params.get("user") ?? "";
      const name = id === BOT_USER_ID ? "ottobot" : `ope2350-${id.slice(-3).toLowerCase()}`;
      return { ok: true, user: { id, team_id: SLACK_TEAM_ID, name, real_name: name, is_restricted: false, profile: { display_name: name, real_name: name } } };
    }
    if (method === "conversations.members") return { ok: true, members: [MEMBER], response_metadata: { next_cursor: "" } };
    if (method === "conversations.info") {
      return {
        ok: true,
        channel: { id: params.get("channel"), name: "it-ope2350", is_channel: true, is_private: false, is_ext_shared: false, is_org_shared: false, is_shared: false, is_pending_ext_shared: false, num_members: 9 },
      };
    }
    if (method === "conversations.history" || method === "conversations.replies") return { ok: true, messages: [] };
    if (method === "chat.postMessage") return { ok: true, channel: params.get("channel"), ts: slackTs(Date.now(), (tsCounter += 1)) };
    if (method === "reactions.add" || method === "reactions.remove") return { ok: true };
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

function assertNoFault(handle: ScriptedHandle, label: string): void {
  expect(
    handle.requests.filter((r) => r.fault !== undefined).map((r) => `${r.role}#${r.stepIndex}: ${String(r.fault)}`),
    `${label}: a scripted request degraded instead of answering the script`,
  ).toEqual([]);
}

test("🔴 a spawned thread seat forwards its job to its OWN work session, and its turn never waits on the job", async () => {
  armSlack();
  await bootAgent();

  const opener = registerScript({ parent: [{ calls: [{ tool: "no_reply", input: { reason: "nothing_to_add" }, id: "ope2350-opener-silence" }] }, { say: NO_REPLY_SENTINEL }] });
  const openTs = slackTs(Date.now(), (tsCounter += 1));
  const opened = await slackMentionWake({ channelId: SLACK_CHANNEL, userId: MEMBER, text: `<@${BOT_USER_ID}> ope2350 opener`, ts: openTs, eventId: `EvOpen2350${openTs.replace(".", "")}` });
  expect(opened.status, `the Slack front refused the opener mention: ${opened.body.slice(0, 200)}`).toBe(200);
  const standingSessionId = (await waitFor(() => opener.requests[0], "the opener mention to reach the standing window seat")).sessionId as string;
  await waitFor(() => opener.requests.find((r) => r.stepIndex === 0), "the opener's own served step");
  await awaitWindowQuiet();
  opener.dispose();

  const cursor = await auditCursor();
  const rootTs = slackTs(Date.now(), (tsCounter += 1));

  const standing = disposeLater(
    registerScript(
      {
        parent: [
          { calls: [{ tool: "spawn_thread_session", input: { brief: "ope2350: own this thread and count its widgets" }, id: "ope2350-spawn" }] },
          { say: NO_REPLY_SENTINEL },
          { say: NO_REPLY_SENTINEL },
          { say: NO_REPLY_SENTINEL },
        ],
      },
      standingSessionId,
    ),
  );
  const thread = disposeLater(
    registerScript({
      parent: [
        { calls: [{ tool: "work", input: { message: BRIEF }, id: "ope2350-work" }] },
        { calls: [{ tool: "reply", input: { wake: WAKE_FROM_ENVELOPE, text: PENDING, done: false }, id: "ope2350-reply" }] },
        { say: NO_REPLY_SENTINEL },
      ],
      child: [{ delayMs: CHILD_HOLD_MS, say: RESULT }],
    }),
  );
  afterThisTest(() => thread.releaseHolds());

  const askTs = slackTs(Date.now(), (tsCounter += 1));
  const asked = await slackMentionWake({ channelId: SLACK_CHANNEL, userId: MEMBER, text: `<@${BOT_USER_ID}> ope2350 please own this thread`, ts: askTs, threadTs: rootTs, eventId: `EvAsk2350${askTs.replace(".", "")}` });
  expect(asked.status).toBe(200);
  const spawned = await waitFor(() => standing.requests.flatMap((r) => r.toolResults).find((t) => t.name === "spawn_thread_session"), "the standing seat's spawn_thread_session result");
  expect(spawned.isError, `spawn_thread_session was refused: ${JSON.stringify(spawned.output).slice(0, 300)}`).toBe(false);
  const threadSeatToken = /"seatId"\s*:\s*"([^"]+)"/.exec(JSON.stringify(spawned.output) ?? "")?.[1];
  expect(threadSeatToken, "the spawn returned no thread seat id").toEqual(expect.stringContaining(":win:s/"));

  const seatFirst = await waitFor(() => thread.requests.find((r) => r.role === "parent" && r.stepIndex === 0), "the thread seat's opening turn");
  expect(seatFirst.tools, "🔴 the thread seat holds the forward verb").toContain("work");
  expect(seatFirst.tools, "🔴 the thread seat holds no native `agent`: a child inside its own turn is the hold").not.toContain("agent");
  await waitFor(() => thread.requests.find((r) => r.role === "parent" && r.stepIndex === 1), "the thread seat's turn to serve its last step (it forwarded and ended)", TURN_END_CEILING_MS);
  const child = await waitFor(() => thread.requests.find((r) => r.role === "child" && promptOf(r).includes(BRIEF)), "the job's child's first (held) model call");
  expect(await rowsSinceCursor(cursor, ["delegation.task_settled", "delegation.task_failed"], { limit: 50 }), "the job settled before the seat's turn ended — this run measured no hold").toEqual([]);
  const taskId = await workTaskIdOfCall(cursor, thread, "ope2350-work", "the thread's job");
  assertNoFault(thread, "the thread seat's turn");

  const forwarded = await waitFor(async () => {
    const rows = await rowsSinceCursor(cursor, ["work.forwarded"], { limit: 50 });
    return rows.length > 0 ? rows : undefined;
  }, "the thread seat's work.forwarded row");
  expect(forwarded, "one forward, from the thread seat").toHaveLength(1);
  const workToken = String(detailOf(forwarded[0]).workToken ?? "");
  const threadWindow = parseWindowToken(threadSeatToken!)?.windowId;
  expect(parseWindowToken(workToken)?.windowId, "🔴 the job did not run in the thread seat's own work session").toBe(`w/${threadWindow}`);
  expect(parseWindowToken(workToken)?.windowId.startsWith("w/s/"), "🔴 the thread's job ran in a channel seat's work session").toBe(true);
  expect(detailOf(forwarded[0]).seatSessionId, "the forward did not come from the thread seat's own session").toBe(seatFirst.sessionId);
  expect(seatFirst.sessionId, "the thread seat and the standing seat are one session").not.toBe(standingSessionId);

  const started = (await rowsSinceCursor(cursor, ["delegation.task_started"], { limit: 50 })).find((r) => detailOf(r).task === taskId);
  expect(started, "the job's task_started row").toBeDefined();
  const startedSession = detailOf(started).session;
  expect(startedSession, "the task_started row names no session — the checks below would compare nothing").toEqual(expect.stringMatching(/.+/));
  expect(detailOf(started).request, "🔴 the task started for a request other than this seat's forward").toBe(detailOf(forwarded[0]).requestId);
  expect(startedSession, "🔴 the job's task started in the thread seat's own session — the seat held the job").not.toBe(seatFirst.sessionId);
  expect(startedSession, "🔴 the job's task started in the standing seat's session").not.toBe(standingSessionId);
  expect(child.sessionId, "the child ran in the seat's own session").not.toBe(seatFirst.sessionId);

  standing.dispose();
  const closing = disposeLater(armSettlement(thread, SETTLEMENT_DRAIN_CLOSING_SCRIPT));
  thread.releaseHolds();
  const read = await consumeSettlement({ armed: closing, dispatched: thread, taskId, label: "the thread seat's result wake" });
  await waitFor(() => closing.requests.find((r) => r.role === "parent" && r.stepIndex === 1), "the result turn to close", TURN_END_CEILING_MS);
  expect(promptOf(read), "the result turn did not carry the job's result").toContain(RESULT);
  expect(read.sessionId, "🔴 the result woke a seat other than the thread seat").toBe(seatFirst.sessionId);
  expect(read.turnId, "the result was read in the forwarding turn").not.toBe(seatFirst.turnId);
  const wake = await waitFor(async () => {
    const rows = (await rowsSinceCursor(cursor, ["work.result_wake"], { limit: 50 })).filter((r) => detailOf(r).outcome === "delivered");
    return rows.length > 0 ? rows : undefined;
  }, "the delivered work.result_wake row");
  expect(wake.map((r) => detailOf(r).taskId), "one delivered result wake, for the thread's job").toEqual([taskId]);
  assertNoFault(closing, "the thread seat's result turn");
});
