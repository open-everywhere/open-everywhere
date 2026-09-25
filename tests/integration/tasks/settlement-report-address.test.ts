import { expect, test } from "vitest";

import {
  afterThisTest,
  armSettlement,
  auditCursor,
  bootAgent,
  consumeSettlement,
  disposeLater,
  installNotionApiStub,
  installSlackWebApiStub,
  notionCommentEventPost,
  registerScript,
  rowsSinceCursor,
  seedNotionChannelKey,
  SLACK_TEAM_ID,
  slackMentionWake,
  slackTs,
  taskIdOfDelegation,
  waitFor,
  waitForChildren,
  WAKE_FROM_ENVELOPE,
  WAKE_FROM_REPORT,
  type RecordedRequest,
} from "../harness";

const SLACK_CHANNEL = "C0EXCHAN003";
const SLACK_BOT = "U0OPE2133BOT";
const SLACK_MEMBER = "U0OPE2133MEM";
const NOTION_WORKSPACE = "40000000-0000-4000-8000-000000000001";
const NOTION_PAGE = "40000000-0000-4000-8000-000000000101";
const NOTION_DISCUSSION = "it-ope-2133-discussion";
const NOTION_TRIGGER = "it-ope-2133-trigger";
const NOTION_AUTHOR = "it-ope-2133-author";

const NOTION_MARKER = "remember: the release decision we made is shipit-19350";
const HANDOFF = "on it — checking the PR now";
const CHILD_REPORT = `PR #165 is green and merged.\n\nfor wake ${WAKE_FROM_REPORT}`;
const FINAL_REPLY = "PR #165 is green and merged.";

function promptOf(request: RecordedRequest): string {
  return request.messages.map((message) => message.text).join("\n");
}

function systemText(request: RecordedRequest): string {
  return request.messages.filter((message) => message.role === "system").map((message) => message.text).join("\n\n");
}

