// proves: AP-MOD-core-access-worker-continuation

import { afterAll, expect, test } from "vitest";

import { NO_REPLY_SENTINEL } from "@open-everywhere/core/agent/channels/normalized-wake.js";
import {
  armSettlement,
  auditCursor,
  awaitWorkResult,
  bootAgent,
  disposeLater,
  installSlackWebApiStub,
  registerScript,
  rowsSinceCursor,
  SETTLEMENT_DRAIN_SCRIPT,
  SLACK_TEAM_ID,
  slackMentionWake,
  slackTs,
  waitFor,
  WAKE_FROM_REPORT,
  workTaskIdOfCall,
  type AuditRow,
  type RecordedRequest,
  type ScriptedHandle,
} from "../harness";

const SLACK_CHANNEL = "C0EXCHAN003";
const SLACK_BOT = "U0OPE2386BOT";
const MEMBER = "U0OPE2386MEM";
const CHILD_HOLD_MS = 120_000;
const SEAT_HOLD_MS = 120_000;
const TURN_END_CEILING_MS = 60_000;

const OPEN_BRIEF = "ope2386 job: count the widgets in the warehouse sheet";
const FOLLOW_BRIEF = "ope2386 follow-up: also count the sprockets";
const OPEN_RESULT = "ope2386 the widget count is 41";
const RELAY = "ope2386: the follow-up did not run, because the first job is still working";
const REFUSED_NOTE = "The work session did not run this follow-up";

const cleanups: (() => void)[] = [];
afterAll(() => {
  for (const c of cleanups.splice(0).reverse()) c();
});

