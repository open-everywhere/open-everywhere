import { afterAll, expect, test } from "vitest";

import { NO_REPLY_SENTINEL } from "@open-everywhere/core/agent/channels/normalized-wake.js";
import { domainQuestionIdFor } from "@open-everywhere/core/agent/channels/domain-question.js";
import { wakeIdFromPrompt } from "../../../agent/model/scripted-model";

import {
  auditCursor,
  bootAgent,
  disposeLater,
  installSlackWebApiStub,
  registerScript,
  rowsSinceCursor,
  SLACK_TEAM_ID,
  slackDmWake,
  slackMentionWake,
  slackTs,
  waitFor,
  WAKE_FROM_ENVELOPE,
  type AuditRow,
  type RecordedRequest,
} from "../harness";

const DOMAIN = "e2e-unified";
const DOMAIN_CHANNEL = "C0EXCHAN003";
const BOT = "U0IT2452BOT";
const MEMBER = "U0IT2452MEMBER";
const OUTSIDER = "U0IT2452OUTSIDE";

const MEMBER_DM = "D0IT2452MEMBER";
const OUTSIDER_DM = "D0IT2452OUTSIDE";

const QUESTION = "it2452 what is the latest on the launch?";
const ANSWER = "it2452 the launch moved to Friday; the checklist is green.";
const RELAY = "it2452 relayed: the launch moved to Friday.";
const ASK_ID = "it2452-ask";
const OUTSIDER_ASK_ID = "it2452-ask-outsider";
const ANSWER_ID = "it2452-answer";

const cleanups: (() => void)[] = [];
afterAll(() => {
  for (const c of cleanups.splice(0).reverse()) c();
});
let tsCounter = 0;

function armSlack(): void {
  const slack = installSlackWebApiStub((method, params) => {
    switch (method) {
      case "auth.test":
        return { ok: true, user_id: BOT, bot_id: "B0IT2452BOT", team_id: SLACK_TEAM_ID };
      case "users.info": {
        const id = params.get("user") ?? "";
        return {
          ok: true,
          user: { id, name: `it2452-${id.slice(-6).toLowerCase()}`, team_id: SLACK_TEAM_ID, is_bot: id === BOT, is_restricted: false, is_ultra_restricted: false, is_stranger: false, profile: { display_name: id, real_name: id } },
        };
      }
      case "users.conversations":
        return { ok: true, channels: params.get("user") === MEMBER ? [{ id: DOMAIN_CHANNEL }] : [], response_metadata: { next_cursor: "" } };
      case "conversations.members":
        return { ok: true, members: [], response_metadata: { next_cursor: "" } };
      case "conversations.info": {
        const id = params.get("channel") ?? "";
        return id.startsWith("D")
          ? { ok: true, channel: { id, name: "it2452-dm", is_im: true, is_channel: false, is_private: true, num_members: 2 } }
          : { ok: true, channel: { id, name: "it2452-launch", is_channel: true, is_private: false, is_ext_shared: false, is_org_shared: false, is_shared: false, is_pending_ext_shared: false, num_members: 9 } };
      }
      case "conversations.open":
        return { ok: true, channel: { id: MEMBER_DM } };
      case "conversations.history":
      case "conversations.replies":
        return { ok: true, messages: [] };
      case "chat.postMessage":
        return { ok: true, channel: params.get("channel"), ts: slackTs(Date.now(), (tsCounter += 1)) };
      case "chat.update":
      case "chat.postEphemeral":
        return { ok: true };
      default:
        return undefined;
    }
  });
  cleanups.push(() => slack.uninstall());
}

const promptOf = (r: RecordedRequest): string => r.messages.map((m) => m.text).join("\n");
const resultOf = (requests: readonly RecordedRequest[], id: string) => requests.flatMap((r) => r.toolResults).find((t) => t.id === id);
const byQuestion = (id: string) => (r: AuditRow): boolean => r.detail?.questionId === id;

