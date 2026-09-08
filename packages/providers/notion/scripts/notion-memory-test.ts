import { renderBlocks, pageTitle, contentLines, blocksFromMarkdown, type BlockNode } from "../agent/memory/blocks.js";
import { NotionClient, makeNotionProvider, type HttpFetch } from "../agent/memory/memory.js";
import type { Partition } from "@open-everywhere/core/agent/adapter-api.js";
import { siloTier, RateLimitExhaustedError } from "@open-everywhere/core/agent/adapter-api.js";
const TIER = siloTier("baseline");

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

ok(renderBlocks([{ type: "heading_1", heading_1: { rich_text: [{ plain_text: "Title" }] } }]).startsWith("# Title"), "codec: heading_1");
ok(
  renderBlocks([{ type: "bulleted_list_item", bulleted_list_item: { rich_text: [{ plain_text: "a" }] }, has_children: true, children: [{ type: "bulleted_list_item", bulleted_list_item: { rich_text: [{ plain_text: "b" }] } }] }]).includes("  - b"),
  "codec: nested list indents",
);
ok(renderBlocks([{ type: "to_do", to_do: { rich_text: [{ plain_text: "x" }], checked: true } }]).includes("- [x] x"), "codec: checked to-do");
ok(renderBlocks([{ type: "paragraph", paragraph: { rich_text: [{ plain_text: "bold", annotations: { bold: true } }] } }]).includes("**bold**"), "codec: bold annotation");
ok(renderBlocks([{ type: "code", code: { rich_text: [{ plain_text: "x=1" }], language: "ts" } }]).includes("```ts"), "codec: code fence + language");
ok(renderBlocks([{ type: "equation", id: "e1", equation: { expression: "E=mc^2" } }]).includes("$$ E=mc^2 $$"), "codec: equation rendered losslessly");
ok(pageTitle({ type: "child_page", child_page: { title: "Onboarding" } }) === "Onboarding", "codec: child_page title");

const img = renderBlocks([{ type: "image", id: "img-1", image: { caption: [{ plain_text: "a diagram" }], external: { url: "https://x/y.png" } } }]);
ok(img.includes("[notion:image id=img-1]") && img.includes('"a diagram"'), "codec: image → placeholder w/ type+id+caption");
const tbl = renderBlocks([{ type: "table", id: "tbl-1", has_children: true, table: {}, children: [{ type: "table_row", table_row: { cells: [] } }] }]);
ok(tbl.includes("[notion:table id=tbl-1]"), "codec: table → placeholder (type+id)");
ok(!tbl.includes("table_row"), "codec: table rows NOT rendered as junk (children skipped)");
const bm = renderBlocks([{ type: "bookmark", id: "bm-1", bookmark: { url: "https://ref" } }]);
ok(bm.includes("[notion:bookmark id=bm-1]") && bm.includes("(https://ref)"), "codec: bookmark → placeholder w/ url hint");
ok(bm.includes("fetch by id via the Notion tools"), "codec: placeholder tells the agent how to fetch it");

const tree: Record<string, BlockNode[]> = {
  root: [
    { type: "heading_1", id: "h1", heading_1: { rich_text: [{ plain_text: "Handbook" }] } },
    { type: "paragraph", id: "p1", paragraph: { rich_text: [{ plain_text: "Welcome" }] } },
    { type: "bulleted_list_item", id: "b1", has_children: true, bulleted_list_item: { rich_text: [{ plain_text: "top" }] } },
    { type: "child_page", id: "sub1", has_children: true, child_page: { title: "Onboarding" } },
    { type: "child_page", id: "sub3", has_children: true, child_page: { title: "Archive" } },
  ],
  sub3: [{ type: "paragraph", id: "ar", paragraph: { rich_text: [{ plain_text: "old noise" }] } }],
  b1: [{ type: "bulleted_list_item", id: "b2", bulleted_list_item: { rich_text: [{ plain_text: "nested" }] } }],
  sub1: [
    {
      type: "paragraph",
      id: "sp",
      paragraph: { rich_text: [{ plain_text: "Step one, see " }, { type: "mention", plain_text: "Deep Dive", mention: { type: "page", page: { id: "sub2" } } }] },
    },
    { type: "link_to_page", id: "ltp", link_to_page: { type: "page_id", page_id: "external-xyz" } },
    { type: "child_page", id: "sub2", child_page: { title: "Deep Dive" } },
  ],
  sub2: [{ type: "paragraph", id: "d", paragraph: { rich_text: [{ plain_text: "deepest" }] } }],
};

