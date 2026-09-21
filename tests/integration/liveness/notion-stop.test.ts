import { afterAll, expect, test, vi } from "vitest";

import { deploymentOrg } from "@open-everywhere/core/agent/identity/binding.js";
import { resolveTurnAnchor, turnChannelKey } from "@open-everywhere/core/agent/channels/turn-registry.js";

import {
  auditCursor,
  bootAgent,
  installNotionApiStub,
  NOTION_PAGE_ID,
  NOTION_WORKSPACE_ID,
  notionCommentEventPost,
  registerScript,
  rowsSinceCursor,
  seedNotionChannelKey,
  waitFor,
  type NotionApiCall,
  type ScriptedHandle,
} from "../harness";

const live = new Set<ScriptedHandle>();
afterAll(() => {
  for (const h of live) h.dispose();
  live.clear();
});
function open(handle: ScriptedHandle): ScriptedHandle {
  live.add(handle);
  return handle;
}

const BOT_USER_ID = "it-ope-989-bot-self";

const STOPPER_ID = "it-ope-989-stopper";
const TRIGGER_AUTHOR_ID = "it-ope-989-trigger-author";

const OTHER_INTEGRATION_ID = "it-ope-989-other-integration";

const RAN_TOOL = "update_status";

const HOLD_MS = 90_000;

interface StubComment {
  readonly id: string;
  readonly discussion_id: string;
  readonly parent: { readonly page_id: string };
  readonly rich_text: ReadonlyArray<{ readonly plain_text: string }>;
  readonly created_by: { readonly id: string; readonly type: string };
  readonly created_time: string;
}

function comment(input: { id: string; authorId: string; authorType?: string; text: string }): StubComment {
  return {
    id: input.id,
    discussion_id: "it-ope-989-discussion",
    parent: { page_id: NOTION_PAGE_ID },
    rich_text: [{ plain_text: input.text }],
    created_by: { id: input.authorId, type: input.authorType ?? "person" },
    created_time: new Date().toISOString(),
  };
}

