import { DatabaseSync } from "node:sqlite";

import { afterAll, expect, test } from "vitest";

import {
  bootAgent,
  NOTION_WORKSPACE_ID,
  notionCommentEventPost,
  runScheduleTask,
  seedNotionChannelKey,
  waitFor,
} from "../harness";
import { installHostFetchStub, type HostFetchStub } from "../fetch-stub";

const BOT_ID = "it-ope-1929-bot";
const PAGE_ID = "6f7ea678-0000-4000-8000-000000000002";
const DISCUSSION_ID = "it-ope-1929-discussion";

const cleanups: Array<() => void> = [];
afterAll(() => {
  for (const cleanup of cleanups.reverse()) cleanup();
});

function installBlockedNotionComment(commentId: string): {
  readonly stub: HostFetchStub;
  readonly started: () => boolean;
  readonly release: () => void;
} {
  let started = false;
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const body = JSON.stringify({
    id: commentId,
    discussion_id: DISCUSSION_ID,
    parent: { type: "page", page_id: PAGE_ID },
    rich_text: [{ type: "text", plain_text: "self-authored recovery probe", text: { content: "self-authored recovery probe" } }],
    created_by: { id: BOT_ID, type: "person" },
    created_time: new Date().toISOString(),
  });
  const stub = installHostFetchStub("https://api.notion.com", (url, init) => {
    const method = (init?.method ?? "GET").toUpperCase();
    if (method === "GET" && url.pathname === "/v1/users/me") {
      return new Response(JSON.stringify({ id: BOT_ID, name: "ottobot", type: "bot" }), { status: 200 });
    }
    if (method === "GET" && url.pathname === `/v1/comments/${commentId}`) {
      started = true;
      const stream = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
      return new Response(stream, { status: 200, headers: { "content-type": "application/json" } });
    }
    if (method === "GET" && url.pathname === "/v1/comments") {
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    }
    return undefined;
  });
  return {
    stub,
    started: () => started,
    release() {
      if (!controller) throw new Error("Notion comment barrier was released before the read started");
      controller.enqueue(new TextEncoder().encode(body));
      controller.close();
    },
  };
}

function ingressRowCount(deliveryId: string): number {
  const path = process.env.OE_SQLITE_PATH;
  if (!path) throw new Error("notion durable inbox test requires the shared SQLite floor");
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const row = db.prepare("SELECT count(*) AS n FROM ingress_delivery WHERE delivery_id = ?").get(deliveryId) as { n: number };
    return Number(row.n);
  } finally {
    db.close();
  }
}

test("verified public delivery returns 200 after commit while Notion enrichment remains blocked", async () => {
  await bootAgent({ sharedSqlite: true, selfBaseUrl: true, stubbedProviderTransport: true });
  await seedNotionChannelKey();
  const commentId = "it-ope-1929-comment-fast-ack";
  const eventId = "it-ope-1929-event-fast-ack";
  const notion = installBlockedNotionComment(commentId);
  cleanups.push(() => notion.stub.uninstall());

  const publicPost = notionCommentEventPost({ workspaceId: NOTION_WORKSPACE_ID, commentId, eventId, timeoutMs: 20_000 });
  await waitFor(() => notion.started() || undefined, "the internal drain to reach blocked Notion enrichment");
  const response = await publicPost;
  expect(response.status, response.body).toBe(200);
  expect(ingressRowCount(eventId), "the 200 must be backed by a committed row while processing is blocked").toBe(1);

  notion.release();
  await waitFor(() => ingressRowCount(eventId) === 0 || undefined, "the self-authored delivery refusal to discard its primary row");
});

test("minute recovery drains a committed row after the opportunistic self-hop is lost", async () => {
  const commentId = "it-ope-1929-comment-recovery";
  const eventId = "it-ope-1929-event-recovery";
  const notion = installBlockedNotionComment(commentId);
  cleanups.push(() => notion.stub.uninstall());

  const priorFetch = globalThis.fetch;
  let droppedNudge = false;
  const droppingFetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url);
    if (!droppedNudge && url.pathname === "/eve/v1/notion/drain") {
      droppedNudge = true;
      throw new Error("controlled lost opportunistic drain");
    }
    return priorFetch(input, init);
  };
  globalThis.fetch = droppingFetch;
  const restoreDropper = () => { if (globalThis.fetch === droppingFetch) globalThis.fetch = priorFetch; };
  cleanups.push(restoreDropper);

  const response = await notionCommentEventPost({ workspaceId: NOTION_WORKSPACE_ID, commentId, eventId, timeoutMs: 20_000 });
  expect(response.status, response.body).toBe(200);
  await waitFor(() => droppedNudge || undefined, "the controlled opportunistic drain failure");
  expect(notion.started(), "the lost self-hop must not have reached enrichment").toBe(false);
  expect(ingressRowCount(eventId), "the accepted delivery remains durably pending after the lost nudge").toBe(1);

  restoreDropper();
  const recovery = runScheduleTask("schedules/notion-ingress.ts");
  await waitFor(() => notion.started() || undefined, "the compiled minute schedule to recover the pending row");
  expect(ingressRowCount(eventId)).toBe(1);
  notion.release();
  await recovery;
  await waitFor(() => ingressRowCount(eventId) === 0 || undefined, "the recovered self-authored delivery to settle");
});

test("a durable commit failure returns 503 and starts no Notion work", async () => {
  const commentId = "it-ope-1929-comment-store-failure";
  const eventId = "it-ope-1929-event-store-failure";
  const notion = installBlockedNotionComment(commentId);
  cleanups.push(() => notion.stub.uninstall());

  const path = process.env.OE_SQLITE_PATH;
  if (!path) throw new Error("notion durable inbox test requires the shared SQLite floor");
  const db = new DatabaseSync(path);
  try {
    db.exec("DROP TABLE ingress_delivery");
  } finally {
    db.close();
  }

  const response = await notionCommentEventPost({ workspaceId: NOTION_WORKSPACE_ID, commentId, eventId, timeoutMs: 20_000 });
  expect(response.status).toBe(503);
  expect(notion.started(), "failed commit must not schedule enrichment").toBe(false);
});