let calls = 0;
const fakeFetch: HttpFetch = async (url) => {
  calls++;
  const m = url.match(/\/v1\/blocks\/([^/]+)\/children/);
  const id = m ? m[1] : "";
  const results = tree[id] ?? [];
  return {
    ok: true,
    status: 200,
    async text() {
      return "";
    },
    async json() {
      return { results, has_more: false, next_cursor: null };
    },
  };
};

const provider = makeNotionProvider({ client: () => new NotionClient("tok", fakeFetch) });
const p: Partition = { org: "default", platform: "slack", workspace: "T", surface: "C", workspaceKey: "slack/T", surfaceKey: "slack/T/C", key: "slack/T/C" };
const silo = { name: "baseline", provider: "notion", container: "root", readOnly: true };

const files = await provider.readTier(p, TIER, silo);

ok("MEMORY.md" in files, "root page → MEMORY.md");
ok(files["MEMORY.md"].includes("# Handbook") && files["MEMORY.md"].includes("Welcome"), "root content rendered");
ok(files["MEMORY.md"].includes("- top") && files["MEMORY.md"].includes("  - nested"), "nested list rendered under root");
ok(!files["MEMORY.md"].includes("Step one"), "child-page content NOT inlined into the parent");
ok("Onboarding.md" in files && files["Onboarding.md"].includes("Step one"), "child page → Onboarding.md");
ok("Onboarding/Deep-Dive.md" in files && files["Onboarding/Deep-Dive.md"].includes("deepest"), "grandchild page → nested path keyed by sanitized title");

ok(files["Onboarding.md"].includes("[Deep Dive](Onboarding/Deep-Dive.md)"), "page mention → relative on-disk link");
ok(files["Onboarding.md"].includes("(link to a page outside this memory)"), "out-of-subtree link → graceful placeholder");

const asyncProvider = makeNotionProvider({ client: async () => new NotionClient("tok", fakeFetch) });
const asyncFiles = await asyncProvider.readTier(p, TIER, silo);
ok("MEMORY.md" in asyncFiles && asyncFiles["MEMORY.md"].includes("# Handbook"), "provider awaits an async (broker-resolved) client factory");

const single = makeNotionProvider({ client: () => new NotionClient("tok", fakeFetch) });
const singleFiles = await single.readTier(p, TIER, { name: "one", provider: "notion", container: "root", readOnly: true, recursive: false });
ok("MEMORY.md" in singleFiles && singleFiles["MEMORY.md"].includes("# Handbook"), "recursive:false → root page pulled");
ok(!("Onboarding.md" in singleFiles) && !("Onboarding/Deep-Dive.md" in singleFiles), "recursive:false → child pages NOT pulled");

const subsetProvider = makeNotionProvider({ client: () => new NotionClient("tok", fakeFetch) });
const subsetFiles = await subsetProvider.readTier(p, TIER, {
  name: "subset",
  provider: "notion",
  container: "root",
  readOnly: true,
  select: { default: "include", rules: [{ path: "Onboarding", mode: "recurse" }] },
});
ok("MEMORY.md" in subsetFiles, "select: root (A) included");
ok("Onboarding.md" in subsetFiles && "Onboarding/Deep-Dive.md" in subsetFiles, "select: Onboarding subtree (B + D) included");
ok(!("Archive.md" in subsetFiles), "select: Archive sibling (C) excluded");

