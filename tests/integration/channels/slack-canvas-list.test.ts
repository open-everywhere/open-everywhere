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

interface CardRender {
  readonly text: string;
  readonly items: readonly { readonly kind: unknown; readonly id: unknown; readonly status: unknown }[];
}

function renderOf(params: URLSearchParams): CardRender {
  const text = `${params.get("text") ?? ""} ${params.get("blocks") ?? ""}`;
  const payload = (JSON.parse(params.get("metadata") ?? "{}") as { event_payload?: Record<string, unknown> }).event_payload ?? {};
  const items = payload.kind === "grouped" ? ((payload.items ?? []) as CardRender["items"]) : [{ kind: payload.kind, id: payload.id, status: payload.status }];
  return { text, items };
}

/**
 * The last render of each approval card the host posted in the room. A card is one
 * `chat.postMessage`; every later `chat.update` of that message's ts replaces its render. One job's
 * cards fold into one grouped message, so a card can carry several approvals.
 */
function finalCards(calls: readonly { readonly method: string; readonly params: URLSearchParams }[], postedTs: readonly string[]): Map<string, CardRender> {
  const cards = new Map<string, CardRender>();
  let posted = 0;
  for (const call of calls) {
    if (call.method === "chat.postMessage") {
      const ts = postedTs[posted++];
      if (ts !== undefined && call.params.get("channel") === CHANNEL && call.params.get("metadata") !== null) cards.set(ts, renderOf(call.params));
    } else if (call.method === "chat.update" && call.params.get("channel") === CHANNEL) {
      const ts = call.params.get("ts") ?? "";
      if (cards.has(ts)) cards.set(ts, renderOf(call.params));
    }
  }
  return cards;
}

test("a worker's canvas and List writes each post a card on the real host, and nothing reaches Slack before a click", async () => {
  const postedTs: string[] = [];
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
    if (method === "chat.postMessage") {
      const ts = slackTs(Date.now(), 25219 + postedTs.length);
      postedTs.push(ts);
      return { ok: true, channel: params.get("channel"), ts };
    }
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
  const canvasRow = requested.find((r) => r.detail?.kind === "canvas.write");
  const listRow = requested.find((r) => r.detail?.kind === "list.write");
  expect(typeof canvasRow?.detail?.id).toBe("string");
  expect(typeof listRow?.detail?.id).toBe("string");
  const cardHolding = (id: unknown): CardRender | undefined =>
    [...finalCards(slack.calls, postedTs).values()].find((c) => c.items.some((i) => i.id === id && i.status === "pending"));
  const { canvasCard, listCard } = await waitFor(() => {
    const canvasCard = cardHolding(canvasRow?.detail?.id);
    const listCard = cardHolding(listRow?.detail?.id);
    return canvasCard !== undefined && listCard !== undefined ? { canvasCard, listCard } : undefined;
  }, "a live card in the room that holds each of the canvas.write and list.write approvals, pending", 60_000);
  expect(canvasCard.text).toContain("Add to the canvas");
  expect(canvasCard.text).toContain("Launch plan");
  expect(listCard.text).toContain("Add 1 row in the List");
  expect(listCard.text).toContain("Release bugs");

  expect(slack.calls.filter((c) => WRITES.includes(c.method)).map((c) => c.method)).toEqual([]);
  expect(await rowsSinceCursor(cursor, ["canvas.write", "list.write"])).toEqual([]);

  expect(handle.requests.filter((r) => r.fault !== undefined)).toEqual([]);
  expect(handle.resolves.filter((r) => r.fault !== undefined)).toEqual([]);
  expect(settlement.requests.filter((r) => r.fault !== undefined)).toEqual([]);
}, 420_000);
