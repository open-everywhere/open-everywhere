import { expect, test } from "vitest";

import {
  afterThisTest,
  auditCursor,
  awaitWorkResult,
  bootAgent,
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
  waitFor,
  waitForChildren,
  workTaskIdOfCall,
  WAKE_FROM_ENVELOPE,
  type RecordedRequest,
} from "../harness";

const SLACK_CHANNEL = "C0EXRANDM";
const SLACK_BOT = "U0OPE1918BOT";
const SLACK_MEMBER = "U0OPE1918MEM";
const NOTION_WORKSPACE = "40000000-0000-4000-8000-000000000001";
const NOTION_PAGE = "40000000-0000-4000-8000-000000000101";
const NOTION_DISCUSSION = "it-ope-1918-discussion";
const NOTION_TRIGGER = "it-ope-1918-trigger";
const NOTION_AUTHOR = "it-ope-1918-author";
const DISPATCH_CALL = "ope1918-delegate";
const PENDING_REPLY = "I started the Slack worker and will post its result here.";
const CHILD_RESULT = "the delayed Slack worker finished successfully";
const FINAL_REPLY = "The delayed Slack worker finished; this is its final result.";
const NOTION_MARKER = "ope1918 later notion message";

function promptOf(request: RecordedRequest): string {
  return request.messages.map((message) => message.text).join("\n");
}

