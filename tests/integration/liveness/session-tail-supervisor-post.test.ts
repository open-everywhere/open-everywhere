import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { afterAll, expect, test } from "vitest";

import {
  bootAgent,
  disposeLater,
  installNotionApiStub,
  NOTION_PAGE_ID,
  NOTION_PAGE_ID_2,
  NOTION_WORKSPACE_ID,
  notionCommentEventPost,
  readAuditRows,
  registerScript,
  seedNotionChannelKey,
  sleep,
  waitFor,
  type NotionApiCall,
} from "../harness";

const DISCUSSION_ID = "it-ope-807-discussion";
const DISCUSSION_ID_2 = "it-ope-807-discussion-2";
const DISCUSSION_ID_3 = "it-ope-808-discussion";

const TRIGGER_AUTHOR_ID = "it-ope-807-member";

const BOT_USER_ID = "it-ope-807-bot-self";
const BOT_NAME = "ottobot";

interface TailRow {
  readonly surface_key: string;
  readonly token: string;
  readonly entry_json: string;
}
interface TailEntry {
  readonly kind: string;
  readonly from: string;
  readonly text: string;
  readonly at: string;
  readonly container?: string;
  readonly platform?: string;
}

function readTailRows(): readonly (TailRow & { readonly entry: TailEntry })[] {
  const path = process.env.OE_SQLITE_PATH;
  if (path === undefined || path.length === 0) {
    throw new Error("session-tail-supervisor-post test: OE_SQLITE_PATH is unset — bootAgent({ sharedSqlite: true }) did not run.");
  }
  const db = new DatabaseSync(path);
  try {
    const rows = db.prepare("SELECT surface_key, token, entry_json FROM session_tail ORDER BY seq ASC").all() as unknown as readonly TailRow[];
    return rows.map((r) => ({ ...r, entry: JSON.parse(r.entry_json) as TailEntry }));
  } finally {
    db.close();
  }
}

interface StubComment {
  readonly id: string;
  readonly discussion_id: string;
  readonly parent?: { readonly page_id: string };
  readonly rich_text: ReadonlyArray<{ readonly plain_text: string }>;
  readonly created_by: { readonly id: string; readonly type: string };
  readonly created_time: string;
}

const triggerComments = new Map<string, StubComment>();

let stub: { calls: readonly NotionApiCall[] } | undefined;

const cleanups: (() => void)[] = [];
afterAll(async () => {
  for (const c of cleanups.splice(0)) c();
  const settings = await import("@open-everywhere/core/agent/settings/settings.js");
  settings.resetSettingsForTest();
});

async function armSeams(): Promise<void> {
  await bootAgent({ sharedSqlite: true, selfBaseUrl: true });
  const settings = await import("@open-everywhere/core/agent/settings/settings.js");
  settings.overrideSettingsForTest({ approvals: { judgeMode: "off" }, window: { topology: false } });
  expect(settings.getSettings().window.topology).toBe(false);
  if (stub) return;
  await seedNotionChannelKey();
  const installed = installNotionApiStub((call) => {
    if (call.method === "GET" && call.path === "/v1/users/me") return { body: { id: BOT_USER_ID, name: BOT_NAME, type: "bot" } };
    if (call.method === "GET" && call.path === "/v1/comments") return { body: { results: [] } };
    if (call.method === "GET" && call.path.startsWith("/v1/comments/")) {
      const id = decodeURIComponent(call.path.slice("/v1/comments/".length));
      const found = triggerComments.get(id);
      return found ? { body: found } : undefined;
    }
    if (call.method === "POST" && call.path === "/v1/comments") return { body: { id: `it-ope-807-reply-${randomBytes(4).toString("hex")}` } };
    return undefined;
  });
  stub = installed;
  cleanups.push(() => installed.uninstall());
}

