import { expect, test } from "vitest";

import {
  afterThisTest,
  armSettlement,
  auditCursor,
  awaitWorkResult,
  bootAgent,
  disposeLater,
  installSlackWebApiStub,
  registerScript,
  rowsSinceCursor,
  SLACK_TEAM_ID,
  slackMentionWake,
  slackTs,
  waitFor,
  waitForChildren,
  workTaskIdOfCall,
  type RecordedRequest,
} from "../harness";

const CHANNEL = "C0EXCHAN003";
const BOT = "U0OPE2521BOT";
const MEMBER = "U0OPE2521MEM";
const CANVAS = "F0IT2521CV";
const LIST = "F0IT2521LS";
const WRITES = ["canvases.create", "canvases.edit", "conversations.canvases.create", "slackLists.items.create", "slackLists.items.update"];

function resultById(requests: readonly RecordedRequest[], id: string): { isError: boolean; output: unknown } | undefined {
  for (const request of requests) {
    const result = request.toolResults.find((candidate) => candidate.id === id);
    if (result !== undefined) return { isError: result.isError, output: result.output };
  }
  return undefined;
}

test("a worker's canvas and List writes each post a card on the real host, and nothing reaches Slack before a click", async () => {
  const slack = installSlackWebApiStub((method, params) => {
    if (method === "auth.test") return { ok: true, user_id: BOT, bot_id: "B0OPE2521BOT", team_id: SLACK_TEAM_ID };
    if (method === "users.info") {
      const id = params.get("user") ?? "";
      return { ok: true, user: { id, team_id: SLACK_TEAM_ID, name: id, real_name: id, profile: { display_name: id, real_name: id } } };
    }
    if (method === "conversations.members") return { ok: true, members: [], response_metadata: { next_cursor: "" } };
    if (method === "conversations.info") {
      return {
        ok: true,
        channel: { id: params.get("channel"), name: "it-ope2521", is_channel: true, is_private: false, is_ext_shared: false, is_org_shared: false, is_shared: false, is_pending_ext_shared: false, num_members: 8 },
      };
    }
    if (method === "conversations.history" || method === "conversations.replies") return { ok: true, messages: [] };
    if (method === "chat.postMessage") return { ok: true, channel: params.get("channel"), ts: slackTs(Date.now(), 25219) };
    if (method === "chat.update" || method === "chat.postEphemeral") return { ok: true, ts: slackTs(Date.now(), 25218) };
    if (method === "files.info") {
      const file = params.get("file");
      if (file === CANVAS) return { ok: true, file: { id: CANVAS, title: "Launch plan", filetype: "quip", pretty_type: "Canvas", channels: [CHANNEL] } };
      if (file === LIST) {
        return {
          ok: true,
          file: {
            id: LIST,
            title: "Release bugs",
            filetype: "list",
            pretty_type: "List",
            channels: [CHANNEL],
            list_metadata: { schema: [{ id: "Col0Title", name: "Title", type: "text", is_primary_column: true }, { id: "Col0Due", name: "Due", type: "date" }] },
          },
        };
      }
      return { ok: false, error: "file_not_found" };
    }
    return undefined;
  });
  afterThisTest(() => slack.uninstall());

  await bootAgent({ stubbedProviderTransport: true });
  const cursor = await auditCursor();

  const { NO_REPLY_SENTINEL } = await import("@open-everywhere/core/agent/channels/normalized-wake.js");
  const handle = disposeLater(
    registerScript({
      parent: [
        { calls: [{ tool: "work", input: { message: "add the decision to the launch plan canvas and file the bug in the release List" }, id: "it2521-delegate" }] },
        { say: NO_REPLY_SENTINEL },
      ],
      child: [
        {
          delayMs: 120_000,
          calls: [
            { tool: "write_canvas", input: { canvas: `https://acme.slack.com/docs/${SLACK_TEAM_ID}/${CANVAS}`, markdown: "## Decision\n- Ship on Friday (it2521)" }, id: "it2521-canvas" },
            { tool: "update_list", input: { list: `https://acme.slack.com/lists/${SLACK_TEAM_ID}/${LIST}`, add: [{ cells: { Title: "Login fails (it2521)", Due: "2026-10-20" } }] }, id: "it2521-list" },
          ],
        },
        { say: "proposed both" },
      ],
    }),
  );

  const wake = slackMentionWake({
    channelId: CHANNEL,
    userId: MEMBER,
    text: `<@${BOT}> add the decision to the launch plan canvas and file the bug in the release List`,
    ts: slackTs(Date.now(), 25210),
    eventId: `EvOPE2521${Date.now()}`,
  });
  await waitFor(() => handle.requests.find((r) => r.role === "parent" && r.stepIndex === 1), "the it2521 receipt step to be served");
  const settlement = disposeLater(armSettlement(handle, { parent: [{ say: NO_REPLY_SENTINEL }] }));
  const taskId = await workTaskIdOfCall(cursor, handle, "it2521-delegate", "the it2521 forward receipt");
  handle.releaseHolds();
  await waitForChildren(handle, { count: 1, lastStepIndex: 1, label: "the it2521 worker's terminal step" });
  await awaitWorkResult({ handle: settlement, taskId, label: "the it2521 seat step that read the worker's result" });
  expect((await wake).status).toBe(200);

  const canvasResult = resultById(handle.requests, "it2521-canvas");
  const listResult = resultById(handle.requests, "it2521-list");
  expect(canvasResult?.isError, `write_canvas failed: ${JSON.stringify(canvasResult?.output)}`).toBe(false);
  expect(listResult?.isError, `update_list failed: ${JSON.stringify(listResult?.output)}`).toBe(false);
  expect(canvasResult?.output).toMatchObject({ pending: true });
  expect(listResult?.output).toMatchObject({ pending: true });

  const fenced = slack.calls.filter((c) => c.method === "files.info").map((c) => c.params.get("file"));
  expect(fenced).toEqual(expect.arrayContaining([CANVAS, LIST]));
  const requested = await waitFor(async () => {
    const rows = await rowsSinceCursor(cursor, ["approval.requested"]);
    const kinds = rows.map((r) => r.detail?.kind);
    return kinds.includes("canvas.write") && kinds.includes("list.write") ? rows : undefined;
  }, "the canvas.write and list.write approval.requested rows", 60_000);
  expect(requested.filter((r) => r.detail?.kind === "canvas.write")).toHaveLength(1);
  expect(requested.filter((r) => r.detail?.kind === "list.write")).toHaveLength(1);
  const posted = slack.calls.filter((c) => c.method === "chat.postMessage").map((c) => `${c.params.get("text") ?? ""} ${c.params.get("blocks") ?? ""}`);
  expect(posted.some((p) => p.includes('Add to the canvas') && p.includes("Launch plan"))).toBe(true);
  expect(posted.some((p) => p.includes('Add 1 row in the List') && p.includes("Release bugs"))).toBe(true);

  expect(slack.calls.filter((c) => WRITES.includes(c.method)).map((c) => c.method)).toEqual([]);
  expect(await rowsSinceCursor(cursor, ["canvas.write", "list.write"])).toEqual([]);

  expect(handle.requests.filter((r) => r.fault !== undefined)).toEqual([]);
  expect(handle.resolves.filter((r) => r.fault !== undefined)).toEqual([]);
  expect(settlement.requests.filter((r) => r.fault !== undefined)).toEqual([]);
}, 420_000);
