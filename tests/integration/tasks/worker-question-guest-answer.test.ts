import { afterAll, expect, test } from "vitest";

import { NO_REPLY_SENTINEL } from "@open-everywhere/core/agent/channels/normalized-wake.js";

import {
  auditCursor,
  awaitWindowQuiet,
  awaitWorkResult,
  bootAgent,
  installSlackWebApiStub,
  registerScript,
  rowsSinceCursor,
  SLACK_TEAM_ID,
  slackMentionWake,
  slackMessageEventPost,
  slackTs,
  waitFor,
  workTaskIdOfCall,
  type AuditCursor,
  type ScriptedHandle,
  type SlackWebApiStub,
} from "../harness";

const SLACK_WINDOW_CHANNEL_ID = "C0EXCHAN003";
const BOT_USER_ID = "U0BOTSELF01";
const BOT_ID = "B0BOTSELF01";
const MEMBER_USER_ID = "U0OPE2348MEM";
const GUEST_USER_ID = "U0OPE2348GST";

const cleanups: (() => void)[] = [];
afterAll(async () => {
  for (const c of cleanups.splice(0)) c();
  const settings = await import("@open-everywhere/core/agent/settings/settings.js");
  settings.resetSettingsForTest();
});

let stub: SlackWebApiStub | undefined;
let standingSessionId = "";
let tsCounter = 300;

function userInfo(id: string, name: string, guest: boolean): Record<string, unknown> {
  return {
    ok: true,
    user: { id, name, team_id: SLACK_TEAM_ID, is_bot: false, is_restricted: guest, is_ultra_restricted: false, is_stranger: false, real_name: name, profile: { display_name: name, real_name: name } },
  };
}

async function armSeams(): Promise<void> {
  await bootAgent({ sharedSqlite: true });
  const settings = await import("@open-everywhere/core/agent/settings/settings.js");
  settings.overrideSettingsForTest({ externalPolicy: { authorGrain: "taint", roomGrain: "engage" } });
  if (!stub) {
    const installed = installSlackWebApiStub((method, params) => {
      switch (method) {
        case "auth.test":
          return { ok: true, user_id: BOT_USER_ID, bot_id: BOT_ID, team_id: SLACK_TEAM_ID };
        case "users.info": {
          const user = params.get("user") ?? "";
          if (user === BOT_USER_ID) return userInfo(BOT_USER_ID, "ottobot", false);
          if (user === MEMBER_USER_ID) return userInfo(MEMBER_USER_ID, "ope2348-member", false);
          if (user === GUEST_USER_ID) return userInfo(GUEST_USER_ID, "ope2348-guest", true);
          return undefined;
        }
        case "conversations.members":
          return { ok: true, members: [MEMBER_USER_ID, GUEST_USER_ID], response_metadata: { next_cursor: "" } };
        case "conversations.info":
          return {
            ok: true,
            channel: { id: params.get("channel"), name: "it-ope2348", is_channel: true, is_private: false, is_ext_shared: false, is_org_shared: false, is_shared: false, is_pending_ext_shared: false, num_members: 9 },
          };
        case "conversations.history":
        case "conversations.replies":
          return { ok: true, messages: [] };
        case "chat.postMessage":
          return { ok: true, channel: params.get("channel"), ts: slackTs(Date.now(), (tsCounter += 1)) };
        case "reactions.add":
        case "reactions.remove":
          return { ok: true };
        default:
          return undefined;
      }
    });
    stub = installed;
    cleanups.push(() => installed.uninstall());
  }
  if (standingSessionId.length > 0) return;
  const opener = registerScript({ parent: [{ calls: [{ tool: "no_reply", input: { reason: "nothing_to_add" }, id: "ope2348-opener-silence" }] }, { say: NO_REPLY_SENTINEL }] });
  const ts = slackTs(Date.now(), (tsCounter += 1));
  const res = await slackMentionWake({ channelId: SLACK_WINDOW_CHANNEL_ID, userId: MEMBER_USER_ID, text: `<@${BOT_USER_ID}> ope2348 opener`, ts, eventId: `EvOpen2348${ts.replace(".", "")}` });
  expect(res.status, `the Slack front refused the opener mention: ${res.body.slice(0, 200)}`).toBe(200);
  const first = await waitFor(() => opener.requests[0], "the opener mention to reach the standing window seat");
  standingSessionId = first.sessionId as string;
  await awaitWindowQuiet();
  await waitFor(() => opener.requests.find((r) => r.stepIndex === 0), "the opener's own served step");
  opener.dispose();
}