test("a ticketing supervisor's `reply` reaches the room and its generation's tail ring", async () => {
  await armSeams();
  const sinceIso = new Date(Date.now() - 5_000).toISOString();
  const marker = randomBytes(4).toString("hex");
  const question = `supervisor tail probe ${marker}`;
  const answer = `supervisor answered ${marker}`;

  disposeLater(registerScript({ parent: [{ calls: [{ tool: "reply", input: { text: answer }, id: `t811-reply-${marker}` }] }, { say: "done" }] }));

  const triggerId = `it-ope-811-trigger-${marker}`;
  triggerComments.set(triggerId, {
    id: triggerId,
    discussion_id: DISCUSSION_ID,
    parent: { page_id: NOTION_PAGE_ID },
    rich_text: [{ plain_text: question }],
    created_by: { id: TRIGGER_AUTHOR_ID, type: "person" },
    created_time: new Date().toISOString(),
  });
  const res = await notionCommentEventPost({ workspaceId: NOTION_WORKSPACE_ID, commentId: triggerId });
  expect(res.status, `the Notion front refused the delivery: ${res.body.slice(0, 300)}`).toBe(200);

  const posted = await waitFor(
    async () =>
      (await readAuditRows({ actions: ["reply.post"], sinceIso, limit: 200 })).find(
        (r) => (r.detail as { chars?: unknown; platform?: unknown } | undefined)?.chars === answer.length && (r.detail as { platform?: unknown }).platform === "notion",
      ),
    "a reply.post audit row for this turn's scripted `reply` call",
  );
  expect(posted.detail?.route, "the reply did not travel the TOOL route").toBe("tool");

  const replied = await waitFor(
    async () => (await readAuditRows({ actions: ["notion.replied"], sinceIso, limit: 200 })).find((r) => (r.detail as { discussionId?: unknown } | undefined)?.discussionId === DISCUSSION_ID),
    "a notion.replied lifecycle row closing this turn's notion.dispatched row",
  );
  expect(replied.detail?.route, "the lifecycle row does not name the tool route").toBe("tool");
  expect((await readAuditRows({ actions: ["turn.supervisor_prose_dropped"], sinceIso, limit: 200 })).filter((r) => (r.detail as { chars?: unknown } | undefined)?.chars === "done".length)).toEqual([]);

  await sleep(2_000);

  const rows = readTailRows();
  const wakes = rows.filter((r) => r.entry.kind === "wake");
  const posts = rows.filter((r) => r.entry.kind === "post");

  expect(posts.length).toBe(1);
  expect(posts[0]!.entry.text).toBe(answer);
  expect(posts[0]!.entry.from).toBe("self");
  expect(posts[0]!.entry.platform).toBe("notion");

  expect(wakes.length).toBeGreaterThan(0);
  const wake = wakes.find((r) => r.entry.text.includes(question));
  expect(wake, "the wake that carried this question was never recorded on any ring").toBeDefined();
  expect(posts[0]!.token).toBe(wake!.token);
  expect(posts[0]!.surface_key).toBe(wake!.surface_key);

  expect(posts[0]!.entry.container).toBe(wake!.entry.container);
  expect(Date.parse(posts[0]!.entry.at)).toBeGreaterThanOrEqual(Date.parse(wake!.entry.at));

  expect(rows.filter((r) => r.entry.kind === "post" && r.entry.text === answer).length).toBe(1);
});

test("🔴 OPE-811: a supervisor turn's closing prose reaches neither the room nor the ring", async () => {
  await armSeams();
  const sinceIso = new Date(Date.now() - 5_000).toISOString();
  const marker = randomBytes(4).toString("hex");
  const question = `dropped-prose probe ${marker}`;
  const answer = `never posted ${marker}`;
  const before = readTailRows().length;

  disposeLater(registerScript({ parent: [{ say: answer }] }));

  const triggerId = `it-ope-811-drop-${marker}`;
  triggerComments.set(triggerId, {
    id: triggerId,
    discussion_id: DISCUSSION_ID_2,
    parent: { page_id: NOTION_PAGE_ID_2 },
    rich_text: [{ plain_text: question }],
    created_by: { id: TRIGGER_AUTHOR_ID, type: "person" },
    created_time: new Date().toISOString(),
  });
  const res = await notionCommentEventPost({ workspaceId: NOTION_WORKSPACE_ID, commentId: triggerId });
  expect(res.status, `the Notion front refused the delivery: ${res.body.slice(0, 300)}`).toBe(200);

  const dropped = await waitFor(
    async () => (await readAuditRows({ actions: ["turn.supervisor_prose_dropped"], sinceIso, limit: 200 })).find((r) => (r.detail as { chars?: unknown } | undefined)?.chars === answer.length),
    "a turn.supervisor_prose_dropped audit row for this turn's scripted say",
  );
  expect(JSON.stringify(dropped.detail), "the dropped answer's TEXT reached an audit row — the family is taint-clean by contract").not.toContain(marker);
  await sleep(2_000);

  expect((await readAuditRows({ actions: ["notion.replied"], sinceIso, limit: 200 })).filter((r) => (r.detail as { discussionId?: unknown } | undefined)?.discussionId === DISCUSSION_ID_2)).toEqual([]);
  expect((await readAuditRows({ actions: ["reply.post"], sinceIso, limit: 200 })).filter((r) => (r.detail as { chars?: unknown } | undefined)?.chars === answer.length)).toEqual([]);

  const rows = readTailRows();
  expect(rows.filter((r) => r.entry.kind === "post" && r.entry.text === answer)).toEqual([]);

  expect(rows.length, "this arm's wake was never recorded — the ring is not live, so ② is vacuous").toBeGreaterThan(before);
  expect(rows.filter((r) => r.entry.kind === "wake" && r.entry.text.includes(question)).length).toBeGreaterThan(0);
});

