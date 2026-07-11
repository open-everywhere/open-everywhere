
import { createHmac } from "node:crypto";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import {
  verifyNotionSignature,
  parseVerificationHandshake,
  gateNotionDelivery,
  notionEventType,
  commentIdFromEvent,
  richTextToPlainText,
  mentionsUser,
  richTextChunks,
  createCommentReply,
  retrieveBotUser,
  blockPlainText,
  getBlockChildren,
  readNotionPage,
  type FetchLike,
  type NotionComment,
  type NotionBlock,
} from "../agent/channels/notion-api.js";
import { handleNotionDelivery } from "../agent/channels/notion-webhook.js";
import type { NotionSupervisorDispatch } from "../agent/channels/notion-supervisor.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

const SECRET = "verif_tok_abc";
const BOT = "bot-user-id-999";
const AUTHOR = "author-user-id-111";
const WS = "ws-123";
const PAGE = "page-456";
const DISCUSSION = "disc-789";
const COMMENT = "comment-000";

function sign(body: string, secret = SECRET): string {
  return "sha256=" + createHmac("sha256", secret).update(body, "utf8").digest("hex");
}

const body = JSON.stringify({ hello: "world" });
ok(verifyNotionSignature(SECRET, body, sign(body)), "valid signature verifies");
ok(!verifyNotionSignature(SECRET, body, "sha256=deadbeef"), "tampered signature rejected");
ok(!verifyNotionSignature(SECRET, body, null), "missing signature rejected");
ok(!verifyNotionSignature("wrong-secret", body, sign(body)), "wrong secret rejected");
ok(!verifyNotionSignature(SECRET, body + " ", sign(body)), "re-serialised/altered body rejected (raw-body sensitivity)");

ok(parseVerificationHandshake(JSON.stringify({ verification_token: "t123" })) === "t123", "handshake token parsed");
ok(parseVerificationHandshake(JSON.stringify({ verification_token: "t", type: "comment.created" })) === null, "a normal event is not treated as a handshake");
ok(parseVerificationHandshake("not json") === null, "malformed body is not a handshake");
ok(parseVerificationHandshake(JSON.stringify({ foo: 1 })) === null, "a body without the token is not a handshake");

ok(gateNotionDelivery(SECRET, body, sign(body), false) === null, "configured secret + valid signature -> accepted");
ok(gateNotionDelivery(SECRET, body, "sha256=bad", false) === "invalid signature", "bad signature -> rejected");
const noSecret = gateNotionDelivery(undefined, body, sign(body), false);
ok(noSecret !== null && noSecret.includes("NOTION_WEBHOOK_SECRET"), "unset secret -> rejected, naming the env var (fail-closed)");
ok(gateNotionDelivery(undefined, body, null, true) === null, "unset secret + escape hatch -> accepted");
ok(gateNotionDelivery(SECRET, body, "sha256=bad", true) !== null, "escape hatch does NOT bypass verification once a secret is set");

const mentionRT = [
  { type: "mention", plain_text: "@OE", mention: { type: "user", user: { id: BOT } } },
  { type: "text", plain_text: " please summarise this page", text: { content: " please summarise this page" } },
];
const noMentionRT = [{ type: "text", plain_text: "just a normal comment", text: { content: "x" } }];
const otherMentionRT = [{ type: "mention", plain_text: "@Someone", mention: { type: "user", user: { id: AUTHOR } } }];
ok(richTextToPlainText(mentionRT) === "@OE please summarise this page", "richTextToPlainText concatenates plain_text");
ok(richTextToPlainText(undefined) === "", "richTextToPlainText tolerates undefined");
ok(mentionsUser(mentionRT, BOT), "mentionsUser true when the bot is @mentioned");
ok(!mentionsUser(noMentionRT, BOT), "mentionsUser false with no mention");
ok(!mentionsUser(otherMentionRT, BOT), "mentionsUser false when someone ELSE is mentioned");
ok(!mentionsUser(mentionRT, undefined), "mentionsUser fails closed when the bot id is unresolved");

ok(richTextChunks("hi").length === 1 && richTextChunks("hi")[0].text.content === "hi", "short reply -> one chunk");
ok(richTextChunks("").length === 1 && richTextChunks("")[0].text.content === "(no content)", "empty reply -> placeholder chunk");
const big = "x".repeat(4500);
const chunks = richTextChunks(big);
ok(chunks.length === 3 && chunks[0].text.content.length === 2000 && chunks[2].text.content.length === 500, "long reply chunked at 2000 chars");

