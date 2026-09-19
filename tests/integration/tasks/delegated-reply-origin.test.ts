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

function resultById(requests: readonly RecordedRequest[], id: string): { isError: boolean; output: unknown } | undefined {
  for (const request of requests) {
    const result = request.toolResults.find((candidate) => candidate.id === id);
    if (result !== undefined) return { isError: result.isError, output: result.output };
  }
  return undefined;
}

function promptOf(request: RecordedRequest): string {
  return request.messages.map((message) => message.text).join("\n");
}

test("a delayed Slack delegation settles back into its original Slack thread after a later Notion turn", async () => {
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
        { calls: [{ tool: "agent", input: { message: "finish the requested work and report the result" }, id: DISPATCH_CALL }] },
        {
          calls: [
            {
              tool: "reply",
              input: { wake: WAKE_FROM_ENVELOPE, text: PENDING_REPLY, done: false },
              id: "ope1918-pending-reply",
            },
          ],
        },
        { say: "done" },
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

  const dispatchTerminal = await waitFor(
    () => dispatched.requests.find((request) => request.role === "parent" && request.stepIndex === 2),
    "the Slack dispatch turn to finish after its pending reply",
  );
  const seatSessionId = String(dispatchTerminal.sessionId);
  expect(seatSessionId).toMatch(/^wrun_/);
  const taskId = taskIdOfDelegation(dispatched, "the OPE-1918 Slack delegation");
  const pending = resultById(dispatched.requests, "ope1918-pending-reply");
  expect(pending?.isError, `the dispatch reply was refused: ${JSON.stringify(pending?.output)}`).toBe(false);
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
  const notionResult = await notionCommentEventPost({
    workspaceId: NOTION_WORKSPACE,
    commentId: NOTION_TRIGGER,
    eventId: "ev-it-ope-1918-notion",
  });
  expect(notionResult.status, notionResult.body).toBe(200);
  const notionTerminal = await waitFor(
    () => notionTurn.requests.find((request) => request.role === "parent" && request.stepIndex === 1),
    "the later Notion turn to complete while the worker remains pending",
  );
  expect(notionTerminal.sessionId, "Slack and Notion did not share one standing parent session").toBe(seatSessionId);
  expect(promptOf(notionTerminal)).toContain(NOTION_MARKER);
  expect(promptOf(notionTerminal), "the pending worker result leaked into the intervening Notion turn").not.toContain(CHILD_RESULT);
  expect(resultById(notionTurn.requests, "ope1918-notion-no-reply")?.isError).toBe(false);
  expect(notion.calls.filter((call) => call.method === "POST" && call.path === "/v1/comments")).toEqual([]);

  notionTurn.dispose();
  const settlement = disposeLater(
    armSettlement(dispatched, {
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
        { say: "done" },
      ],
    }),
  );

  dispatched.releaseHolds();
  await waitFor(() => (dispatched.holdsCutShort() === 1 ? true : undefined), "the worker hold to release through the control barrier");
  await waitForChildren(dispatched, { count: 1, lastStepIndex: 0, label: "the released Slack worker to return" });
  const notification = await consumeSettlement({
    armed: settlement,
    dispatched,
    taskId,
    label: "the released worker's settlement notification",
  });
  expect(notification.sessionId).toBe(seatSessionId);
  expect(promptOf(notification)).toContain(taskId);
  expect(promptOf(notification)).toContain(CHILD_RESULT);
  await waitFor(
    () => settlement.requests.find((request) => request.role === "parent" && request.stepIndex === 1),
    "the settlement turn to finish after its reply",
  );
  const finalResult = resultById(settlement.requests, "ope1918-final-reply");
  expect(finalResult?.isError, `the settlement reply was refused: ${JSON.stringify(finalResult?.output)}`).toBe(false);
  const finalOutput = finalResult?.output as { posted?: unknown; id?: unknown } | undefined;
  expect(finalOutput?.posted, `the settlement reply did not report a post: ${JSON.stringify(finalOutput)}`).toBe(true);
  expect(String(finalOutput?.id ?? ""), "the provider transport override did not survive agent boot").not.toMatch(/^spoof-/);

  const started = await waitFor(
    async () => (await rowsSinceCursor(cursor, ["delegation.task_started"])).find((row) => row.detail?.task === taskId),
    "the delegation.task_started row joined to the settled task",
  );
  expect(started.detail?.session).toBe(seatSessionId);
  expect(started.detail?.call).toBe(DISPATCH_CALL);
  expect(heldWorker.sessionId).not.toBe(seatSessionId);

  const postRow = await waitFor(async () => {
    const rows = await rowsSinceCursor(cursor, ["reply.post"]);
    return rows.find((row) => row.detail?.chars === FINAL_REPLY.length);
  }, "the final settlement reply.post row");

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

  expect(dispatched.requests.filter((request) => request.fault !== undefined)).toEqual([]);
  expect(notionTurn.requests.filter((request) => request.fault !== undefined)).toEqual([]);
  expect(settlement.requests.filter((request) => request.fault !== undefined)).toEqual([]);
}, 420_000);
