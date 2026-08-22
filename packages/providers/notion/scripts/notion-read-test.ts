import assert from "node:assert/strict";
import {
  registerConfig,
  resolveReadAdapter,
  supportedReadPlatforms,
  READ_ADAPTERS,
  ChannelScopeError,
  type BindableContext,
  type Domain,
} from "@open-everywhere/core/agent/adapter-api.js";
import { registerNotionProvider } from "../agent/register.js";
import { notionReadAdapter, notionChannelLines, notionDiscussionHeader, ANCHOR_SNIPPET_MAX } from "../agent/channels/notion-read.js";
import type { NotionCallOpts, NotionCommentSummary } from "../agent/channels/notion-api.js";

registerNotionProvider();

const WS = "ws-1";
const PAGE = "page-own";
const OTHER_PAGE = "page-other";
const DOMAINS: readonly Domain[] = [{ name: "docs", channels: [`notion/${WS}/${PAGE}`] }] as unknown as readonly Domain[];
registerConfig({ loadDomains: () => DOMAINS } as unknown as Parameters<typeof registerConfig>[0]);

let passed = 0;
function ok(cond: boolean, label: string): void {
  assert.ok(cond, label);
  passed++;
}
function eq(a: unknown, b: unknown, label: string): void {
  assert.deepStrictEqual(a, b, label);
  passed++;
}
async function throws(fn: () => Promise<unknown>, label: string): Promise<void> {
  await assert.rejects(fn, (err: unknown) => err instanceof ChannelScopeError, label);
  passed++;
}

function notionTurn(opts: { page?: string; discussion?: string; comment?: string } = {}): BindableContext {
  return {
    channel: { kind: "notion" },
    session: {
      auth: {
        current: {
          attributes: {
            workspace_id: WS,
            ...(opts.page ? { page_id: opts.page } : {}),
            ...(opts.discussion ? { discussion_id: opts.discussion } : {}),
            ...(opts.comment ? { comment_id: opts.comment } : {}),
          },
          principalId: "U_NOTION",
          principalType: "notion-user",
          authenticator: "notion",
        },
      },
    },
  } as unknown as BindableContext;
}

const rich = (text: string) => [{ plain_text: text }];
const comment = (id: string, discussion: string, author: string, text: string, when: string, kind = "person") => ({
  id,
  discussion_id: discussion,
  rich_text: rich(text),
  created_by: { id: author, object: "user", type: kind },
  created_time: when,
});

const PAGE_LEVEL = [comment("k1", "d-page", "u1", "is this doc current?", "t1"), comment("k2", "d-page", "u2", "yes", "t2")];
const B1_TEXT = "The ledger sums wrong";
const B2_TEXT = "Second block";
const B1_COMMENTS = [comment("k3", "d-1", "u2", "which ledger?", "t3"), comment("k4", "d-1", "u1", "the settlement one", "t4")];
const B2_COMMENTS = [comment("k5", "d-2", "u3", "unrelated point", "t5")];
const BLOCKS = [
  { id: "b1", type: "paragraph", paragraph: { rich_text: rich(B1_TEXT) } },
  { id: "b2", type: "paragraph", paragraph: { rich_text: rich(B2_TEXT) } },
];

function transport(blockText = B1_TEXT): { call: NotionCallOpts; urls: string[] } {
  const urls: string[] = [];
  const blocks = [{ id: "b1", type: "paragraph", paragraph: { rich_text: rich(blockText) } }, BLOCKS[1]!];
  const fetchFn = (async (url: string) => {
    urls.push(url);
    const body = url.includes("/children")
      ? { results: blocks, has_more: false }
      : url.includes(`block_id=${PAGE}`)
        ? { results: PAGE_LEVEL }
        : url.includes("block_id=b1")
          ? { results: B1_COMMENTS }
          : url.includes("block_id=b2")
            ? { results: B2_COMMENTS }
            : { results: [] };
    return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body };
  }) as unknown as NotionCallOpts["fetch"];
  return { call: { apiKey: "notion-test-key", fetch: fetchFn }, urls };
}

const sweptBlocks = (urls: readonly string[]): boolean => urls.some((u) => u.includes("/children"));