test("a settlement report is posted on the dispatching wake while a newer wake stays open", async () => {
  const slackThreadTs = slackTs(Date.now() - 1_000, 21330);
  const slackMessageTs = slackTs(Date.now(), 21331);
  let laterSeat: ReturnType<typeof registerScript> | undefined;

  const slack = installSlackWebApiStub((method, params) => {
    if (method === "auth.test") return { ok: true, user_id: SLACK_BOT, bot_id: "B0OPE2133BOT", team_id: SLACK_TEAM_ID };
    if (method === "users.info") {
      const id = params.get("user") ?? "";
      return {
        ok: true,
        user: {
          id,
          team_id: SLACK_TEAM_ID,
          name: id === SLACK_BOT ? "ottobot" : "ope2133-member",
          real_name: id,
          profile: { display_name: id === SLACK_BOT ? "ottobot" : "ope2133-member", real_name: id },
        },
      };
    }
    if (method === "conversations.info") {
      return {
        ok: true,
        channel: {
          id: params.get("channel"),
          name: "it-ope2133-settlement-address",
          is_channel: true,
          is_private: false,
          is_ext_shared: false,
          is_org_shared: false,
          is_shared: false,
          is_pending_ext_shared: false,
          num_members: 8,
        },
      };
    }
    if (method === "conversations.history" || method === "conversations.replies") return { ok: true, messages: [] };
    if (method === "chat.postMessage") return { ok: true, ts: slackTs(Date.now(), 21332) };
    return undefined;
  });
  afterThisTest(() => slack.uninstall());

  const notion = installNotionApiStub((call) => {
    if (call.method === "GET" && call.path === "/v1/users/me") return { body: { id: "it-ope-2133-bot", name: "ottobot", type: "bot" } };
    if (call.method === "GET" && call.path === "/v1/comments") return { body: { results: [] } };
    if (call.method === "GET" && call.path === `/v1/comments/${NOTION_TRIGGER}`) {
      return {
        body: {
          id: NOTION_TRIGGER,
          discussion_id: NOTION_DISCUSSION,
          parent: { page_id: NOTION_PAGE },
          rich_text: [{ plain_text: NOTION_MARKER }],
          created_by: { id: NOTION_AUTHOR, type: "person" },
          created_time: new Date().toISOString(),
        },
      };
    }
    if (call.method === "POST" && call.path === "/v1/comments") return { body: { id: "unexpected-ope2133-notion-post" } };
    return undefined;
  });
  afterThisTest(() => notion.uninstall());

  await bootAgent({ sharedSqlite: true, selfBaseUrl: true, stubbedProviderTransport: true });
  await seedNotionChannelKey();
  const cursor = await auditCursor();

  const dispatched = disposeLater(
    registerScript({
      parent: [
        { calls: [{ tool: "agent", input: { message: "check whether PR #165 is green and report back" }, id: "ope2133-delegate" }] },
        { calls: [{ tool: "reply", input: { wake: WAKE_FROM_ENVELOPE, text: HANDOFF, done: false }, id: "ope2133-handoff" }] },
        { say: "handed off" },
      ],
      child: [{ delayMs: 120_000, say: CHILD_REPORT }],
    }),
  );

  const slackResult = await slackMentionWake({
    channelId: SLACK_CHANNEL,
    userId: SLACK_MEMBER,
    text: `<@${SLACK_BOT}> is PR #165 green yet?`,
    ts: slackMessageTs,
    threadTs: slackThreadTs,
    eventId: `EvOPE2133Slack${slackMessageTs.replace(".", "")}`,
  });
  expect(slackResult.status, slackResult.body).toBe(200);
  const dispatchTerminal = await waitFor(
    () => dispatched.requests.find((request) => request.role === "parent" && request.stepIndex === 2),
    "the Slack dispatch turn to finish after its hand-off note",
  );
  const seatSessionId = String(dispatchTerminal.sessionId);

  const childStart = await waitFor(
    () => dispatched.requests.find((request) => request.role === "child" && request.stepIndex === 0),
    "the delegated worker to enter its scripted hold",
  );
  expect(childStart.sessionId).not.toBe(seatSessionId);
  expect(dispatched.holdsCutShort()).toBe(0);

  const { NO_REPLY_SENTINEL } = await import("@open-everywhere/core/agent/channels/normalized-wake.js");
  laterSeat = disposeLater(registerScript({ parent: [{ say: NO_REPLY_SENTINEL }] }, seatSessionId));
  const notionResult = await notionCommentEventPost({
    workspaceId: NOTION_WORKSPACE,
    commentId: NOTION_TRIGGER,
    eventId: "ev-it-ope-2133-notion",
  });
  expect(notionResult.status, notionResult.body).toBe(200);

  const notionTurn = await waitFor(
    () => laterSeat?.requests.find((request) => request.role === "parent" && promptOf(request).includes(NOTION_MARKER)),
    "the later Notion turn to run on the same standing parent while the worker is pending",
  );
  expect(notionTurn.sessionId, "Slack and Notion did not share one standing parent session").toBe(seatSessionId);
  expect(promptOf(notionTurn), "the pending worker's report leaked into the intervening Notion turn").not.toContain(FINAL_REPLY);

  const slackKey = `slack/${SLACK_TEAM_ID}/${SLACK_CHANNEL}`;
  const notionKey = `notion/${NOTION_WORKSPACE}/${NOTION_PAGE}`;
  const ingress = await waitFor(async () => {
    const rows = await rowsSinceCursor(cursor, ["wake.ingress"]);
    const slackRow = rows.find((row) => row.detail?.surfaceKey === slackKey);
    const notionRow = rows.find((row) => row.detail?.surfaceKey === notionKey);
    return slackRow !== undefined && notionRow !== undefined ? { slackRow, notionRow } : undefined;
  }, "both wake.ingress rows — the dispatching Slack wake and the later Notion wake");
  const slackWakeId = String(ingress.slackRow.detail?.wakeId);
  const notionWakeId = String(ingress.notionRow.detail?.wakeId);
  expect(slackWakeId).not.toBe("undefined");
  expect(notionWakeId).not.toBe("undefined");
  expect(notionWakeId, "the two wakes must be distinct or this test asserts nothing").not.toBe(slackWakeId);

  const childPrompt = systemText(childStart);
  expect(childPrompt.length, "fixture guard: the worker really read a standing prompt").toBeGreaterThan(1000);
  const addressed = /^for wake ([^\s<>]+)$/m.exec(childPrompt);
  expect(addressed, "the worker persona must render the settlement address on its own line").not.toBeNull();
  const reportWakeId = addressed![1]!;

  const taskId = taskIdOfDelegation(dispatched, "the OPE-2133 delegation");
  laterSeat.dispose();
  const settlement = disposeLater(
    armSettlement(dispatched, {
      parent: [
        { calls: [{ tool: "reply", input: { wake: WAKE_FROM_REPORT, text: FINAL_REPLY, done: true }, id: "ope2133-settlement-reply" }] },
        { say: "reported" },
      ],
    }),
  );

  dispatched.releaseHolds();
  await waitFor(() => (dispatched.holdsCutShort() === 1 ? true : undefined), "the worker hold to release through the control barrier");
  await waitForChildren(dispatched, { count: 1, lastStepIndex: 0, label: "the released worker to return its report" });
  const notification = await consumeSettlement({
    armed: settlement,
    dispatched,
    taskId,
    label: "the released worker's settlement notification",
  });
  expect(notification.sessionId).toBe(seatSessionId);

  const taskWake = await waitFor(async () => {
    const rows = await rowsSinceCursor(cursor, ["unified.task_wake"]);
    return rows.find((row) => row.detail?.task === taskId && typeof row.detail?.wakeId === "string");
  }, "the unified.task_wake row naming the wake this task settles under");
  expect(
    [slackWakeId, String(taskWake.detail?.wakeId)],
    "the worker was handed an address that is neither the dispatching wake nor this task's own wake",
  ).toContain(reportWakeId);
  expect(promptOf(notification), "the settlement notification must carry the report's address line").toMatch(
    new RegExp(`^for wake ${reportWakeId}$`, "m"),
  );

  await waitFor(
    () => slack.calls.some((call) => call.method === "chat.postMessage" && (call.params.get("text") ?? "").includes(FINAL_REPLY)),
    "the settlement report to reach the Slack transport",
  );
  const posts = await waitFor(async () => {
    const rows = await rowsSinceCursor(cursor, ["reply.post"]);
    return rows.length >= 2 ? rows : undefined;
  }, "the hand-off note and the settlement reply to both row a reply.post");
  const refused = await rowsSinceCursor(cursor, ["reply.refused"]);
  expect(refused.map((row) => String(row.detail?.reason)), "a reply in this arc was refused").toEqual([]);
  expect(posts).toHaveLength(2);

  const postWakes = [...new Set(posts.map((row) => String(row.detail?.wakeId)))];
  expect(postWakes, "a post landed on the later wake — this is the live-run defect").not.toContain(notionWakeId);
  expect(postWakes.every((wake) => wake === slackWakeId || wake === reportWakeId)).toBe(true);
  expect(posts.every((row) => row.platform === "slack")).toBe(true);
  expect(postWakes, "the settlement did not post under the address its report named").toContain(reportWakeId);

  const slackPosts = slack.calls.filter((call) => call.method === "chat.postMessage");
  const reportPost = slackPosts.find((call) => (call.params.get("text") ?? "").includes(FINAL_REPLY));
  expect(reportPost, "the settlement report never reached Slack").toBeDefined();
  expect(reportPost!.params.get("channel")).toBe(SLACK_CHANNEL);
  expect(reportPost!.params.get("thread_ts")).toBe(slackThreadTs);
  expect(
    notion.calls.filter((call) => call.method === "POST" && call.path === "/v1/comments"),
    "the settlement report was posted into the later Notion conversation",
  ).toEqual([]);

  expect(dispatched.requests.filter((request) => request.fault !== undefined)).toEqual([]);
  expect(laterSeat.requests.filter((request) => request.fault !== undefined)).toEqual([]);
  expect(settlement.requests.filter((request) => request.fault !== undefined)).toEqual([]);
}, 420_000);
