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
  type RecordedRequest,
} from "../harness";

const SLACK_CHANNEL = "C0EXCHAN003";
const SLACK_BOT = "U0OPE1917BOT";
const SLACK_MEMBER = "U0OPE1917MEM";
const NOTION_WORKSPACE = "40000000-0000-4000-8000-000000000001";
const NOTION_PAGE = "40000000-0000-4000-8000-000000000101";
const NOTION_DISCUSSION = "it-ope-1917-discussion";
const NOTION_TRIGGER = "it-ope-1917-trigger";
const NOTION_AUTHOR = "it-ope-1917-author";
const NOTION_MARKER = "ope1917 later notion message";
const ARTIFACT_COMMENT = "dispatch-bound artifact";
const ARTIFACT_PATH = "/workspace/ope1917-delayed-proof.txt";

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

test("a delayed Slack worker posts its artifact to the original Slack thread after a later Notion delivery reaches the same parent", async () => {
  const slackThreadTs = slackTs(Date.now() - 1_000, 19170);
  const slackMessageTs = slackTs(Date.now(), 19171);
  let laterSeat: ReturnType<typeof registerScript> | undefined;
  let notionWasServedAtUpload = false;

  const slack = installSlackWebApiStub((method, params) => {
    if (method === "auth.test") return { ok: true, user_id: SLACK_BOT, bot_id: "B0OPE1917BOT", team_id: SLACK_TEAM_ID };
    if (method === "users.info") {
      const id = params.get("user") ?? "";
      return {
        ok: true,
        user: {
          id,
          team_id: SLACK_TEAM_ID,
          name: id === SLACK_BOT ? "ottobot" : "ope1917-member",
          real_name: id,
          profile: { display_name: id === SLACK_BOT ? "ottobot" : "ope1917-member", real_name: id },
        },
      };
    }
    if (method === "conversations.members") return { ok: true, members: [], response_metadata: { next_cursor: "" } };
    if (method === "conversations.info") {
      return {
        ok: true,
        channel: {
          id: params.get("channel"),
          name: "it-ope1917-dispatch-binding",
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
    if (method === "files.getUploadURLExternal") {
      return { ok: true, upload_url: "https://slack.com/api/ope1917-upload", file_id: "F_OPE1917" };
    }
    if (method === "ope1917-upload") return { ok: true };
    if (method === "files.completeUploadExternal") {
      notionWasServedAtUpload = laterSeat?.requests.some((request) => promptOf(request).includes(NOTION_MARKER)) === true;
      return { ok: true, files: [{ id: "F_OPE1917", title: "ope1917-delayed-proof.txt" }] };
    }
    return undefined;
  });
  afterThisTest(() => slack.uninstall());

  const notion = installNotionApiStub((call) => {
    if (call.method === "GET" && call.path === "/v1/users/me") return { body: { id: "it-ope-1917-bot", name: "ottobot", type: "bot" } };
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
    if (call.method === "POST" && call.path === "/v1/comments") return { body: { id: "unexpected-notion-artifact" } };
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
  expect(loadBindings().filter((binding) => binding.scope.level === "surface" && (binding.scope.surface === slackKey || binding.scope.surface === notionKey))).toEqual([]);

  const { NO_REPLY_SENTINEL } = await import("@open-everywhere/core/agent/channels/normalized-wake.js");
  const dispatched = disposeLater(
    registerScript({
      parent: [
        { calls: [{ tool: "work", input: { message: "create the requested text artifact and post it into the Slack thread that asked" }, id: "ope1917-delegate" }] },
        { say: NO_REPLY_SENTINEL },
      ],
      child: [
        {
          delayMs: 120_000,
          calls: [
            {
              tool: "bash",
              input: { command: `printf 'OPE-1917 delayed artifact\\n' > ${ARTIFACT_PATH}` },
              id: "ope1917-create",
            },
          ],
        },
        {
          calls: [
            {
              tool: "post_file",
              input: { files: [{ source: { path: ARTIFACT_PATH }, filename: "ope1917-delayed-proof.txt" }], comment: ARTIFACT_COMMENT },
              id: "ope1917-post",
            },
          ],
        },
        { say: "posted the artifact" },
      ],
    }),
  );

  const slackPost = slackMentionWake({
    channelId: SLACK_CHANNEL,
    userId: SLACK_MEMBER,
    text: `<@${SLACK_BOT}> create the delayed artifact and post it here`,
    ts: slackMessageTs,
    threadTs: slackThreadTs,
    eventId: `EvOPE1917Slack${slackMessageTs.replace(".", "")}`,
  });
  const dispatchStep = await waitFor(
    () => dispatched.requests.find((request) => request.role === "parent" && request.stepIndex === 0),
    "the Slack dispatch model call",
  );
  const seatSessionId = String(dispatchStep.sessionId);

  laterSeat = disposeLater(registerScript({ parent: [{ say: NO_REPLY_SENTINEL }, { say: NO_REPLY_SENTINEL }] }, seatSessionId));
  const notionPost = notionCommentEventPost({
    workspaceId: NOTION_WORKSPACE,
    commentId: NOTION_TRIGGER,
    eventId: "ev-it-ope-1917-notion",
  });
  await waitFor(
    () => notion.calls.some((call) => call.method === "GET" && call.path === `/v1/comments/${NOTION_TRIGGER}`),
    "the later Notion delivery to be fetched while the worker is held",
  );
  const notionIngress = await waitFor(
    async () => (await rowsSinceCursor(cursor, ["wake.ingress"])).find((row) => row.detail?.surfaceKey === notionKey),
    "the later Notion delivery's wake.ingress row while the worker is held",
  );
  expect(slack.calls.filter((call) => call.method === "files.completeUploadExternal")).toEqual([]);
  await waitFor(
    () => laterSeat?.requests.find((request) => request.role === "parent" && promptOf(request).includes(NOTION_MARKER)),
    "the Notion turn to run on the parent while the Slack worker is held",
  );

  dispatched.releaseHolds();
  await waitFor(() => (dispatched.holdsCutShort() === 1 ? true : undefined), "the scripted resolver to consume the released worker hold");

  await waitForChildren(dispatched, { count: 1, lastStepIndex: 2, label: "the delayed Slack worker to create and post its artifact" });
  const postResult = resultById(dispatched.requests, "ope1917-post");
  expect(postResult?.isError, `post_file failed: ${JSON.stringify(postResult?.output)}`).toBe(false);
  expect(postResult?.output).toMatchObject({ posted: true, count: 1, platform: "slack" });

  const taskId = await workTaskIdOfCall(cursor, [dispatched, laterSeat], "ope1917-delegate", "the OPE-1917 delayed delegation");
  const started = await waitFor(
    async () => (await rowsSinceCursor(cursor, ["delegation.task_started"])).find((row) => row.detail?.task === taskId),
    "the delegation.task_started row joined to the artifact worker",
  );
  expect(started.detail?.session, "the work session started the task, not the seat").not.toBe(seatSessionId);
  expect(typeof started.detail?.request, "the task_started row names the forwarded request").toBe("string");
  const resultStep = await awaitWorkResult({ handle: laterSeat, taskId, label: "the seat's result-wake step that read the worker's result" });
  const notionTurn = await waitFor(
    () => laterSeat?.requests.find((request) => request.role === "parent" && promptOf(request).includes(NOTION_MARKER)),
    "the Notion turn to run on the same parent while the Slack worker was held",
  );
  expect(notionTurn.sessionId, "Slack and Notion did not share one standing parent session").toBe(seatSessionId);
  expect(notionTurn.turnId, "the Notion delivery ran as a turn of its own").not.toBe(resultStep.turnId);
  expect(notionTurn.sequence, "the Notion turn ran before the result wake — the seat did not wait on its worker").toBeLessThan(resultStep.sequence);
  const [slackResult, notionResult] = await Promise.all([slackPost, notionPost]);
  expect(slackResult.status, slackResult.body).toBe(200);
  expect(notionResult.status, notionResult.body).toBe(200);

  const complete = slack.calls.filter((call) => call.method === "files.completeUploadExternal");
  expect(complete).toHaveLength(1);
  expect(complete[0]!.params.get("channel_id")).toBe(SLACK_CHANNEL);
  expect(complete[0]!.params.get("thread_ts")).toBe(slackThreadTs);
  expect(complete[0]!.params.get("initial_comment")).toBe(ARTIFACT_COMMENT);
  expect(notionWasServedAtUpload, "the Notion delivery must have run its own parent turn before the worker's upload").toBe(true);
  expect(notion.calls.filter((call) => call.method === "POST" && call.path === "/v1/comments")).toEqual([]);

  const slackRows = await waitFor(async () => {
    const rows = await rowsSinceCursor(cursor, ["slack.post_file"]);
    return rows.length > 0 ? rows : undefined;
  }, "the successful Slack post_file audit row");
  expect(slackRows.some((row) => row.platform === "slack" && row.surface === SLACK_CHANNEL && row.detail?.attached === 1 && row.detail?.hosted === undefined)).toBe(true);
  expect(Math.min(...slackRows.map((row) => row.seq)), "the Notion delivery must reach the parent before the upload").toBeGreaterThan(notionIngress.seq);
  expect(await rowsSinceCursor(cursor, ["notion.post_file"])).toEqual([]);
  expect(dispatched.requests.filter((request) => request.fault !== undefined)).toEqual([]);
  expect(dispatched.resolves.filter((resolve) => resolve.fault !== undefined)).toEqual([]);
  expect(laterSeat.requests.filter((request) => request.fault !== undefined)).toEqual([]);
  expect(laterSeat.resolves.filter((resolve) => resolve.fault !== undefined)).toEqual([]);
}, 420_000);
