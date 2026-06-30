import { renderBlocks, pageTitle, type BlockNode } from "../agent/notion/blocks.js";
import { NotionClient, makeNotionProvider, type HttpFetch } from "../agent/notion/memory.js";
import type { Partition } from "@open-everywhere/core/agent/memory/partition.js";
import { siloTier } from "@open-everywhere/core/agent/memory/store.js";
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
ok(pageTitle({ type: "child_page", child_page: { title: "Onboarding" } }) === "Onboarding", "codec: child_page title");

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

console.log(`✓ notion-memory: ${passed} assertions passed (blocks→MD codec + recursive read-only pull, offline fake)`);
