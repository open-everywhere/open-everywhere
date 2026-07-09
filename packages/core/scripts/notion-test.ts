
import { createHmac } from "node:crypto";
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
  notionContinuationToken,
  type FetchLike,
  type NotionComment,
} from "../agent/channels/notion-api.js";
import { handleNotionDelivery, type NotionDispatchArgs } from "../agent/channels/notion-webhook.js";
import { UNTRUSTED_OPEN, UNTRUSTED_CLOSE } from "../agent/access/untrusted.js";

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

ok(notionContinuationToken(DISCUSSION) === DISCUSSION, "continuation token is the discussion id (thread resume key)");

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
      return new Response(JSON.stringify({ id: BOT, type: "bot" }), { status: 200 });
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
const triggerSelf: NotionComment = { ...triggerMention, created_by: { id: BOT, object: "user" } };
const priorComment: NotionComment = {
  id: "prior-comment",
  discussion_id: DISCUSSION,
  created_by: { id: AUTHOR, object: "user" },
  rich_text: [{ type: "text", plain_text: "an earlier note in this thread", text: { content: "x" } }],
};

const botIdFn = () => Promise.resolve<string | undefined>(BOT);
function baseDeps(fetchImpl: FetchLike, dispatch: (a: NotionDispatchArgs) => Promise<void>, extra?: Partial<Parameters<typeof handleNotionDelivery>[2]>) {
  return {
    secret: SECRET,
    allowUnverified: false,
    apiKey: "ntn_key",
    resolveBotUserId: botIdFn,
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
  let fetchedComment = false;
  let dispatched = false;
  const f: FetchLike = async (input, init) => {
    if ((init?.method ?? "GET") === "GET" && /\/v1\/comments\/[^?]+$/.test(input)) { fetchedComment = true; return new Response(JSON.stringify(triggerNoMention), { status: 200 }); }
    return new Response("{}", { status: 200 });
  };
  const out = await handleNotionDelivery(raw, sign(raw), baseDeps(f, async () => { dispatched = true; }));
  ok(fetchedComment, "the webhook is a SIGNAL: the comment is fetched (step 2) even to decide not-mentioned");
  ok(out.action === "not-mentioned" && !dispatched, "no bot @mention -> gated, no dispatch");
}

{
  const raw = commentEvent();
  let dispatched = false;
  const out = await handleNotionDelivery(raw, sign(raw), baseDeps(makeFetch({ comment: triggerSelf }), async () => { dispatched = true; }));
  ok(out.action === "skipped-self" && !dispatched, "our own comment -> skipped (no reply loop)");
}

{
  const raw = commentEvent();
  let captured: NotionDispatchArgs | undefined;
  const out = await handleNotionDelivery(
    raw,
    sign(raw),
    baseDeps(makeFetch({ comment: triggerMention, listResults: [priorComment, triggerMention] }), async (a) => { captured = a; }),
  );
  ok(out.action === "dispatched" && captured !== undefined, "bot @mention -> dispatched");
  ok(captured!.message === "@OE please summarise this page", "dispatch message = the triggering comment text (the request)");
  ok(captured!.continuationToken === DISCUSSION, "continuation token = discussion id (thread resume)");
  ok(captured!.auth.authenticator === "notion" && captured!.auth.principalId === AUTHOR, "auth carries notion + the author principal");
  ok(captured!.auth.attributes.workspace_id === WS && captured!.auth.attributes.page_id === PAGE, "auth attributes carry workspace + page for the binding");
  ok(captured!.state.discussionId === DISCUSSION && captured!.state.pageId === PAGE, "session state carries discussion + page for the reply");
  const ctx = captured!.context.join("\n");
  ok(captured!.context.length === 1 && ctx.includes(UNTRUSTED_OPEN) && ctx.includes(UNTRUSTED_CLOSE), "thread context is UNTRUSTED-wrapped");
  ok(ctx.includes("an earlier note in this thread"), "prior thread comment included as context");
  ok(!ctx.includes("please summarise this page"), "the triggering comment is NOT duplicated into the untrusted context");
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
}

ok(notionEventType({ event_type: "comment.created" }) === "comment.created", "notionEventType tolerates the event_type spelling");
ok(commentIdFromEvent({ entity: { id: COMMENT, type: "comment" } }) === COMMENT, "commentIdFromEvent reads entity.id");
ok(commentIdFromEvent({ entity: { id: "x", type: "page" } }) === undefined, "commentIdFromEvent ignores non-comment entities");

console.log(`\n✓ notion: ${passed} assertions passed`);