try {
  await provider.writeTier(p, TIER, { "MEMORY.md": "x" }, "nope", silo);
  ok(false, "a write to a read-only silo must throw");
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  ok(msg.includes("READ-ONLY"), "read-only writeTier: throws rather than returning null");
  ok(msg.includes("NOTHING was saved"), "read-only writeTier: the refusal says the bytes were not saved");
  ok(msg.includes("Notion tools"), "read-only writeTier: the refusal names the update route");
}
const callsBeforeDelete = calls;
await provider.deleteTier(p, TIER, silo);
ok(calls === callsBeforeDelete, "deleteTier is a no-op on a read-only silo (no API call, nothing of ours to erase)");

const callsAfterFirst = calls;
await provider.readTier(p, TIER, silo);
ok(calls === callsAfterFirst, "second read is served from cache (no extra API calls)");

try {
  await provider.readTier(p, TIER, { name: "x", provider: "notion" });
  ok(false, "missing container should throw");
} catch {
  ok(true, "missing container → throws");
}

{
  const headers = new Headers();
  headers.set("retry-after", "2");
  let calls = 0;
  const rateLimitedThenOk: HttpFetch = async () => {
    calls++;
    if (calls === 1) return { ok: false, status: 429, headers, text: async () => "rate limited", json: async () => ({}) } as never;
    return { ok: true, status: 200, text: async () => JSON.stringify({ results: [] }), json: async () => ({ results: [] }) };
  };
  const slept: number[] = [];
  const client = new NotionClient("tok", rateLimitedThenOk, "https://api.notion.com", undefined, { sleep: async (ms) => void slept.push(ms) });
  const out = await client.children("root");
  ok(slept.length === 1 && slept[0] === 2000, "backoff: the honoured delay is the exact Retry-After value (2 s)");
  ok(calls === 2, "backoff: the children GET is repeated until Notion accepts it");
  ok(Array.isArray(out) && out.length === 0, "backoff: the eventual (empty) result is returned once the 429 clears");
}
{
  let calls = 0;
  const forbidden: HttpFetch = async () => {
    calls++;
    return { ok: false, status: 403, text: async () => "forbidden", json: async () => ({}) } as never;
  };
  const slept: number[] = [];
  const client = new NotionClient("tok", forbidden, "https://api.notion.com", undefined, { sleep: async (ms) => void slept.push(ms) });
  try {
    await client.children("root");
    ok(false, "backoff negative control: a 403 must throw");
  } catch (err) {
    ok(err instanceof Error && String(err.message).includes("403"), "backoff negative control: the 403 propagates as the plain read error");
  }
  ok(calls === 1, "backoff negative control: a 403 is requested EXACTLY once");
  ok(slept.length === 0, "backoff negative control: zero sleeps");
}
{
  const headers = new Headers();
  headers.set("retry-after", "1");
  const alwaysLimited: HttpFetch = async () => ({ ok: false, status: 429, headers, text: async () => "rate limited", json: async () => ({}) }) as never;
  const slept: number[] = [];
  const client = new NotionClient("tok", alwaysLimited, "https://api.notion.com", undefined, { sleep: async (ms) => void slept.push(ms) });
  let caught: unknown;
  try {
    await client.children("root");
  } catch (err) {
    caught = err;
  }
  ok(caught instanceof RateLimitExhaustedError, "backoff exhaustion: the NAMED RateLimitExhaustedError");
  ok((caught as RateLimitExhaustedError).surface === "notion", "backoff exhaustion: the surface names notion");
  ok((caught as RateLimitExhaustedError).operation === "blocks.children.list", "backoff exhaustion: the operation is the vendor route name");
  ok(slept.length === 3 && slept.every((ms) => ms === 1000), "backoff exhaustion: three waits under the shared default");
}