ok(supportedReadPlatforms().includes("notion"), "registerNotionProvider registers the notion read adapter");
ok(READ_ADAPTERS["notion"] === notionReadAdapter, "…and the registered adapter IS this bundle's");
{
  const resolved = resolveReadAdapter(notionTurn({ page: PAGE, discussion: "d-1" }), undefined, DOMAINS);
  ok(resolved.platform === "notion", "a notion turn resolves the notion platform");
  ok(resolved.adapter === notionReadAdapter, "…and resolves this adapter, not a 'not supported' throw");
}

eq(
  notionReadAdapter.wakeAddress(notionTurn({ page: PAGE, discussion: "d-1", comment: "k3" })),
  { container: PAGE, threadRoot: "d-1" },
  "a comment wake names the page as its container and the DISCUSSION as its thread root",
);
{
  const shapes = [
    notionTurn({ page: PAGE, discussion: "d-1", comment: "k3" }),
    notionTurn({ page: PAGE, discussion: "d-2" }),
    notionTurn({ page: PAGE }),
    notionTurn({ discussion: "d-1" }),
    notionTurn({ comment: "k1" }),
    notionTurn({}),
  ];
  const addresses = shapes.map((s) => notionReadAdapter.wakeAddress(s));
  ok(
    addresses.every((a) => a === undefined || typeof a.threadRoot === "string"),
    "INVARIANT: no notion turn resolves a container with an EMPTY thread slot",
  );
  ok(
    addresses.some((a) => a !== undefined && typeof a.threadRoot === "string"),
    "…and the invariant is not vacuous — at least one shape DOES resolve an address",
  );
}
eq(
  notionReadAdapter.wakeAddress(notionTurn({ page: PAGE })),
  undefined,
  "a page wake with NO discussion names no container at all — there is no bare-channel state on Notion",
);
eq(
  notionReadAdapter.wakeAddress(notionTurn({ discussion: "d-1" })),
  undefined,
  "a discussion-only wake names NO container — the discussion id is never passed off as a page id",
);
eq(notionReadAdapter.wakeAddress(notionTurn({})), undefined, "a turn with neither names nothing (explicit undefined)");

{
  const t = transport();
  const lines = await notionReadAdapter.readChannel(notionTurn({ page: PAGE, discussion: "d-1" }), PAGE, 50, { call: t.call });
  eq(lines.length, 5, "the channel read returns every comment on the page, grouped by discussion");
  ok(lines[0]!.text.startsWith(`[discussion d-page — on the page]\n`), "the page-level discussion opens with a header naming it");
  eq(lines[1]!.text, "yes", "a CONTINUATION inside one discussion carries NO header (negative control)");
  ok(
    lines[2]!.text.startsWith(`[discussion d-1 — on "${B1_TEXT}"]\n`),
    "🔴 the NEXT discussion opens with its OWN header quoting its anchor block — it can never read as a reply to the previous one",
  );
  eq(lines[3]!.text, "the settlement one", "…and its own continuation carries no header either");
  ok(lines[4]!.text.startsWith(`[discussion d-2 — on "${B2_TEXT}"]\n`), "the third discussion is headed too");
  eq(lines[0]!.author, "person u1", "an author renders as its Notion kind and id");
  eq(lines[0]!.ts, "t1", "…and carries the comment's own creation time");
}
{
  const bot: NotionCommentSummary[] = [
    { discussionId: "d", anchorId: "b", authorId: "bot-1", authorKind: "bot", createdTime: "t", text: "posted" },
  ];
  const lines = notionChannelLines(bot, PAGE);
  eq(lines[0]!.bot, true, "a bot-authored comment is marked a machine");
  eq(lines[0]!.authorId, undefined, "…and carries no author id into the grading seam");
}
{
  const mixed: NotionCommentSummary[] = [
    { discussionId: "a", anchorId: "b1", anchorText: "Alpha", authorId: "u1", createdTime: "1", text: "one" },
    { discussionId: "z", anchorId: "b2", anchorText: "Zulu", authorId: "u2", createdTime: "2", text: "two" },
    { discussionId: "a", anchorId: "b1", anchorText: "Alpha", authorId: "u3", createdTime: "3", text: "three" },
  ];
  const lines = notionChannelLines(mixed, PAGE);
  eq(lines.map((l) => l.text.split("\n").pop()), ["one", "three", "two"], "interleaved discussions regroup — each discussion's comments stay together");
  ok(lines[1]!.text === "three", "the second line of discussion 'a' is a bare continuation");
  ok(lines[2]!.text.startsWith("[discussion z"), "and discussion 'z' still opens with its own header");
}

