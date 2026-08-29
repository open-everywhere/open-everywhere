import { renderBlocks, pageTitle, type BlockNode } from "../agent/memory/blocks.js";
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

ok((await provider.writeTier(p, TIER, { "MEMORY.md": "x" }, "nope", silo)) === null, "writeTier is a no-op (read-only)");
await provider.deleteTier(p, TIER, silo);
ok(true, "deleteTier is a no-op (read-only)");

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

console.log(`✓ notion-memory: ${passed} assertions passed (blocks→MD codec + recursive read-only pull, offline fake)`);