{
  ok(contentLines("a\n\n  b  \n") .join("|") === "a|  b", "contentLines: blanks dropped, trailing space trimmed, indent kept");

  const shapes = ["# H1", "## H2", "### H3", "- bullet", "- [ ] todo", "- [x] done", "1. first", "> quoted", "---", "plain text", "  nested"];
  const blocks = blocksFromMarkdown(shapes);
  const types = blocks.map((b) => b.type);
  ok(
    types.join(",") === "heading_1,heading_2,heading_3,bulleted_list_item,to_do,to_do,numbered_list_item,quote,divider,paragraph,paragraph",
    "blocksFromMarkdown: each markdown shape maps to its Notion block type",
  );
  ok((blocks[5].to_do as { checked: boolean }).checked === true, "blocksFromMarkdown: `- [x]` sets checked");
  ok((blocks[4].to_do as { checked: boolean }).checked === false, "blocksFromMarkdown: `- [ ]` leaves it unchecked");
  ok(blocks.every((b) => b.object === "block"), "blocksFromMarkdown: every block carries Notion's `object: \"block\"`");

  const lead: BlockNode = { type: "paragraph", paragraph: { rich_text: [{ plain_text: "existing" }] } };
  const roundTrip = contentLines(renderBlocks([lead, ...blocks])).slice(1);
  ok(roundTrip.join("\n") === shapes.join("\n"), "blocksFromMarkdown: the blocks render back to the same markdown");
  ok(roundTrip[10] === "  nested", "blocksFromMarkdown: an indented line survives the round trip");

  const capital = blocksFromMarkdown(["- [X] shouty"]);
  ok(capital[0].type === "bulleted_list_item", "blocksFromMarkdown: `- [X]` is not coerced into a to_do");
  ok(contentLines(renderBlocks(capital))[0] === "- [X] shouty", "blocksFromMarkdown: …and `- [X]` reads back verbatim");

  const long = "z".repeat(4500);
  const chunked = blocksFromMarkdown([long]);
  ok((chunked[0].paragraph as { rich_text: unknown[] }).rich_text.length === 3, "blocksFromMarkdown: a >2000-char line splits into three rich_text objects");
  ok(contentLines(renderBlocks(chunked))[0] === long, "blocksFromMarkdown: the split line reads back whole");

  try {
    blocksFromMarkdown(["# H", ""]);
    ok(false, "blocksFromMarkdown must refuse a line it cannot store");
  } catch (err) {
    ok(err instanceof Error && err.message.includes("cannot be stored as a Notion block"), "blocksFromMarkdown: an unstorable line THROWS (round-trip guard fires)");
  }
}

function makeNotion(store: Record<string, BlockNode[]>) {
  const appends: { id: string; children: BlockNode[] }[] = [];
  let gets = 0;
  const fetchFn: HttpFetch = async (url, init) => {
    const m = url.match(/\/v1\/blocks\/([^/?]+)\/children/);
    const id = m ? m[1] : "";
    if (init.method === "PATCH") {
      const body = JSON.parse(init.body ?? "{}") as { children: BlockNode[] };
      appends.push({ id, children: body.children });
      (store[id] ??= []).push(...body.children);
      return { ok: true, status: 200, text: async () => "", json: async () => ({ results: body.children }) };
    }
    gets++;
    return { ok: true, status: 200, text: async () => "", json: async () => ({ results: store[id] ?? [], has_more: false, next_cursor: null }) };
  };
  return { fetchFn, appends, gets: () => gets };
}

const WRITABLE = { name: "brain", provider: "notion", container: "wroot" };