test("🔴 a dedupe-suppressed repost writes no second tail-ring row and no second reply.post row", async () => {
  await armSeams();
  const sinceIso = new Date(Date.now() - 5_000).toISOString();
  const marker = randomBytes(4).toString("hex");
  const answer = `duplicate-safe answer ${marker}`;

  const turn1 = registerScript({ parent: [{ calls: [{ tool: "reply", input: { text: answer }, id: `t811-dup-1-${marker}` }] }, { say: "done" }] });

  const trigger1 = `it-ope-811-dup-1-${marker}`;
  triggerComments.set(trigger1, {
    id: trigger1,
    discussion_id: DISCUSSION_ID_3,
    parent: { page_id: NOTION_PAGE_ID },
    rich_text: [{ plain_text: `first question ${marker}` }],
    created_by: { id: TRIGGER_AUTHOR_ID, type: "person" },
    created_time: new Date().toISOString(),
  });
  const res1 = await notionCommentEventPost({ workspaceId: NOTION_WORKSPACE_ID, commentId: trigger1 });
  expect(res1.status, `the Notion front refused the first delivery: ${res1.body.slice(0, 300)}`).toBe(200);

  await waitFor(
    async () =>
      (await readAuditRows({ actions: ["reply.post"], sinceIso, limit: 200 })).find(
        (r) => (r.detail as { chars?: unknown; platform?: unknown } | undefined)?.chars === answer.length && (r.detail as { platform?: unknown }).platform === "notion",
      ),
    "a reply.post audit row for the first turn's `reply` call",
  );
  await sleep(1_000);
  expect(readTailRows().filter((r) => r.entry.kind === "post" && r.entry.text === answer).length, "the first turn's post did not reach the ring").toBe(1);

  turn1.dispose();
  disposeLater(registerScript({ parent: [{ calls: [{ tool: "reply", input: { text: answer }, id: `t811-dup-2-${marker}` }] }, { say: "done" }] }));

  const trigger2 = `it-ope-811-dup-2-${marker}`;
  triggerComments.set(trigger2, {
    id: trigger2,
    discussion_id: DISCUSSION_ID_3,
    parent: { page_id: NOTION_PAGE_ID },
    rich_text: [{ plain_text: `second question ${marker}` }],
    created_by: { id: TRIGGER_AUTHOR_ID, type: "person" },
    created_time: new Date().toISOString(),
  });
  const res2 = await notionCommentEventPost({ workspaceId: NOTION_WORKSPACE_ID, commentId: trigger2 });
  expect(res2.status, `the Notion front refused the second delivery: ${res2.body.slice(0, 300)}`).toBe(200);

  await waitFor(
    async () => ((await readAuditRows({ actions: ["notion.replied"], sinceIso, limit: 200 })).filter((r) => (r.detail as { discussionId?: unknown } | undefined)?.discussionId === DISCUSSION_ID_3).length >= 2 ? true : undefined),
    "two notion.replied lifecycle rows — the second turn ran and delivered through the tool",
  );
  await sleep(1_000);

  expect(
    (await readAuditRows({ actions: ["reply.post"], sinceIso, limit: 200 })).filter(
      (r) => (r.detail as { chars?: unknown; platform?: unknown } | undefined)?.chars === answer.length && (r.detail as { platform?: unknown }).platform === "notion",
    ).length,
  ).toBe(1);
  expect(readTailRows().filter((r) => r.entry.kind === "post" && r.entry.text === answer).length, "a suppressed repost must not double-file the ring").toBe(1);

});