test("a delayed Slack delegation settles back into its original Slack thread after a later Notion delivery reaches the same parent", async () => {
  const slackThreadTs = slackTs(Date.now() - 1_000, 19180);
  const slackMessageTs = slackTs(Date.now(), 19181);

  const slack = installSlackWebApiStub((method, params) => {
    if (method === "auth.test") return { ok: true, user_id: SLACK_BOT, bot_id: "B0OPE1918BOT", team_id: SLACK_TEAM_ID };
    if (method === "users.info") {
      const id = params.get("user") ?? "";
      return {
        ok: true,
        user: {
          id,
          team_id: SLACK_TEAM_ID,
          name: id === SLACK_BOT ? "ottobot" : "ope1918-member",
          real_name: id,
          profile: { display_name: id === SLACK_BOT ? "ottobot" : "ope1918-member", real_name: id },
        },
      };
    }
    if (method === "conversations.members") return { ok: true, members: [], response_metadata: { next_cursor: "" } };
    if (method === "conversations.info") {
      return {
        ok: true,
        channel: {
          id: params.get("channel"),
          name: "it-ope1918-equal-policy",
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
    if (method === "chat.postMessage") return { ok: true, channel: params.get("channel"), ts: slackTs(Date.now(), 19182) };
    return undefined;
  });
  afterThisTest(() => slack.uninstall());

  const notion = installNotionApiStub((call) => {
    if (call.method === "GET" && call.path === "/v1/users/me") return { body: { id: "it-ope-1918-bot", name: "ottobot", type: "bot" } };
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
    if (call.method === "POST" && call.path === "/v1/comments") return { body: { id: "unexpected-notion-reply" } };
    return undefined;
  });
  afterThisTest(() => notion.uninstall());

  await bootAgent({ sharedSqlite: true, selfBaseUrl: true, stubbedProviderTransport: true });
  await seedNotionChannelKey();
  const cursor = await auditCursor();

  const [{ loadDomains }, { loadBindings }] = await Promise.all([
    import("../../../agent/memory/config/domains"),
    import("../../../agent/access/bundles"),
  ]);
  const slackKey = `slack/${SLACK_TEAM_ID}/${SLACK_CHANNEL}`;
  const notionKey = `notion/${NOTION_WORKSPACE}/${NOTION_PAGE}`;
  const domains = loadDomains();
  const slackDomain = domains.find((domain) => (domain.reach ?? []).includes(slackKey));
  const notionDomain = domains.find((domain) => (domain.reach ?? []).includes(notionKey));
  expect(slackDomain?.name).toBe("e2e-unified");
  expect(notionDomain?.name).toBe(slackDomain?.name);
  const surfaceBundles = (surface: string): string[] =>
    loadBindings()
      .filter((binding) => binding.scope.level === "surface" && binding.scope.surface === surface)
      .map((binding) => binding.bundle)
      .sort();
  expect(surfaceBundles(slackKey)).toEqual(surfaceBundles(notionKey));

  const dispatched = disposeLater(
    registerScript({
      parent: [
        { calls: [{ tool: "work", input: { message: "finish the requested work and report the result" }, id: DISPATCH_CALL }] },
        {
          calls: [
            {
              tool: "reply",
              input: { wake: WAKE_FROM_ENVELOPE, text: PENDING_REPLY, done: false },
              id: "ope1918-pending-reply",
            },
          ],
        },
      ],
      child: [{ delayMs: 120_000, say: CHILD_RESULT }],
    }),
  );

  const slackResult = await slackMentionWake({
    channelId: SLACK_CHANNEL,
    userId: SLACK_MEMBER,
    text: `<@${SLACK_BOT}> delegate this and reply in this thread`,
    ts: slackMessageTs,
    threadTs: slackThreadTs,
    eventId: `EvOPE1918Slack${slackThreadTs.replace(".", "")}`,
  });
  expect(slackResult.status, slackResult.body).toBe(200);

  const pendingStep = await waitFor(
    () => dispatched.requests.find((request) => request.role === "parent" && request.stepIndex === 1),
    "the Slack dispatch turn's pending-reply step",
  );
  const seatSessionId = String(pendingStep.sessionId);
  expect(seatSessionId).toMatch(/^wrun_/);
  const taskId = await workTaskIdOfCall(cursor, dispatched, DISPATCH_CALL, "the OPE-1918 Slack delegation");
  await waitFor(
    () =>
      slack.calls.find(
        (call) =>
          call.method === "chat.postMessage" &&
          (call.params.get("text")?.includes(PENDING_REPLY) === true || call.params.get("blocks")?.includes(PENDING_REPLY) === true),
      ),
    "the pending reply to reach Slack's provider transport",
  );
  const slackWake = await waitFor(async () => {
    const rows = await rowsSinceCursor(cursor, ["wake.ingress"]);
    return rows.find((row) => row.detail?.surfaceKey === slackKey);
  }, "the original Slack wake.ingress row");
  const slackWakeId = slackWake.detail?.wakeId;
  expect(typeof slackWakeId).toBe("string");

  const heldWorker = await waitFor(
    () => dispatched.requests.find((request) => request.role === "child" && request.stepIndex === 0),
    "the delegated worker to enter its scripted hold",
  );
  expect(heldWorker.sessionId).not.toBe(seatSessionId);
  expect(dispatched.holdsCutShort()).toBe(0);
  expect(dispatched.requests.filter((request) => request.role === "parent").some((request) => promptOf(request).includes(CHILD_RESULT))).toBe(false);

  const { NO_REPLY_SENTINEL } = await import("@open-everywhere/core/agent/channels/normalized-wake.js");
  const notionTurn = disposeLater(
    registerScript(
      {
        parent: [
          { calls: [{ tool: "no_reply", input: { reason: "not_relevant" }, id: "ope1918-notion-no-reply" }] },
          { say: NO_REPLY_SENTINEL },
        ],
      },
      seatSessionId,
    ),
  );
  const notionCursor = await auditCursor();
  const notionResult = await notionCommentEventPost({
    workspaceId: NOTION_WORKSPACE,
    commentId: NOTION_TRIGGER,
    eventId: "ev-it-ope-1918-notion",
  });
  expect(notionResult.status, notionResult.body).toBe(200);
  const notionIngress = await waitFor(
    async () => (await rowsSinceCursor(cursor, ["wake.ingress"])).find((row) => row.detail?.surfaceKey === notionKey),
    "the later Notion delivery's wake.ingress row while the worker remains pending",
  );
  const notionStep = await waitFor(
    () => notionTurn.requests.find((request) => request.role === "parent" && promptOf(request).includes(NOTION_MARKER)),
    "the Notion turn to run on the same parent while the Slack worker is still held",
  );
  expect(notionStep.sessionId, "Slack and Notion did not share one standing parent session").toBe(seatSessionId);
  expect(notionStep.turnId, "the Notion delivery ran as a turn of its own").not.toBe(pendingStep.turnId);
  expect(dispatched.holdsCutShort(), "the Notion turn ran while the Slack worker was still held").toBe(0);
  await waitFor(
    async () => (await rowsSinceCursor(notionCursor, ["reply.no_reply_observed"])).find((r) => r.detail?.reason === "not_relevant"),
    "the Notion turn's no_reply tool to run",
  );
  await waitFor(() => notionTurn.requests.find((r) => r.role === "parent" && r.stepIndex === 0), "the Notion turn's last step");
  notionTurn.dispose();

  const settlement = disposeLater(
    registerScript(
      {
        parent: [
          {
            calls: [
              {
                tool: "reply",
                input: { wake: slackWakeId, text: FINAL_REPLY, done: true },
                id: "ope1918-final-reply",
              },
            ],
          },
          { say: NO_REPLY_SENTINEL },
        ],
      },
      seatSessionId,
    ),
  );

  dispatched.releaseHolds();
  await waitFor(() => (dispatched.holdsCutShort() === 1 ? true : undefined), "the worker hold to release through the control barrier");
  await waitForChildren(dispatched, { count: 1, lastStepIndex: 0, label: "the released Slack worker to return" });
  const resultStep = await awaitWorkResult({ handle: settlement, taskId, label: "the seat's step that read the released worker's result" });
  expect(resultStep.sessionId).toBe(seatSessionId);
  expect(resultStep.stepIndex).toBe(0);
  expect(resultStep.turnId, "the result reply is a seat turn of its own, after the dispatch turn").not.toBe(pendingStep.turnId);
  expect(resultStep.turnId, "…and after the Notion turn").not.toBe(notionStep.turnId);
  expect(promptOf(resultStep)).toContain(CHILD_RESULT);

  const started = await waitFor(
    async () => (await rowsSinceCursor(cursor, ["delegation.task_started"])).find((row) => row.detail?.task === taskId),
    "the delegation.task_started row joined to the settled task",
  );
  expect(started.detail?.session, "the work session started the task, not the seat").not.toBe(seatSessionId);
  expect(typeof started.detail?.request, "the task_started row names the forwarded request").toBe("string");
  expect(heldWorker.sessionId).not.toBe(seatSessionId);

  const postRow = await waitFor(async () => {
    const rows = await rowsSinceCursor(cursor, ["reply.post"]);
    return rows.find((row) => row.detail?.chars === FINAL_REPLY.length);
  }, "the final reply.post row");

  const slackPosts = slack.calls.filter((call) => call.method === "chat.postMessage");
  const notionPosts = notion.calls.filter((call) => call.method === "POST" && call.path === "/v1/comments");
  const slackCallHas = (call: (typeof slackPosts)[number], marker: string): boolean =>
    call.params.get("text")?.includes(marker) === true || call.params.get("blocks")?.includes(marker) === true;
  const finalCalls = slackPosts.filter((call) => slackCallHas(call, FINAL_REPLY));
  const transportSummary = JSON.stringify({
    slack: slackPosts.map((call) => ({
      channelMatches: call.params.get("channel") === SLACK_CHANNEL,
      threadMatches: call.params.get("thread_ts") === slackThreadTs,
      hasPendingMarker: slackCallHas(call, PENDING_REPLY),
      hasFinalMarker: slackCallHas(call, FINAL_REPLY),
      hasBlocks: call.params.has("blocks"),
    })),
    notion: notionPosts.map((call) => ({
      hasFinalMarker: JSON.stringify(call.body).includes(FINAL_REPLY),
      hasWorkerMarker: JSON.stringify(call.body).includes(CHILD_RESULT),
    })),
    audit: {
      platform: postRow.platform,
      surfaceMatches: postRow.surface === SLACK_CHANNEL,
      targetPlatform: postRow.detail?.platform,
      wakeMatches: postRow.detail?.wakeId === slackWakeId,
    },
  });
  expect(finalCalls, `the final reply never reached Slack's provider transport: ${transportSummary}`).toHaveLength(1);
  expect(finalCalls[0]!.params.get("channel")).toBe(SLACK_CHANNEL);
  expect(finalCalls[0]!.params.get("thread_ts")).toBe(slackThreadTs);
  expect(notionPosts, `the worker result reached Notion's provider transport: ${transportSummary}`).toEqual([]);

  expect(postRow.platform).toBe("slack");
  expect(postRow.detail?.platform).toBe("slack");
  expect(postRow.detail?.wakeId).toBe(slackWakeId);
  expect(postRow.detail?.route).toBe("tool");
  expect(postRow.seq, "the Notion delivery must reach the parent before the final reply").toBeGreaterThan(notionIngress.seq);

  expect(dispatched.requests.filter((request) => request.fault !== undefined)).toEqual([]);
  expect(notionTurn.requests.filter((request) => request.fault !== undefined)).toEqual([]);
  expect(settlement.requests.filter((request) => request.fault !== undefined)).toEqual([]);
  expect(dispatched.resolves.filter((resolve) => resolve.fault !== undefined)).toEqual([]);
  expect(notionTurn.resolves.filter((resolve) => resolve.fault !== undefined)).toEqual([]);
  expect(settlement.resolves.filter((resolve) => resolve.fault !== undefined)).toEqual([]);
}, 420_000);