function commentEvent(): string {
  return JSON.stringify({
    type: "comment.created",
    workspace_id: WS,
    entity: { id: COMMENT, type: "comment" },
    data: { page_id: PAGE, parent: { id: PAGE, type: "page" } },
    authors: [{ id: AUTHOR, type: "person" }],
  });
}

interface MockOpts {
  comment: NotionComment;
  listResults?: NotionComment[];
  onPost?: (body: unknown) => void;
}
function makeFetch(opts: MockOpts): FetchLike {
  return async (input: string, init?: RequestInit): Promise<Response> => {
    const method = (init?.method ?? "GET").toUpperCase();
    if (method === "GET" && /\/v1\/comments\/[^?]+$/.test(input)) {
      return new Response(JSON.stringify(opts.comment), { status: 200 });
    }
    if (method === "GET" && input.includes("/v1/comments?block_id=")) {
      return new Response(JSON.stringify({ results: opts.listResults ?? [] }), { status: 200 });
    }
    if (method === "GET" && input.endsWith("/v1/users/me")) {
      return new Response(JSON.stringify({ id: BOT, type: "bot", name: "Aria" }), { status: 200 });
    }
    if (method === "POST" && input.endsWith("/v1/comments")) {
      opts.onPost?.(JSON.parse(String(init?.body ?? "{}")));
      return new Response(JSON.stringify({ id: "reply-1" }), { status: 200 });
    }
    return new Response("unexpected", { status: 500 });
  };
}

const triggerMention: NotionComment = {
  id: COMMENT,
  discussion_id: DISCUSSION,
  parent: { type: "page", page_id: PAGE },
  created_by: { id: AUTHOR, object: "user" },
  rich_text: mentionRT,
};
const triggerNoMention: NotionComment = { ...triggerMention, rich_text: noMentionRT };
const triggerSelf: NotionComment = { ...triggerMention, created_by: { id: BOT, object: "user", type: "person" } };
const triggerBot: NotionComment = { ...triggerMention, rich_text: noMentionRT, created_by: { id: "other-integration", object: "user", type: "bot" } };
const priorComment: NotionComment = {
  id: "prior-comment",
  discussion_id: DISCUSSION,
  created_by: { id: AUTHOR, object: "user" },
  rich_text: [{ type: "text", plain_text: "an earlier note in this thread", text: { content: "x" } }],
};

const botIdFn = () => Promise.resolve<string | undefined>(BOT);
function baseDeps(fetchImpl: FetchLike, dispatch: (d: NotionSupervisorDispatch) => Promise<void>, extra?: Partial<Parameters<typeof handleNotionDelivery>[2]>) {
  return {
    secret: SECRET,
    allowUnverified: false,
    apiKey: "ntn_key",
    resolveBotUserId: botIdFn,
    ambientEnabled: () => true,
    fetch: fetchImpl,
    dispatch,
    ...extra,
  };
}

{
  let token: string | undefined;
  const raw = JSON.stringify({ verification_token: "handshake-tok" });
  const out = await handleNotionDelivery(raw, null, baseDeps(makeFetch({ comment: triggerMention }), async () => {}, { onHandshakeToken: (t) => (token = t) }));
  ok(out.action === "handshake" && out.status === 200 && token === "handshake-tok", "handshake POST -> 200, token surfaced, no signature needed");
}

{
  const raw = commentEvent();
  let dispatched = false;
  const out = await handleNotionDelivery(raw, "sha256=bad", baseDeps(makeFetch({ comment: triggerMention }), async () => { dispatched = true; }));
  ok(out.action === "rejected" && out.status === 401 && !dispatched, "bad signature -> 401 rejected, no dispatch");
}

{
  const raw = JSON.stringify({ type: "page.created", workspace_id: WS, entity: { id: "p", type: "page" } });
  let fetched = false;
  const f: FetchLike = async () => { fetched = true; return new Response("{}"); };
  const out = await handleNotionDelivery(raw, sign(raw), baseDeps(f, async () => {}));
  ok(out.action === "ignored" && !fetched, "non comment.created event -> ignored, never hits the API");
}