async function askAndAnswer(tag: string, guest: boolean) {
  await armSeams();
  const cursor: AuditCursor = await auditCursor();
  const answerText = `${tag}: use staging, never the shared bucket`;
  const at = Date.now();
  const rootTs = slackTs(at, (tsCounter += 1));

  const standing = registerScript(
    {
      parent: [
        { calls: [{ tool: "spawn_thread_session", input: { brief: `${tag}: write the report into the bucket` }, id: `${tag}-spawn` }] },
        { say: NO_REPLY_SENTINEL },
        { say: NO_REPLY_SENTINEL },
        { say: NO_REPLY_SENTINEL },
      ],
    },
    standingSessionId,
  );
  const asking = registerScript({
    parent: [{ calls: [{ tool: "work", input: { message: `${tag} write the report into the bucket` }, id: `${tag}-delegate` }] }, { say: NO_REPLY_SENTINEL }],
    child: [
      {
        delayMs: 120_000,
        calls: [{ tool: "ask_room", input: { question: `${tag}: should I use staging instead of the shared bucket?`, options: ["Use staging", "Use the shared bucket"] }, id: `${tag}-ask` }],
      },
      { say: `${tag}: asked the room which bucket to use` },
    ],
  });

  const ts = slackTs(at, (tsCounter += 1));
  const res = await slackMentionWake({ channelId: SLACK_WINDOW_CHANNEL_ID, userId: MEMBER_USER_ID, text: `<@${BOT_USER_ID}> ${tag} please write the report into the bucket`, ts, threadTs: rootTs, eventId: `EvAsk${tag}${ts.replace(".", "")}` });
  expect(res.status).toBe(200);
  const spawned = await waitFor(() => standing.requests.flatMap((r) => r.toolResults).find((t) => t.name === "spawn_thread_session"), `${tag}: the standing seat's spawn_thread_session result`);
  expect(spawned.isError, `${tag}: spawn_thread_session was refused: ${JSON.stringify(spawned.output).slice(0, 300)}`).toBe(false);
  await waitFor(() => asking.requests.find((r) => r.role === "parent" && r.stepIndex === 1), `${tag}: the thread seat's receipt step (it forwarded and ended)`);
  const seatSession = String(asking.requests.find((r) => r.role === "parent")!.sessionId);
  const seatStep = asking.requests.find((r) => r.role === "parent" && r.stepIndex === 0)!;
  expect(seatStep.tools, "the thread seat forwards").toContain("work");
  expect(seatStep.tools, "the thread seat holds no native `agent`").not.toContain("agent");
  const firstResult = registerScript({ parent: [{ say: NO_REPLY_SENTINEL }] }, seatSession);
  const taskId = await workTaskIdOfCall(cursor, asking, `${tag}-delegate`, `${tag}: the thread seat's forward`);
  asking.releaseHolds();

  const childAsk = await waitFor(() => asking.requests.find((r) => r.role === "child" && r.stepIndex === 0), `${tag}: the worker's first model call`);
  expect(childAsk.tools, "a work-session worker holds the card").toContain("ask_room");
  expect(childAsk.tools, "a work-session worker holds no native question").not.toContain("ask_question");
  const childSession = String(childAsk.sessionId);
  await waitFor(async () => {
    const rows = await rowsSinceCursor(cursor, ["work.question_posted"]);
    return rows.length > 0 ? rows : undefined;
  }, `${tag}: the worker's card posted into the thread`);
  await awaitWorkResult({ handle: firstResult, taskId, label: `${tag}: the thread seat step that read the worker's waiting result` });
  await awaitWindowQuiet();
  firstResult.dispose();
  asking.dispose();

  const answering = registerScript({ parent: [{ calls: [{ tool: "work", input: { message: answerText, taskId }, id: `${tag}-answer` }] }, { say: NO_REPLY_SENTINEL }] });
  const continued = registerScript(
    {
      parent: [],
      child: [
        { delayMs: 120_000, calls: [{ tool: "create_routine", input: { prompt: `${tag}: post the bucket report`, trigger: { kind: "scheduled", cron: "0 9 * * 1-5", postPolicy: "every-run" } }, id: `${tag}-routine` }] },
        { say: "NO_REPLY" },
      ],
    },
    childSession,
  );
  const answerTs = slackTs(Date.now(), (tsCounter += 1));
  const answered = await slackMessageEventPost({ channelId: SLACK_WINDOW_CHANNEL_ID, userId: guest ? GUEST_USER_ID : MEMBER_USER_ID, text: answerText, ts: answerTs, threadTs: rootTs, eventId: `EvAns${tag}${answerTs.replace(".", "")}` });
  expect(answered.status).toBe(200);
  await waitFor(() => answering.requests.find((r) => r.role === "parent" && r.stepIndex === 1), `${tag}: the thread seat's answer turn to serve its receipt step`);
  const secondResult = registerScript({ parent: [{ say: NO_REPLY_SENTINEL }] }, seatSession);
  continued.releaseHolds();
  const resumed = await waitFor(() => continued.requests.find((r) => r.role === "child" && r.stepIndex === 0), `${tag}: the worker's continued turn`);
  const forward = await waitFor(async () => {
    const rows = (await rowsSinceCursor(cursor, ["work.forwarded"], { limit: 50 })).filter((r) => r.detail?.seatSessionId === seatSession);
    return rows.length >= 2 ? rows[0] : undefined;
  }, `${tag}: the thread seat's forward of the answer`);
  const finish = async (): Promise<void> => {
    await awaitWorkResult({ handle: secondResult, taskId, label: `${tag}: the thread seat step that read the answered worker's result` });
    await awaitWindowQuiet();
    for (const h of [answering, continued, secondResult, standing]) h.dispose();
  };
  const chainRow = async () =>
    waitFor(async () => {
      const rows = await rowsSinceCursor(cursor, ["approval.chain"], { limit: 100 });
      return rows.find((r) => r.detail?.tool === "create_routine" && JSON.stringify(r.detail).includes(`${tag}-routine`)) ?? rows.find((r) => r.detail?.tool === "create_routine");
    }, `${tag}: the worker's create_routine approval.chain row`);
  const handles = [answering, continued, secondResult];
  return { cursor, taskId, forward, resumed, childSession, answerText, handles, finish, chainRow };
}

