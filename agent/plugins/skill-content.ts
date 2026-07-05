import type { SkillPackageDefinition } from "eve/skills";

const NOTION_SCRIPT = `#!/usr/bin/env node
// GENERATED skill script — "notion-rest" (agent/plugins/skill-content.ts). Self-contained:
// Node built-ins only, no @open-everywhere/* imports (this file runs inside the sandbox,
// copied in isolation — see the skill-content.ts header for why).
//
// Usage:
//   node scripts/notion.mjs search <query...>
//   node scripts/notion.mjs page <page-id>
//   node scripts/notion.mjs children <block-or-page-id>
//   node scripts/notion.mjs append <block-or-page-id> <text...>
//
// No token is read, held, or passed anywhere in this file. Every fetch() call below goes
// to api.notion.com in the plain, unauthenticated shape; the sandbox EGRESS FIREWALL
// stamps the real Authorization header on the way out (see agent/access/bundles.ts,
// bundle "notion-connectors", connection id "notion-rest"). A 401 means the secret isn't
// configured — that is a config problem to report, not a token to go looking for.

const NOTION_VERSION = "2022-06-28";
const API = "https://api.notion.com";

function plainText(rich) {
  return (rich ?? []).map((t) => t.plain_text ?? "").join("");
}

// A page or database's title lives in whichever property has type "title" (pages), or a
// top-level "title" rich_text array (databases) — there is no fixed property name.
export function titleOf(pageOrDb) {
  const props = pageOrDb.properties ?? {};
  for (const key of Object.keys(props)) {
    const p = props[key];
    if (p && p.type === "title" && Array.isArray(p.title)) {
      const t = plainText(p.title);
      return t.length > 0 ? t : "(untitled)";
    }
  }
  if (Array.isArray(pageOrDb.title)) {
    const t = plainText(pageOrDb.title);
    if (t.length > 0) return t;
  }
  return "(untitled)";
}

// Reduction stage for /v1/search: a short list, never the raw JSON blob (that's the
// whole point of a skill script over a generated tool — see docs/capabilities/
// connectors-and-providers.md "MCP vs REST").
export function formatSearchResults(json) {
  const results = json.results ?? [];
  if (results.length === 0) return "No results.";
  return results.map((r) => "- " + titleOf(r) + "  (" + r.object + " " + r.id + ")").join("\\n");
}

function renderBlockPlain(b) {
  const body = b[b.type] ?? {};
  switch (b.type) {
    case "paragraph":
      return plainText(body.rich_text);
    case "heading_1":
      return "# " + plainText(body.rich_text);
    case "heading_2":
      return "## " + plainText(body.rich_text);
    case "heading_3":
      return "### " + plainText(body.rich_text);
    case "bulleted_list_item":
      return "- " + plainText(body.rich_text);
    case "numbered_list_item":
      return "1. " + plainText(body.rich_text);
    case "to_do":
      return "- [" + (body.checked ? "x" : " ") + "] " + plainText(body.rich_text);
    case "quote":
      return "> " + plainText(body.rich_text);
    case "code":
      // Bracket-fenced rather than triple-backtick: this string is itself embedded in an
      // outer TS template literal (skill-content.ts) — backticks there would need fiddly
      // escaping for no real benefit (plain-text reduction, not rendered markdown).
      return "[code]\\n" + plainText(body.rich_text) + "\\n[/code]";
    case "child_page":
      return "[page] " + (body.title ?? "(untitled)") + " (id " + b.id + ")";
    default:
      // Never silently drop an unrendered type — a typed placeholder beats losing it.
      return "[" + b.type + "] (id " + b.id + ")";
  }
}

// Reduction stage for /v1/blocks/:id/children — ONE level of children rendered as plain
// text/markdown. Deliberately not recursive (that's the read-only memory hot-cache's job,
// docs/capabilities/memory.md "Notion hot-cache") — this is for a live, targeted read;
// call again with a child's id to go deeper.
export function formatBlocks(json) {
  const results = json.results ?? [];
  if (results.length === 0) return "(no content)";
  return results.map(renderBlockPlain).filter(Boolean).join("\\n");
}

// Builds the append request (one paragraph block, appended — never a rewrite/delete) as
// data so it's independently testable without a network call.
export function buildAppendRequest(blockId, text) {
  return {
    method: "PATCH",
    path: "/v1/blocks/" + blockId + "/children",
    body: { children: [{ object: "block", type: "paragraph", paragraph: { rich_text: [{ type: "text", text: { content: text } }] } }] },
  };
}

async function call(method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: { "Notion-Version": NOTION_VERSION, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    throw new Error("Notion API " + method + " " + path + " -> " + res.status + ": " + (json && json.message ? json.message : text));
  }
  return json;
}

export async function main(argv) {
  const [op, ...rest] = argv;
  if (op === "search") {
    const json = await call("POST", "/v1/search", rest.length ? { query: rest.join(" ") } : {});
    console.log(formatSearchResults(json));
    return;
  }
  if (op === "page") {
    const [id] = rest;
    if (!id) throw new Error("usage: node notion.mjs page <page-id>");
    const json = await call("GET", "/v1/pages/" + id);
    console.log("# " + titleOf(json) + "\\n(page " + json.id + ", last edited " + json.last_edited_time + ")");
    return;
  }
  if (op === "children") {
    const [id] = rest;
    if (!id) throw new Error("usage: node notion.mjs children <block-or-page-id>");
    const json = await call("GET", "/v1/blocks/" + id + "/children?page_size=100");
    console.log(formatBlocks(json));
    return;
  }
  if (op === "append") {
    const [id, ...textParts] = rest;
    const text = textParts.join(" ");
    if (!id || !text) throw new Error("usage: node notion.mjs append <block-or-page-id> <text...>");
    const { method, path, body } = buildAppendRequest(id, text);
    await call(method, path, body);
    console.log("Appended a paragraph to " + id + ".");
    return;
  }
  throw new Error('unknown op "' + (op ?? "") + '" — expected search | page | children | append');
}

// Only run the CLI when this file is the process entry point — importing it (as the
// test suite does, to exercise the exported pure functions against a mocked fetch)
// must NOT trigger a real network call.
const isMain = typeof process !== "undefined" && process.argv[1] && import.meta.url === "file://" + process.argv[1];
if (isMain) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(String((err && err.message) || err));
    process.exit(1);
  });
}
`;