{
  const raw = commentEvent();
  let captured: NotionSupervisorDispatch | undefined;
  const out = await handleNotionDelivery(raw, sign(raw), baseDeps(makeFetch({ comment: triggerNoMention, listResults: [priorComment, triggerNoMention] }), async (d) => { captured = d; }));
  ok(out.action === "dispatched" && captured?.addressing === "channel-watch", "plain comment -> dispatched as a JUDGED channel-watch wake (ambient)");
  ok(captured!.surfaceKey === `notion/${WS}/${PAGE}`, "dispatch carries the notion/<ws>/<page> surfaceKey (session + gate key)");
  ok(captured!.pageId === PAGE && captured!.discussionId === DISCUSSION && captured!.workspaceId === WS, "dispatch carries page + discussion + workspace");
  ok(captured!.auth.authenticator === "notion" && captured!.auth.principalId === AUTHOR, "auth carries notion + the author principal (unchanged — invariant 1)");
  ok(captured!.trigger.text === "just a normal comment" && captured!.trigger.from === "human", "the triggering comment is the trigger message");
  ok(captured!.threadComments.length === 1 && captured!.threadComments[0].text === "an earlier note in this thread", "the OTHER discussion comments become backscroll siblings (trigger excluded)");
}

{
  const personSibling: NotionComment = {
    id: "sib-person", discussion_id: DISCUSSION,
    created_by: { id: "human-222", object: "user", type: "person" },
    rich_text: [{ type: "text", plain_text: "a teammate's note", text: { content: "x" } }],
  };
  const botSibling: NotionComment = {
    id: "sib-bot", discussion_id: DISCUSSION,
    created_by: { id: "integration-333", object: "user", type: "bot" },
    rich_text: [{ type: "text", plain_text: "a bot's note", text: { content: "x" } }],
  };
  const untypedSibling: NotionComment = {
    id: "sib-untyped", discussion_id: DISCUSSION,
    created_by: { id: "unknown-444", object: "user" },
    rich_text: [{ type: "text", plain_text: "an unattributable note", text: { content: "x" } }],
  };
  const raw = commentEvent();
  let captured: NotionSupervisorDispatch | undefined;
  await handleNotionDelivery(
    raw,
    sign(raw),
    baseDeps(makeFetch({ comment: triggerNoMention, listResults: [personSibling, botSibling, untypedSibling, triggerNoMention] }), async (d) => { captured = d; }),
  );
  const byId = new Map(captured!.threadComments.map((m) => [m.id, m]));
  ok(byId.get("sib-person")?.authorId === "human-222", "F3: an identified PERSON sibling keeps its authorId (resolves a real human tier)");
  ok(byId.get("sib-bot")?.authorId === undefined, "F3: a BOT/integration sibling is left id-less → wake-trust resolves it relay");
  ok(byId.get("sib-untyped")?.authorId === undefined, "F3: a sibling with unconfirmed person-ness (no created_by.type) fails closed to id-less → relay");
  ok(captured!.trigger.from === "human", "the trigger itself stays a human message (attributed via classify's person gate)");
}

{
  const raw = commentEvent();
  let dispatched = false;
  const out = await handleNotionDelivery(raw, sign(raw), baseDeps(makeFetch({ comment: triggerNoMention }), async () => { dispatched = true; }, { ambientEnabled: () => false }));
  ok(out.action === "ambient-disabled" && !dispatched, "ambient OFF for the domain -> fail-closed, no dispatch");
}

{
  const raw = commentEvent();
  let captured: NotionSupervisorDispatch | undefined;
  const out = await handleNotionDelivery(raw, sign(raw), baseDeps(makeFetch({ comment: triggerMention, listResults: [priorComment, triggerMention] }), async (d) => { captured = d; }));
  ok(out.action === "dispatched" && captured?.addressing === "direct", "structured bot @mention -> dispatched as direct");
  ok(captured!.trigger.text === "@OE please summarise this page", "direct trigger = the triggering comment text (the request)");
}

{
  const raw = commentEvent();
  let dispatched = false;
  const out = await handleNotionDelivery(raw, sign(raw), baseDeps(makeFetch({ comment: triggerSelf }), async () => { dispatched = true; }));
  ok(out.action === "skipped-self" && !dispatched, "our own comment -> skipped-self (no reply loop)");
}