{
  const store: Record<string, BlockNode[]> = {
    wroot: [
      { type: "heading_1", id: "wh", heading_1: { rich_text: [{ plain_text: "Brain" }] } },
      { type: "child_page", id: "wsub", has_children: true, child_page: { title: "Decisions" } },
    ],
    wsub: [{ type: "paragraph", id: "wsp", paragraph: { rich_text: [{ plain_text: "kept" }] } }],
  };
  const notion = makeNotion(store);
  const writable = makeNotionProvider({ client: () => new NotionClient("tok", notion.fetchFn) });

  const before = await writable.readTier(p, TIER, WRITABLE);
  ok(before["MEMORY.md"] === "# Brain\n", "write: precondition — the root page renders to just its heading");

  const version = await writable.writeTier(p, TIER, { "MEMORY.md": "# Brain\n- learned: the deploy needs Node 24\n" }, "session s1", WRITABLE);
  ok(typeof version === "string" && version.length > 0, "write: an append returns a version token (so hooks/memory.ts audits a memory.write row)");
  ok(notion.appends.length === 1 && notion.appends[0].id === "wroot", "write: exactly one append, to the page the file key names");
  ok(notion.appends[0].children.length === 1, "write: ONLY the added line is appended, never the whole file");
  ok(notion.appends[0].children[0].type === "bulleted_list_item", "write: the added line is stored as its own typed block");

  const after = await writable.readTier(p, TIER, WRITABLE);
  ok(after["MEMORY.md"] === "# Brain\n- learned: the deploy needs Node 24\n", "write: a later read returns the appended line — the write LANDED and the stale cache was dropped");

  const again = await writable.writeTier(p, TIER, { "MEMORY.md": after["MEMORY.md"] }, "session s2", WRITABLE);
  ok(again === null, "write: unchanged content returns null (the provider contract's no-op)");
  ok(notion.appends.length === 1, "write: …and dispatches no second append");

  await writable.writeTier(p, TIER, { "Decisions.md": "kept\n- [x] shipped\n" }, "session s3", WRITABLE);
  ok(notion.appends.length === 2 && notion.appends[1].id === "wsub", "write: a child page's file key appends to THAT page");
  ok(notion.appends[1].children[0].type === "to_do", "write: the child page's added to-do lands as a to_do block");
}

{
  const store: Record<string, BlockNode[]> = { wroot: [{ type: "paragraph", id: "wp", paragraph: { rich_text: [{ plain_text: "hi" }] } }] };
  const notion = makeNotion(store);
  const writable = makeNotionProvider({ client: () => new NotionClient("tok", notion.fetchFn) });
  try {
    await writable.writeTier(p, TIER, { "Invented.md": "hi\n- new\n" }, "s", WRITABLE);
    ok(false, "a write to a file with no Notion page must throw");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ok(msg.includes("no Notion page for \"Invented.md\""), "refusal: an unknown file key names itself");
    ok(msg.includes("NOTHING was saved, including the other file(s)"), "refusal: …and says the WHOLE tier is refused, not just this file");
    ok(msg.includes("RECURRING.md") && msg.includes(".conflict-") && msg.includes(".rejected-"), "refusal: …and names the three host-minted shapes that can never map to a page");
  }
  ok(notion.appends.length === 0, "refusal: no append was dispatched");
}

{
  const store: Record<string, BlockNode[]> = {
    wroot: [
      { type: "paragraph", id: "w1", paragraph: { rich_text: [{ plain_text: "first" }] } },
      { type: "paragraph", id: "w2", paragraph: { rich_text: [{ plain_text: "second" }] } },
    ],
  };
  const notion = makeNotion(store);
  const writable = makeNotionProvider({ client: () => new NotionClient("tok", notion.fetchFn) });
  try {
    await writable.writeTier(p, TIER, { "MEMORY.md": "first\nEDITED\nthird\n" }, "s", WRITABLE);
    ok(false, "an edit above the tail must throw");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ok(msg.includes("changed at line 2"), "refusal: the edit refusal names the diverging line");
    ok(msg.includes("APPEND-ONLY"), "refusal: …and says why it cannot be expressed");
  }
  ok(notion.appends.length === 0, "refusal: an un-expressible edit dispatches NO partial append");

  const added = await writable.writeTier(p, TIER, { "MEMORY.md": "first\nsecond\nthird\n" }, "s", WRITABLE);
  ok(typeof added === "string", "refusal negative control: a pure append past the same prefix IS accepted");
  ok(notion.appends.length === 1 && notion.appends[0].children.length === 1, "refusal negative control: …and appends exactly the one new line");

  try {
    await writable.writeTier(p, TIER, { "MEMORY.md": "first\n" }, "s", WRITABLE);
    ok(false, "a deletion must throw");
  } catch (err) {
    ok(err instanceof Error && err.message.includes("APPEND-ONLY"), "refusal: a deletion is refused, not silently kept");
  }
}