{
  const t = transport();
  const lines = await notionReadAdapter.readThread(notionTurn({ page: PAGE, discussion: "d-page" }), PAGE, "d-page", 100, { call: t.call });
  eq(lines.map((l) => l.text.split("\n").pop()), ["is this doc current?", "yes"], "a page-level discussion reads its own comments");
  ok(lines[0]!.text.startsWith("[discussion d-page — on the page]"), "…opened by the same header the channel view uses");
  ok(!sweptBlocks(t.urls), "the cheap path takes NO block sweep — one call served it");
}
{
  const t = transport();
  const lines = await notionReadAdapter.readThread(notionTurn({ page: PAGE, discussion: "d-1" }), PAGE, "d-1", 100, { call: t.call });
  eq(lines.map((l) => l.text.split("\n").pop()), ["which ledger?", "the settlement one"], "an inline discussion reads its own comments");
  ok(lines[0]!.text.startsWith(`[discussion d-1 — on "${B1_TEXT}"]`), "…with its ANCHOR BLOCK quoted as the topic");
  ok(sweptBlocks(t.urls), "…and this path DID sweep the blocks (the cheap path's control)");
  ok(
    !lines.some((l) => l.text.includes("unrelated point") || l.text.includes("is this doc current?")),
    "🔴 a SIBLING discussion never leaks into a thread read — sibling discussions are unrelated",
  );
}
{
  const t = transport();
  const lines = await notionReadAdapter.readThread(notionTurn({ page: PAGE, discussion: "d-1" }), PAGE, "d-nope", 100, { call: t.call });
  eq(lines, [], "an unknown discussion reads as an EMPTY thread, never as the whole page");
}

{
  const long = "x".repeat(400);
  const t = transport(long);
  const lines = await notionReadAdapter.readThread(notionTurn({ page: PAGE, discussion: "d-1" }), PAGE, "d-1", 100, { call: t.call });
  const header = lines[0]!.text.split("\n")[0]!;
  const quoted = header.slice(header.indexOf('"') + 1, header.lastIndexOf('"'));
  eq(quoted.length, ANCHOR_SNIPPET_MAX, `the anchor snippet is capped at ${ANCHOR_SNIPPET_MAX} characters`);
  ok(quoted.endsWith("…"), "…and says so with an ellipsis rather than cutting silently");
  ok(!lines[0]!.text.includes("x".repeat(200)), "the page's prose never rides into the chat plane through the anchor");
}
eq(
  notionDiscussionHeader({ discussionId: "d", anchorId: "b9", text: "" }, PAGE),
  "[discussion d — on block b9]",
  "with no block text read, the header names the BLOCK rather than inventing a snippet",
);
eq(
  notionDiscussionHeader({ discussionId: "d", anchorId: PAGE, text: "" }, PAGE),
  "[discussion d — on the page]",
  "a page-level anchor says so — the page has no block prose to quote",
);
eq(
  notionDiscussionHeader({ text: "" }, PAGE),
  "[discussion (unknown) — on the page]",
  "a comment with no discussion id renders an explicit unknown, never a blank",
);

{
  const t = transport();
  const own = notionTurn({ page: PAGE, discussion: "d-1" });
  ok((await notionReadAdapter.readChannel(own, PAGE, 50, { call: t.call })).length === 5, "control: the turn's OWN page reads");
  const before = t.urls.length;
  await throws(() => notionReadAdapter.readChannel(own, OTHER_PAGE, 50, { call: t.call }), "a page outside the caller's domain is refused");
  await throws(() => notionReadAdapter.readThread(own, OTHER_PAGE, "d-1", 100, { call: t.call }), "the thread read runs the SAME fence");
  eq(t.urls.length, before, "no refused read reached the network — the fence runs BEFORE the fetch");
}

console.log(`✓ notion-read: ${passed} assertions passed`);