{
  const raw = commentEvent();
  let dispatched = false;
  const out = await handleNotionDelivery(raw, sign(raw), baseDeps(makeFetch({ comment: triggerBot }), async () => { dispatched = true; }));
  ok(out.action === "skipped-bot" && !dispatched, "another integration's comment -> skipped-bot (created_by.type != person)");
}

{
  const raw = commentEvent();
  let dispatched = false;
  const out = await handleNotionDelivery(raw, sign(raw), baseDeps(makeFetch({ comment: triggerMention }), async () => { dispatched = true; }, { resolveBotUserId: () => Promise.resolve(undefined) }));
  ok(out.action === "dropped" && !dispatched, "unresolved bot user id -> DROP, no dispatch (fail-closed loop guard — the critical hardening)");
}

{
  const raw = commentEvent();
  let dispatched = false;
  const out = await handleNotionDelivery(raw, null, baseDeps(makeFetch({ comment: triggerMention }), async () => { dispatched = true; }, { secret: undefined, allowUnverified: true }));
  ok(out.action === "dispatched" && dispatched, "no secret + OE_ALLOW_UNVERIFIED_NOTION_WEBHOOK -> accepted + dispatched");
}

{
  const raw = commentEvent();
  const out = await handleNotionDelivery(raw, sign(raw), baseDeps(makeFetch({ comment: triggerMention }), async () => {}, { apiKey: undefined }));
  ok(out.action === "no-api-key" && out.status === 200, "missing NOTION_API_KEY -> 200 ack, action no-api-key");
}

{
  let posted: unknown;
  await createCommentReply({ discussionId: DISCUSSION, text: "here is the summary", apiKey: "ntn_key", fetch: makeFetch({ comment: triggerMention, onPost: (b) => (posted = b) }) });
  const p = posted as { discussion_id?: string; rich_text?: Array<{ text?: { content?: string } }> };
  ok(p.discussion_id === DISCUSSION, "reply POSTs to the same discussion_id (same thread)");
  ok(p.rich_text?.[0]?.text?.content === "here is the summary", "reply body carries the model text");
}

{
  const u = await retrieveBotUser({ apiKey: "ntn_key", fetch: makeFetch({ comment: triggerMention }) });
  ok(u.id === BOT, "retrieveBotUser resolves the integration's own user id (GET /v1/users/me)");
  ok(u.name === "Aria", "retrieveBotUser also captures the bot's display name (the name-drop judge input, Step 4)");
}

ok(notionEventType({ event_type: "comment.created" }) === "comment.created", "notionEventType tolerates the event_type spelling");
ok(commentIdFromEvent({ entity: { id: COMMENT, type: "comment" } }) === COMMENT, "commentIdFromEvent reads entity.id");
ok(commentIdFromEvent({ entity: { id: "x", type: "page" } }) === undefined, "commentIdFromEvent ignores non-comment entities");