test("a human's bare `stop` comment cancels an in-flight Notion turn; a bot-authored one does not", async () => {
  await bootAgent({ sharedSqlite: true, selfBaseUrl: true });
  await seedNotionChannelKey();
  const warnings: string[] = [];
  const warnSpy = vi.spyOn(console, "warn").mockImplementation((msg?: unknown) => {
    warnings.push(String(msg));
  });
  const org = deploymentOrg();
  const channelKey = turnChannelKey("notion", `${NOTION_WORKSPACE_ID}/${NOTION_PAGE_ID}`)!;
  const cursor = await auditCursor();

  const triggerComments = new Map<string, StubComment>();
  const calls: NotionApiCall[] = [];
  const stub = installNotionApiStub((call) => {
    calls.push(call);
    if (call.method === "GET" && call.path === "/v1/users/me") return { body: { id: BOT_USER_ID, name: "it-ope-989-bot", type: "bot" } };
    if (call.method === "GET" && call.path === "/v1/comments" && call.search.has("block_id")) return { body: { results: [] } };
    if (call.method === "GET" && call.path.startsWith("/v1/comments/")) {
      const id = decodeURIComponent(call.path.slice("/v1/comments/".length));
      const found = triggerComments.get(id);
      return found ? { body: found } : undefined;
    }
    if (call.method === "POST" && call.path === "/v1/comments") return { body: { id: "it-ope-989-reply" } };
    return undefined;
  });

  const handle = open(
    registerScript({
      parent: [
        { calls: [{ tool: RAN_TOOL, input: { state: "working", summary: "ope-989 in-flight work" }, id: "ope989-ran" }] },
        { say: "this sentence is never posted — the turn is cancelled inside this call", delayMs: HOLD_MS },
      ],
    }),
  );

  const triggerId = "it-ope-989-trigger";
  triggerComments.set(triggerId, comment({ id: triggerId, authorId: TRIGGER_AUTHOR_ID, text: "please pull together the weekly summary for this page" }));
  const posted = await notionCommentEventPost({ workspaceId: NOTION_WORKSPACE_ID, commentId: triggerId });
  expect(posted.status, `the Notion front refused the trigger delivery: ${posted.body.slice(0, 300)}`).toBe(200);

  const inFlight = await waitFor(
    () => handle.requests.find((r) => r.role === "parent" && r.stepIndex === 1),
    "the parent's second model call — the turn held open, ready to be stopped",
  );
  expect(handle.requests.filter((r) => r.fault !== undefined)).toEqual([]);
  expect(inFlight.tools).toContain(RAN_TOOL);
  expect(inFlight.toolResults.map((t) => t.name)).toContain(RAN_TOOL);
  const cancelledTurnId = inFlight.turnId;
  expect(typeof cancelledTurnId).toBe("string");

  const anchor = await waitFor(
    async () => (await resolveTurnAnchor(org, { channelKey })) ?? undefined,
    "the turn-anchor row for the in-flight Notion turn",
  );
  expect(anchor.turnId).toBe(cancelledTurnId);

  const botStopId = "it-ope-989-bot-stop";
  triggerComments.set(botStopId, comment({ id: botStopId, authorId: OTHER_INTEGRATION_ID, authorType: "bot", text: "stop" }));
  const botStopPosted = await notionCommentEventPost({ workspaceId: NOTION_WORKSPACE_ID, commentId: botStopId });
  expect(botStopPosted.status).toBe(200);
  expect(await resolveTurnAnchor(org, { channelKey }), "a bot-authored `stop` must never clear the anchor").not.toBeNull();
  expect(await rowsSinceCursor(cursor, ["turn.cancel_requested"])).toEqual([]);
  expect(await rowsSinceCursor(cursor, ["turn.cancelled"])).toEqual([]);

  const stopId = "it-ope-989-human-stop";
  triggerComments.set(stopId, comment({ id: stopId, authorId: STOPPER_ID, text: "stop" }));
  const stopPosted = await notionCommentEventPost({ workspaceId: NOTION_WORKSPACE_ID, commentId: stopId });
  expect(stopPosted.status).toBe(200);
  expect(stopPosted.body).toBe("ok");

  const requested = await waitFor(async () => {
    const rows = await rowsSinceCursor(cursor, ["turn.cancel_requested"]);
    return rows.length > 0 ? rows : undefined;
  }, "the turn.cancel_requested row the ingress writes");
  expect(requested).toHaveLength(1);
  expect(requested[0]!.principalId).toBe(STOPPER_ID);
  expect(requested[0]!.detail?.via).toBe("reaction");
  expect(requested[0]!.detail?.outcome).toBe("requested");
  expect(requested[0]!.detail?.turnId).toBe(cancelledTurnId);

  handle.releaseHolds();

  const cancelled = await waitFor(async () => {
    const rows = await rowsSinceCursor(cursor, ["turn.cancelled"]);
    return rows.length > 0 ? rows : undefined;
  }, "the turn.cancelled row — written from the cancelled turn's OWN process");
  expect(cancelled).toHaveLength(1);
  expect(cancelled[0]!.platform).toBe("notion");
  expect(cancelled[0]!.detail?.ran).toEqual([RAN_TOOL]);
  expect(Number(cancelled[0]!.detail?.steps)).toBeGreaterThanOrEqual(1);
  expect(handle.holdsCutShort()).toBe(1);

  expect(warnings.some((w) => w.includes("swallowed a notion surface-text post")), "the cancelled arm attempted the acknowledgement post for this Notion turn").toBe(true);
  warnSpy.mockRestore();

  const cleared = await waitFor(
    async () => ((await resolveTurnAnchor(org, { channelKey })) === null ? true : undefined),
    "the turn-anchor row cleared by the cancelled arm",
  );
  expect(cleared).toBe(true);

  const fetchedComments = calls.filter((c) => c.method === "GET" && c.path.startsWith("/v1/comments/"));
  expect(fetchedComments.map((c) => c.path)).toEqual(
    expect.arrayContaining([`/v1/comments/${triggerId}`, `/v1/comments/${botStopId}`, `/v1/comments/${stopId}`]),
  );

  expect(handle.requests.filter((r) => r.fault !== undefined)).toEqual([]);
  stub.uninstall();
});