{
  const store: Record<string, BlockNode[]> = { wroot: [{ type: "paragraph", id: "wp", paragraph: { rich_text: [{ plain_text: "one" }] } }] };
  let patches = 0;
  const failing: HttpFetch = async (url, init) => {
    const id = url.match(/\/v1\/blocks\/([^/?]+)\/children/)?.[1] ?? "";
    if (init.method === "PATCH") {
      patches++;
      return { ok: false, status: 500, text: async () => "notion is down", json: async () => ({}) };
    }
    return { ok: true, status: 200, text: async () => "", json: async () => ({ results: store[id] ?? [], has_more: false, next_cursor: null }) };
  };
  const writable = makeNotionProvider({ client: () => new NotionClient("tok", failing) });
  try {
    await writable.writeTier(p, TIER, { "MEMORY.md": "one\ntwo\n" }, "s", WRITABLE);
    ok(false, "an append that Notion rejects must throw");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ok(msg.includes("500"), "failed append: the vendor status propagates");
    ok(msg.includes("connector-credentials.ts"), "failed append: the error names where an endpoint refusal is fixed");
  }
  ok(patches === 1, "failed append: precondition — the PATCH was attempted");
  store.wroot.push({ type: "paragraph", id: "wp2", paragraph: { rich_text: [{ plain_text: "landed" }] } });
  const after = await writable.readTier(p, TIER, WRITABLE);
  ok(after["MEMORY.md"].includes("landed"), "failed append: the cache was dropped BEFORE the first append, so a later read re-pulls");
}

{
  const notion = makeNotion({ wroot: [] });
  const writable = makeNotionProvider({ client: () => new NotionClient("tok", notion.fetchFn) });
  try {
    await writable.deleteTier(p, TIER, WRITABLE);
    ok(false, "deleteTier on a writable notion silo must throw");
  } catch (err) {
    ok(err instanceof Error && err.message.includes("NOTHING was erased"), "deleteTier: a writable silo refuses loudly (a purge must never no-op silently)");
  }
}

{
  let reached = 0;
  const counting: HttpFetch = async () => {
    reached++;
    return { ok: true, status: 200, text: async () => "", json: async () => ({}) };
  };
  const fenced = new NotionClient("tok", counting, "https://api.notion.com", {
    hosts: ["api.notion.com"],
    pathPrefixes: ["/v1/blocks/"],
    methods: ["GET"],
  });
  try {
    await fenced.appendChildren("wroot", blocksFromMarkdown(["- x"]));
    ok(false, "a GET-only credential must refuse the append");
  } catch {
    ok(true, "endpoint fence: a GET-only credential refuses the block-append PATCH");
  }
  ok(reached === 0, "endpoint fence: the refusal happens BEFORE the request is dispatched");
}

{
  const notion = makeNotion({
    croot: [
      { type: "paragraph", id: "cp", paragraph: { rich_text: [{ plain_text: "root" }] } },
      { type: "child_page", id: "csub", has_children: true, child_page: { title: "Child" } },
    ],
    csub: [{ type: "paragraph", id: "cs", paragraph: { rich_text: [{ plain_text: "child" }] } }],
  });
  const shared = makeNotionProvider({ client: () => new NotionClient("tok", notion.fetchFn) });
  const wide = await shared.readTier(p, TIER, { name: "wide", provider: "notion", container: "croot", readOnly: true });
  ok("Child.md" in wide, "cache key: precondition — the recursive silo pulls the child page");
  const narrow = await shared.readTier(p, TIER, { name: "narrow", provider: "notion", container: "croot", readOnly: true, recursive: false });
  ok(!("Child.md" in narrow), "cache key: a `recursive: false` silo on the SAME page is not served the recursive silo's files");
}

console.log(`✓ notion-memory: ${passed} assertions passed (blocks↔MD codec + recursive pull + append write-back, offline fake)`);