const NOTION_SKILL_MARKDOWN = `# Notion (REST) — direct API access

Use this when you need to search, read, or write Notion and either this session has no
"notion" MCP connector granted, or you were explicitly asked to exercise the REST/egress
route rather than MCP — both reach the SAME Notion workspace through the SAME
integration token; this is a different transport/plane, not a different integration
(see docs/capabilities/connectors-and-providers.md "MCP vs REST").

This is the skill-wraps-script pattern (docs/capabilities/skills-and-plugins.md): the
script under \`scripts/notion.mjs\` does the actual HTTP call and is also the REDUCTION
stage — it prints short plain text, never the raw JSON a bulk API response would dump
into your context.

You never see or handle a token. \`fetch()\` calls in the script go straight to
\`api.notion.com\`; the sandbox's egress firewall stamps \`Authorization: Bearer <token>\`
onto every request to that host before it leaves the sandbox (see
agent/access/bundles.ts, the "notion-connectors" bundle's "notion-rest" connection). If a
call fails with 401, that's a missing/misconfigured NOTION_API_KEY — say so plainly;
never fabricate a token or ask the human to paste one into the chat.

## Workflow

1. **Search** — \`node scripts/notion.mjs search <query...>\` — free-text search across
   pages/databases the integration can see. Prints \`- title  (object id)\` per result.
2. **Read a page's properties** — \`node scripts/notion.mjs page <page-id>\` — the page's
   title and last-edited time.
3. **Read a page/block's content** — \`node scripts/notion.mjs children <block-or-page-id>\`
   — ONE level of children rendered as plain text/markdown (headings, lists, to-dos,
   quotes, code, nested pages shown as \`[page] title (id …)\`). Call again with a child's
   id to go deeper — this is a live, targeted read, not a recursive pull (that's the
   read-only memory hot-cache's job; see docs/capabilities/memory.md "Notion hot-cache").
4. **Append a note** — \`node scripts/notion.mjs append <block-or-page-id> <text...>\` —
   appends exactly ONE paragraph block under the given block/page. Never rewrites or
   deletes existing content; if you need something richer than a plain-text paragraph
   (a nested list, a full new page), say what's needed rather than approximating badly.

## Notes

- A page/block id is the id segment in its Notion URL.
- \`Notion-Version: 2022-06-28\` is a fixed, non-secret header the script sets on every
  call — nothing to configure.
- This skill and the "notion" MCP connector are two DIFFERENT ways to reach the same
  workspace; which one (or both) a channel has depends on that channel's access bundle.
  Check what you actually have (e.g. \`list_skills\`) rather than assuming.
`;

export const SKILL_CONTENT: Record<string, SkillPackageDefinition> = {
  "notion-rest": {
    description:
      "Search, read, and append to Notion over its REST API directly (no MCP tool set) — " +
      "use for a live, targeted read/write, or when explicitly asked to exercise the " +
      "REST/egress route rather than the notion MCP connector.",
    markdown: NOTION_SKILL_MARKDOWN,
    files: {
      "scripts/notion.mjs": NOTION_SCRIPT,
    },
  },
};

export const NOTION_SCRIPT_SOURCE = NOTION_SCRIPT;