{
  const dir = join(tmpdir(), `open-everywhere-notion-no-reply-${process.pid}`);
  rmSync(dir, { recursive: true, force: true });
  process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");
  process.env.NOTION_API_KEY = "ntn_test_key";

  const nodeRequire = createRequire(import.meta.url);
  const eveRoot = dirname(nodeRequire.resolve("eve/package.json"));
  const abs = (rel: string) => pathToFileURL(join(eveRoot, rel)).href;
  const { ContextContainer, contextStorage } = await import(abs("dist/src/context/container.js"));
  const { SessionKey } = await import(abs("dist/src/context/keys.js"));
  const { markNoReplyThisTurn } = await import("../agent/channels/no-reply-signal.js");

  const inSession = <T>(fn: () => Promise<T>, attributes?: Record<string, string>): Promise<T> => {
    const c = new ContextContainer();
    const auth = attributes ? { current: { attributes }, initiator: null } : null;
    c.set(SessionKey, { sessionId: "notion-no-reply-test", auth, turn: 1, parent: undefined });
    return contextStorage.run(c, fn);
  };

  const notionChannel = (await import("../agent/channels/notion.js")).default as unknown as {
    adapter: Record<string, (data: unknown, ctx: unknown) => Promise<void>>;
  };
  const turnStarted = (ctx: unknown) => notionChannel.adapter["turn.started"]!({}, ctx);
  const completed = (message: string | null, ctx: unknown) => notionChannel.adapter["message.completed"]!({ finishReason: "stop", message }, ctx);

  const realFetch = globalThis.fetch;
  let posts: Array<{ body: { discussion_id?: string } }> = [];
  globalThis.fetch = (async (input: string, init?: RequestInit) => {
    if ((init?.method ?? "GET").toUpperCase() === "POST" && String(input).endsWith("/v1/comments")) {
      posts.push({ body: JSON.parse(String(init?.body ?? "{}")) });
      return new Response(JSON.stringify({ id: "reply-1" }), { status: 200 });
    }
    return new Response("unexpected", { status: 500 });
  }) as typeof fetch;

  try {
    const state = { discussionId: DISCUSSION, pageId: PAGE, workspaceId: WS };
    const attrs = { discussion_id: DISCUSSION, page_id: PAGE, workspace_id: WS };

    await inSession(async () => {
      const ctx = { state };
      await turnStarted(ctx);
      await completed("here is your answer", ctx);
    }, attrs);
    ok(posts.length === 1, "notion message.completed: an ordinary completion posts the reply");
    ok(posts[0]!.body.discussion_id === DISCUSSION, "notion message.completed: posts into the triggering discussion");

    posts = [];
    await inSession(async () => {
      const ctx = { state: { ...state, discussionId: "stale-first-discussion" } };
      await turnStarted(ctx);
      await completed("answering the second discussion", ctx);
    }, { ...attrs, discussion_id: "fresh-second-discussion" });
    ok(posts.length === 1 && posts[0]!.body.discussion_id === "fresh-second-discussion", "notion reply-targeting: the per-turn auth snapshot beats the stale seeded state (resume bug)");

    posts = [];
    await inSession(async () => {
      const ctx = { state: { ...state } };
      await turnStarted(ctx);
      await completed("this must not post", ctx);
    });
    ok(posts.length === 0, "notion reply-targeting: no auth target ⇒ posts NOTHING (fail safe, stale seed ignored)");

    posts = [];
    await inSession(async () => {
      const ctx = { state };
      await turnStarted(ctx);
      await completed("NO_REPLY — nothing to add", ctx);
    }, attrs);
    ok(posts.length === 0, "notion message.completed: the NO_REPLY sentinel still suppresses the reply");
    const { readAudit } = await import("../agent/audit/audit.js");
    const silences = await readAudit({ action: "notion.no_reply" });
    ok(silences.length >= 1 && silences.some((a) => a.detail?.discussionId === DISCUSSION), "notion message.completed: judged silence writes a notion.no_reply audit row (audited silence)");

    posts = [];
    await inSession(async () => {
      const ctx = { state };
      await turnStarted(ctx);
      markNoReplyThisTurn("nothing_to_add");
      await completed("actually let me add one more thing", ctx);
    }, attrs);
    ok(posts.length === 0, "notion message.completed: the no_reply TOOL route suppresses the reply (regression for the isNoReply-only bug)");

    const { markRepliedThisTurn } = await import("../agent/channels/reply-signal.js");
    const { readAudit: readAudit2 } = await import("../agent/audit/audit.js");
    const unifiedState = { ...state, oeUnified: true };
    posts = [];
    await inSession(async () => {
      const ctx = { state: unifiedState };
      await turnStarted(ctx);
      await completed("stray narration the judge never posted via the reply tool", ctx);
    }, attrs);
    ok(posts.length === 0, "UNIFIED notion turn: terminal prose is DROPPED (message-tool-only) — nothing posts");
    const dropped = await readAudit2({ action: "turn.supervisor_prose_dropped" });
    ok(dropped.length >= 1 && dropped.some((a) => a.detail?.discussionId === DISCUSSION), "UNIFIED notion turn: the dropped stray prose is audited (turn.supervisor_prose_dropped)");

    posts = [];
    const droppedBefore = (await readAudit2({ action: "turn.supervisor_prose_dropped" })).length;
    await inSession(async () => {
      const ctx = { state: unifiedState };
      await turnStarted(ctx);
      markRepliedThisTurn();
      await completed("trailing narration after a real tool reply", ctx);
    }, attrs);
    ok(posts.length === 0, "UNIFIED notion turn: trailing narration after a tool reply is dropped too (never double-posts)");
    ok((await readAudit2({ action: "turn.supervisor_prose_dropped" })).length === droppedBefore, "…but a tool-replied turn's dropped narration is NOT audited as a leak");

    posts = [];
    await inSession(async () => {
      const ctx = { state: { ...state } };
      await turnStarted(ctx);
      await completed("per-doc sessions keep posting terminal text", ctx);
    }, attrs);
    ok(posts.length === 1, "per-doc (non-unified) notion turn: terminal text still posts (byte-identical flag-off)");
  } finally {
    globalThis.fetch = realFetch;
  }
}