test("a member's DM asks their domain, the domain's own seat answers, and the answer comes back to the DM; an outsider is refused", async () => {
  armSlack();
  await bootAgent({ sharedSqlite: true });
  const cursor = await auditCursor();

  const warm = disposeLater(registerScript({ parent: [{ say: NO_REPLY_SENTINEL }] }));
  const ts0 = slackTs(Date.now(), (tsCounter += 1));
  const m = await slackMentionWake({ channelId: DOMAIN_CHANNEL, userId: MEMBER, text: `<@${BOT}> it2452 hello`, ts: ts0, eventId: `EvIT2452W${ts0.replace(".", "")}` });
  expect(m.status, `the channel mention was refused: ${m.body.slice(0, 200)}`).toBe(200);
  const warmStep = await waitFor(() => warm.requests.find((r) => r.role === "parent" && typeof r.sessionId === "string"), "it2452: the domain seat's first turn");
  const domainSession = warmStep.sessionId!;
  expect(warmStep.tools, "answer_domain_question is not on the domain's standing seat").toContain("answer_domain_question");
  expect(warmStep.tools, "🔴 ask_domain is on a CHANNEL seat — it is a DM-seat verb").not.toContain("ask_domain");
  warm.dispose();

  const answerInput = { question: "it2452-filled-after-the-ask", answer: ANSWER };
  const domainLeg = disposeLater(
    registerScript(
      {
        parent: [
          { delayMs: 120_000, calls: [{ tool: "answer_domain_question", input: answerInput, id: ANSWER_ID }] },
          { say: NO_REPLY_SENTINEL },
        ],
      },
      domainSession,
    ),
  );

  const dmLeg = disposeLater(
    registerScript({
      parent: [{ calls: [{ tool: "ask_domain", input: { domain: DOMAIN, question: QUESTION }, id: ASK_ID }] }, { say: NO_REPLY_SENTINEL }],
    }),
  );
  const ts1 = slackTs(Date.now(), (tsCounter += 1));
  const d = await slackDmWake({ channelId: MEMBER_DM, userId: MEMBER, text: "it2452 what's the latest on the launch?", ts: ts1, eventId: `EvIT2452A${ts1.replace(".", "")}` });
  expect(d.status, `the DM wake was refused: ${d.body.slice(0, 200)}`).toBe(200);
  const askStep = await waitFor(() => dmLeg.requests.find((r) => r.role === "parent" && r.stepIndex === 0), "it2452: the DM seat's ask step");
  expect(askStep.tools, "ask_domain is not on the member's DM seat").toContain("ask_domain");
  await waitFor(() => dmLeg.requests.find((r) => r.role === "parent" && r.stepIndex === 1), "it2452: the DM seat's turn to end after the ask");
  const asked = resultOf(dmLeg.requests, ASK_ID);
  expect(asked?.isError, `the ask errored: ${JSON.stringify(asked?.output).slice(0, 400)}`).toBe(false);
  const askOut = asked!.output as { status?: string; questionId?: string; delivered?: boolean };
  expect(askOut.status).toBe("asked");
  const QUESTION_ID = domainQuestionIdFor(wakeIdFromPrompt(askStep.messages) ?? "", DOMAIN, QUESTION);
  expect(askOut.questionId, "the question id is not the one the asking wake derives").toBe(QUESTION_ID);
  answerInput.question = QUESTION_ID;
  expect(askOut.delivered, "the domain seat was not woken").toBe(true);
  const dmSession = askStep.sessionId!;
  const relayLeg = disposeLater(
    registerScript(
      {
        parent: [
          { calls: [{ tool: "reply", input: { wake: WAKE_FROM_ENVELOPE, text: RELAY }, id: "it2452-relay" }] },
          { say: NO_REPLY_SENTINEL },
          { say: NO_REPLY_SENTINEL },
          { say: NO_REPLY_SENTINEL },
        ],
      },
      dmSession,
    ),
  );
  domainLeg.releaseHolds();

  const answerStep = await waitFor(() => domainLeg.requests.find((r) => r.role === "parent" && r.stepIndex === 0), "it2452: the domain seat's answer step");
  expect(answerStep.sessionId, "the question woke a different session than the domain's standing seat").toBe(domainSession);
  const delivered = promptOf(answerStep);
  expect(delivered, "the domain seat did not receive the question").toContain(`> ${QUESTION}`);
  expect(delivered, "the delivery does not name the asker").toContain(MEMBER);
  expect(delivered, "the delivery does not name the room the asker belongs through").toContain(`slack/${SLACK_TEAM_ID}/${DOMAIN_CHANNEL}`);
  await waitFor(() => domainLeg.requests.find((r) => r.role === "parent" && r.stepIndex === 1), "it2452: the domain seat's turn to end after the answer");
  const answered = resultOf(domainLeg.requests, ANSWER_ID);
  expect(answered?.isError, `the answer errored: ${JSON.stringify(answered?.output).slice(0, 400)}`).toBe(false);
  expect((answered!.output as { route?: string }).route, "the answer did not reach the member's DM seat").toBe("dm-seat");

  const relayStep = await waitFor(() => relayLeg.requests.find((r) => r.role === "parent" && r.stepIndex === 0), "it2452: the DM seat's relay step");
  expect(relayStep.sessionId, "the answer woke a different session than the member's DM seat").toBe(dmSession);
  expect(promptOf(relayStep), "the DM seat did not receive the domain's answer").toContain(`> ${ANSWER}`);
  const relayPost = await waitFor(
    async () => (await rowsSinceCursor(cursor, ["reply.post"], { limit: 100 })).find((r) => r.detail?.sessionId === dmSession && r.detail?.chars === RELAY.length),
    "it2452: the relay's reply.post row in the member's DM",
  );
  expect(relayPost.surface, "the relay was posted somewhere other than the member's DM").toBe(MEMBER_DM);
  const domainPosts = (await rowsSinceCursor(cursor, ["reply.post"], { limit: 100 })).filter((r) => r.detail?.sessionId === domainSession);
  expect(domainPosts.map((r) => r.surface), "🔴 the domain seat posted while handling a DM question").toEqual([]);

  const askedRow = await waitFor(async () => (await rowsSinceCursor(cursor, ["domain_question.asked"], { limit: 20 })).find(byQuestion(QUESTION_ID)), "it2452: domain_question.asked");
  expect([askedRow.detail?.domain, askedRow.detail?.delivered, askedRow.principalId]).toEqual([DOMAIN, true, MEMBER]);
  const receivedRow = await waitFor(async () => (await rowsSinceCursor(cursor, ["domain_question.received"], { limit: 20 })).find(byQuestion(QUESTION_ID)), "it2452: domain_question.received");
  expect(receivedRow.workspace, "the domain-side row is not filed under the domain").toBe(DOMAIN);
  const answeredRow = await waitFor(async () => (await rowsSinceCursor(cursor, ["domain_question.answered"], { limit: 20 })).find(byQuestion(QUESTION_ID)), "it2452: domain_question.answered");
  expect([answeredRow.detail?.route, answeredRow.detail?.asker]).toEqual(["dm-seat", MEMBER]);
  const deliveredRow = await waitFor(async () => (await rowsSinceCursor(cursor, ["domain_question.answer_delivered"], { limit: 20 })).find(byQuestion(QUESTION_ID)), "it2452: domain_question.answer_delivered");
  expect([deliveredRow.principalId, deliveredRow.surface], "the DM-side answer row is not filed under the asker's DM").toEqual([MEMBER, MEMBER_DM]);
  for (const row of [askedRow, receivedRow, answeredRow, deliveredRow]) {
    expect(JSON.stringify(row.detail), `🔴 ${row.action} carries the question or the answer text`).not.toMatch(/latest on the launch|moved to Friday/);
  }
  expect(dmLeg.requests.filter((r) => r.fault !== undefined), "a scripted DM request degraded").toEqual([]);
  expect(relayLeg.requests.filter((r) => r.fault !== undefined), "a scripted relay request degraded").toEqual([]);
  expect(domainLeg.requests.filter((r) => r.fault !== undefined), "a scripted domain request degraded").toEqual([]);
  dmLeg.dispose();
  relayLeg.dispose();
  domainLeg.dispose();

  const refusedCursor = await auditCursor();
  const quietDomain = disposeLater(registerScript({ parent: [{ say: NO_REPLY_SENTINEL }] }, domainSession));
  const outsiderLeg = disposeLater(
    registerScript({
      parent: [{ calls: [{ tool: "ask_domain", input: { domain: DOMAIN, question: QUESTION }, id: OUTSIDER_ASK_ID }] }, { say: NO_REPLY_SENTINEL }],
    }),
  );
  const ts2 = slackTs(Date.now(), (tsCounter += 1));
  const o = await slackDmWake({ channelId: OUTSIDER_DM, userId: OUTSIDER, text: "it2452 what's the latest on the launch?", ts: ts2, eventId: `EvIT2452O${ts2.replace(".", "")}` });
  expect(o.status, `the outsider's DM wake was refused: ${o.body.slice(0, 200)}`).toBe(200);
  await waitFor(() => outsiderLeg.requests.find((r) => r.role === "parent" && r.stepIndex === 1), "it2452: the outsider's DM seat to end after the refusal");
  const refused = resultOf(outsiderLeg.requests, OUTSIDER_ASK_ID);
  expect(refused, "the outsider's ask returned no result").toBeDefined();
  expect(JSON.stringify(refused!.output), "🔴 the tool did not refuse a person outside the domain").toContain("not in any internal channel");
  const refusedRow = await waitFor(async () => (await rowsSinceCursor(refusedCursor, ["domain_question.refused"], { limit: 20 }))[0], "it2452: domain_question.refused");
  expect([refusedRow.detail?.reason, refusedRow.detail?.domain, refusedRow.principalId]).toEqual(["not-a-member", DOMAIN, OUTSIDER]);
  expect(await rowsSinceCursor(refusedCursor, ["domain_question.asked", "domain_question.received"], { limit: 20 }), "🔴 a refused ask still recorded a question").toEqual([]);
  expect(quietDomain.requests, "🔴 a refused ask still woke the domain's seat").toEqual([]);
  expect(outsiderLeg.requests.filter((r) => r.fault !== undefined), "a scripted outsider request degraded").toEqual([]);
}, 600_000);