async function forwardNonMemberWake(requestId: unknown): Promise<boolean | undefined> {
  expect(requestId, "the answer's forward row names no request id").toEqual(expect.any(String));
  const provider = await import("@open-everywhere/core/agent/operational/provider.js");
  const binding = await import("@open-everywhere/core/agent/identity/binding.js");
  const work = await import("@open-everywhere/core/agent/channels/work.js");
  const row = await work.readWorkRequest(provider.getOperationalStore(), binding.deploymentOrg(), requestId as string);
  expect(row, "the answer's forward wrote no readable work request row").toBeDefined();
  return row!.nonMemberWake;
}

test("🔴 a guest's answer reaches the asking worker with the guest's nonmember stamp", async () => {
  const { cursor, forward, resumed, childSession, answerText, handles, finish, chainRow } = await askAndAnswer("ope2348g", true);

  expect(await rowsSinceCursor(cursor, ["input_response.routed"]), "🔴 the host routed the guest's plain message as an answer").toEqual([]);
  expect(resumed.sessionId, "🔴 a FRESH worker read the answer — the continuation did not reach the worker that asked").toBe(childSession);
  expect(resumed.messages.some((m) => m.text.includes(answerText)), "the continued worker was not told what the guest answered").toBe(true);
  expect(forward.detail?.requestId, "the answer's forward row").toEqual(expect.any(String));
  expect(await forwardNonMemberWake(forward.detail?.requestId), "🔴 the guest's answer was forwarded WITHOUT the non-member stamp").toBe(true);

  const chain = await chainRow();
  expect(chain.detail).not.toHaveProperty("tainted");
  expect(await rowsSinceCursor(cursor, ["taint.forward", "taint.verdict", "taint.mode"], { limit: 200 }), "a taint.* row landed after OPE-2721").toEqual([]);
  for (const h of handles) expect(h.requests.filter((r) => r.fault !== undefined)).toEqual([]);
  await finish();
});

test("NEGATIVE CONTROL — a member's answer carries no nonmember stamp", async () => {
  const { cursor, forward, resumed, childSession, answerText, handles, finish, chainRow } = await askAndAnswer("ope2348m", false);
  expect(await rowsSinceCursor(cursor, ["input_response.routed"])).toEqual([]);
  expect(await forwardNonMemberWake(forward.detail?.requestId), "a member's answer was forwarded as a non-member's").toBe(false);
  expect(resumed.sessionId).toBe(childSession);
  expect(resumed.messages.some((m) => m.text.includes(answerText))).toBe(true);
  const chain = await chainRow();
  expect(chain.detail).not.toHaveProperty("tainted");
  await finish();
  expect(await rowsSinceCursor(cursor, ["taint.forward", "taint.verdict", "taint.mode"], { limit: 200 }), "a taint.* row landed after OPE-2721").toEqual([]);
  for (const h of handles) expect(h.requests.filter((r) => r.fault !== undefined)).toEqual([]);
});