{
  const para: NotionBlock = { id: "b1", type: "paragraph", paragraph: { rich_text: [{ type: "text", plain_text: "hello " }, { type: "text", plain_text: "world" }] } };
  const heading: NotionBlock = { id: "b2", type: "heading_1", heading_1: { rich_text: [{ type: "text", plain_text: "A Title" }] } };
  const divider: NotionBlock = { id: "b3", type: "divider", divider: {} };
  ok(blockPlainText(para) === "hello world", "blockPlainText flattens a paragraph's rich_text");
  ok(blockPlainText(heading) === "A Title", "blockPlainText flattens a heading by its own type key");
  ok(blockPlainText(divider) === "", "blockPlainText returns empty for a text-less block (divider)");
  ok(blockPlainText({ id: "b4" } as NotionBlock) === "", "blockPlainText tolerates a typeless block");

  const oneFetch: FetchLike = async () => new Response(JSON.stringify({ results: [para], has_more: true, next_cursor: "cur-2" }), { status: 200 });
  const firstPage = await getBlockChildren(PAGE, { apiKey: "ntn_key", fetch: oneFetch });
  ok(firstPage.blocks.length === 1 && firstPage.nextCursor === "cur-2", "getBlockChildren returns blocks + the next cursor when has_more");
  const lastFetch: FetchLike = async () => new Response(JSON.stringify({ results: [para], has_more: false }), { status: 200 });
  ok((await getBlockChildren(PAGE, { apiKey: "ntn_key", fetch: lastFetch })).nextCursor === undefined, "getBlockChildren yields no cursor on the last page");

  const pages: Record<string, { results: NotionBlock[]; has_more: boolean; next_cursor?: string }> = {
    "": { results: [heading, para], has_more: true, next_cursor: "cur-2" },
    "cur-2": { results: [{ id: "b5", type: "paragraph", paragraph: { rich_text: [{ type: "text", plain_text: "second page" }] } }], has_more: false },
  };
  const pagedFetch: FetchLike = async (input) => {
    const u = new URL(input);
    const cur = u.searchParams.get("start_cursor") ?? "";
    return new Response(JSON.stringify(pages[cur]), { status: 200 });
  };
  const read = await readNotionPage(PAGE, { apiKey: "ntn_key", fetch: pagedFetch });
  ok(read.text === "A Title\nhello world\nsecond page", "readNotionPage paginates + joins flattened blocks oldest-first");
  ok(read.blockCount === 3 && read.truncated === false, "readNotionPage counts blocks and is not truncated when everything fits");

  const manyFetch: FetchLike = async () => new Response(JSON.stringify({ results: [para, heading], has_more: true, next_cursor: "more" }), { status: 200 });
  const capped = await readNotionPage(PAGE, { apiKey: "ntn_key", fetch: manyFetch, maxBlocks: 1 });
  ok(capped.blockCount === 1 && capped.truncated === true, "readNotionPage stops at maxBlocks and reports truncated");

  const bigBlock: NotionBlock = { id: "b6", type: "paragraph", paragraph: { rich_text: [{ type: "text", plain_text: "x".repeat(50) }] } };
  const bigFetch: FetchLike = async () => new Response(JSON.stringify({ results: [bigBlock, bigBlock, bigBlock], has_more: false }), { status: 200 });
  const charCapped = await readNotionPage(PAGE, { apiKey: "ntn_key", fetch: bigFetch, maxChars: 60 });
  ok(charCapped.truncated === true && charCapped.text.length <= 50, "readNotionPage stops at maxChars (keeps at least the first block) and reports truncated");
}

console.log(`\n✓ notion: ${passed} assertions passed`);