function armSlack(): void {
  const slack = installSlackWebApiStub((method, params) => {
    if (method === "auth.test") return { ok: true, user_id: SLACK_BOT, bot_id: "B0OPE2386BOT", team_id: SLACK_TEAM_ID };
    if (method === "users.info") {
      const id = params.get("user") ?? "";
      const name = id === SLACK_BOT ? "ottobot" : `ope2386-${id.slice(-3).toLowerCase()}`;
      return { ok: true, user: { id, team_id: SLACK_TEAM_ID, name, real_name: name, profile: { display_name: name, real_name: name } } };
    }
    if (method === "conversations.members") return { ok: true, members: [], response_metadata: { next_cursor: "" } };
    if (method === "conversations.info") {
      return {
        ok: true,
        channel: { id: params.get("channel"), name: "it-ope2386", is_channel: true, is_private: false, is_ext_shared: false, is_org_shared: false, is_shared: false, is_pending_ext_shared: false, num_members: 9 },
      };
    }
    if (method === "conversations.history" || method === "conversations.replies") return { ok: true, messages: [] };
    if (method === "chat.postMessage") return { ok: true, channel: params.get("channel"), ts: slackTs(Date.now(), 23860) };
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

function lastUserText(request: RecordedRequest): string {
  const users = request.messages.filter((m) => m.role === "user");
  return users.length === 0 ? "" : users[users.length - 1]!.text;
}

async function mention(text: string, micros: number): Promise<void> {
  const ts = slackTs(Date.now(), micros);
  const res = await slackMentionWake({ channelId: SLACK_CHANNEL, userId: MEMBER, text: `<@${SLACK_BOT}> ${text}`, ts, eventId: `EvOPE2386${micros}${ts.replace(".", "")}` });
  expect(res.status, `the Slack front refused the mention: ${res.body.slice(0, 300)}`).toBe(200);
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

test("a follow-up the work session refuses as task-working settles as ONE failed result, and the seat answers the room that asked", async () => {
  armSlack();
  await bootAgent();
  const cursor = await auditCursor();

  const opening = disposeLater(
    registerScript({
      parent: [{ calls: [{ tool: "work", input: { message: OPEN_BRIEF }, id: "ope2386-open" }] }, { say: NO_REPLY_SENTINEL }],
      child: [{ delayMs: CHILD_HOLD_MS, say: OPEN_RESULT }],
    }),
  );
  cleanups.push(() => opening.releaseHolds());
  await mention("ope2386 please count the widgets", 23861);
  await waitFor(() => opening.requests.find((r) => r.role === "parent" && r.stepIndex === 1), "the opening seat turn to serve its last step", TURN_END_CEILING_MS);
  const childOpen = await waitFor(() => opening.requests.find((r) => r.role === "child" && promptOf(r).includes(OPEN_BRIEF)), "the opening job's child's first (held) model call");
  const taskId = await workTaskIdOfCall(cursor, opening, "ope2386-open", "the opening job");
  const seat = String(opening.requests.find((r) => r.role === "parent")?.sessionId);
  assertNoFault(opening, "the opening turn");
  opening.dispose();

  const followCursor = await auditCursor();
  const follow = disposeLater(
    registerScript({
      parent: [
        { calls: [{ tool: "work", input: { message: FOLLOW_BRIEF, taskId }, id: "ope2386-follow" }] },
        { delayMs: SEAT_HOLD_MS, say: NO_REPLY_SENTINEL },
      ],
    }),
  );
  cleanups.push(() => follow.releaseHolds());
  await mention("ope2386 also count the sprockets on the same sheet", 23862);

  const receipt = await waitFor(() => follow.requests.flatMap((r) => r.toolResults).find((t) => t.id === "ope2386-follow"), "the follow-up's `work` receipt");
  expect(receipt.isError, `the seat refused the follow-up itself: ${JSON.stringify(receipt.output)}`).toBe(false);
  const followRequest = requestIdOfWork(follow, "ope2386-follow");
  expect(followRequest, "the follow-up's `work` receipt named no request id").toEqual(expect.any(String));
  expect(follow.requests.find((r) => r.role === "parent")?.sessionId, "the follow-up woke a different seat").toBe(seat);

  const fenceRow = await waitFor(
    async () => (await rowsSinceCursor(followCursor, ["delegation.continuation_refused"], { limit: 50 })).find((r) => detailOf(r).task === taskId && detailOf(r).session !== seat),
    "the work session's delegation.continuation_refused row for the follow-up",
  );
  expect(detailOf(fenceRow).reason, "W's fence refused the follow-up for another reason than a working task").toBe("task-working");

  const refusedRows = await waitFor(async () => {
    const rows = (await rowsSinceCursor(followCursor, ["work.request_refused"], { limit: 50 })).filter((r) => detailOf(r).requestId === followRequest);
    return rows.length > 0 ? rows : undefined;
  }, "🔴 the work.request_refused row for the follow-up — without OPE-2379 the refusal reaches no one");
  expect(refusedRows.map((r) => [detailOf(r).taskId, detailOf(r).reason, detailOf(r).outcome])).toEqual([[taskId, "task-working", "notified"]]);

  const followStep = follow.requests.find((r) => r.role === "parent")!;
  const askingWake = /wake-id="([^"]+)"/.exec(lastUserText(followStep))?.[1];
  expect(askingWake, "the follow-up turn rendered no wake envelope").toEqual(expect.any(String));
  const openingWake = /wake-id="([^"]+)"/.exec(lastUserText(opening.requests.find((r) => r.role === "parent")!))?.[1];
  expect(openingWake, "the opening turn rendered no wake envelope").toEqual(expect.any(String));
  expect(askingWake, "the two asks share one wake, so the wake check below would prove nothing").not.toBe(openingWake);

  await waitFor(() => follow.requests.find((r) => r.role === "parent" && r.stepIndex === 1), "the follow-up turn's held last step", TURN_END_CEILING_MS);
  const relayTurn = disposeLater(
    armSettlement(follow, {
      parent: [
        { calls: [{ tool: "reply", input: { wake: WAKE_FROM_REPORT, text: RELAY, done: true }, id: "ope2386-relay" }] },
        { say: NO_REPLY_SENTINEL },
      ],
    }),
  );
  follow.releaseHolds();
  const read = await awaitWorkResult({ handle: relayTurn, taskId, label: "the seat's step that read the failed follow-up" });
  expect(read.fault, `the seat's read of the failed follow-up degraded: ${String(read.fault)}`).toBeUndefined();
  expect(read.sessionId).toBe(seat);
  expect(lastUserText(read), "🔴 the result the seat read is not the host's refusal note").toContain(REFUSED_NOTE);
  expect(lastUserText(read), "the refusal note does not name the follow-up's request").toContain(String(followRequest));
  expect(lastUserText(read), "the opening job's own result reached the seat before it settled").not.toContain(OPEN_RESULT);
  const relayPost = await waitFor(
    async () => (await rowsSinceCursor(followCursor, ["reply.post"], { limit: 50 })).find((r) => detailOf(r).sessionId === seat && detailOf(r).chars === RELAY.length),
    "the seat's relay of the failed follow-up to post (its reply.post row)",
  );
  expect(detailOf(relayPost).wakeId, "🔴 the failed follow-up was answered under another wake than the one that asked").toBe(askingWake);
  expect(detailOf(relayPost).platform, "the failed follow-up was answered on another surface").toBe("slack");
  assertNoFault(follow, "the follow-up turn");
  assertNoFault(relayTurn, "the relay turn");
  follow.dispose();

  expect(opening.holdsCutShort(), "the opening child's hold ended before its release").toBe(0);
  expect(opening.requests.filter((r) => r.role === "child" && r.sessionId === childOpen.sessionId && r.stepIndex !== 0), "the opening child moved on before its release").toEqual([]);
  expect(await rowsSinceCursor(followCursor, ["delegation.task_started"], { limit: 50 }), "🔴 the refused follow-up started a task").toEqual([]);

  relayTurn.dispose();
  const closing = disposeLater(armSettlement(relayTurn, SETTLEMENT_DRAIN_SCRIPT));
  opening.releaseHolds();
  const settled = await awaitWorkResult({ handle: closing, taskId, label: "the seat's step that read the opening job's own result" });
  expect(lastUserText(settled), "the opening job's own result did not reach the seat").toContain(OPEN_RESULT);
  assertNoFault(closing, "the opening job's result turn");

  expect(
    (await rowsSinceCursor(followCursor, ["work.request_refused"], { limit: 50 })).filter((r) => detailOf(r).requestId === followRequest),
    "the follow-up was refused (and told) more than once",
  ).toHaveLength(1);
  const refusalTurns = new Set(
    [...relayTurn.requests, ...closing.requests].filter((r) => r.role === "parent" && lastUserText(r).includes(REFUSED_NOTE)).map((r) => r.turnId),
  );
  expect([...refusalTurns], "the seat read the failed follow-up in more than one turn").toHaveLength(1);
  const posts = await rowsSinceCursor(followCursor, ["reply.post"], { limit: 50 });
  expect(posts.filter((r) => detailOf(r).wakeId === askingWake), "the room that asked heard the failed follow-up more than once").toHaveLength(1);
  expect((await rowsSinceCursor(followCursor, ["reply.refused"], { limit: 50 })).map((r) => String(detailOf(r).reason)), "a reply in this arc was refused").toEqual([]);
});
