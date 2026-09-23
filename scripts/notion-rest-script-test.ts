import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { withPatchedFetch } from "../packages/core/scripts/_fetch-test-utils.js";
import { SKILL_CONTENT } from "../agent/plugins/skill-content.js";
import { NOTION_SCRIPT_SOURCE, NOTION_REFERENCE_SOURCE, notionRestSessionFiles } from "../agent/plugins/notion-rest.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}
function eq(actual: unknown, expected: unknown, label: string): void {
  ok(JSON.stringify(actual) === JSON.stringify(expected), `${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

type Block = { object?: string; type: string; id?: string; children?: Block[] } & Record<string, unknown>;

function bodyOf<T>(block: Block): T {
  return block[block.type] as T;
}
type Run = { type: string; text: { content: string; link?: { url: string } }; annotations?: Record<string, boolean>; plain_text?: string; href?: string };
type Plan = { op: string; method: string; path: string; body?: Record<string, unknown>; all?: boolean; raw?: boolean; depth?: number; extraBlocks?: Block[][]; sets?: { name: string; raw: string }[] };

interface NotionScript {
  markdownToBlocks(markdown: string): Block[];
  blocksToMarkdown(blocks: Block[], depth?: number): string;
  richText(text: string): Run[];
  richTextToMarkdown(rich: unknown[]): string;
  codeLanguage(info: string): string;
  chunkBlocks(blocks: Block[], size?: number): Block[][];
  titleOf(pageOrDb: unknown): string;
  formatSearchResults(json: unknown): string;
  formatBlocks(json: unknown): string;
  formatRows(json: unknown): string;
  buildAppendRequest(blockId: string, markdown: string): { method: string; path: string; body: { children: Block[] }; extraBlocks: Block[][] };
  propertyValue(type: string, raw: string): Record<string, unknown>;
  propertiesFromSets(schema: unknown, sets: { name: string; raw: string }[]): Record<string, unknown>;
  parseSets(values: unknown): { name: string; raw: string }[];
  parseArgs(argv: string[]): { positional: string[]; flags: Record<string, unknown> };
  planCommand(argv: string[], opts?: { currentPageFile?: string }): Plan;
  currentPageId(opts?: { currentPageFile?: string }): string;
  NOT_ON_A_PAGE: string;
  retryAfterMs(header: string | null, attempt: number): number;
  withCursor(method: string, path: string, body: unknown, cursor: string | null): { path: string; body: unknown };
  call(method: string, path: string, body?: unknown, opts?: unknown): Promise<Record<string, unknown>>;
  callAll(method: string, path: string, body?: unknown, opts?: unknown): Promise<{ results: unknown[]; pages: number; has_more: boolean; next_cursor: string | null }>;
  runPlan(plan: Plan, opts?: unknown): Promise<void>;
  errorReport(err: unknown): { error: { status: number | null; code: string; message: string; hint?: string } };
}

const shipped = SKILL_CONTENT["notion-rest"];
ok(shipped !== undefined, "the registry ships a 'notion-rest' package");
eq(Object.keys(shipped.files ?? {}).sort(), ["reference.md", "scripts/notion.mjs"], "the package ships the script AND the reference beside it");
ok(shipped.files?.["reference.md"] === NOTION_REFERENCE_SOURCE, "reference.md ships the exact reference source");
ok(shipped.files?.["scripts/notion.mjs"] === NOTION_SCRIPT_SOURCE, "scripts/notion.mjs ships the exact script source");

for (const heading of ["## Pagination", "## Rate limits", "## Composite verbs", "## Block and rich-text schemas", "## Property values for database rows", "## Failure modes"]) {
  ok(NOTION_REFERENCE_SOURCE.includes(heading), `reference.md carries the "${heading}" section`);
}
for (const verb of ["### search", "### page", "### blocks", "### db", "### comments", "### users"]) {
  ok(NOTION_REFERENCE_SOURCE.includes(verb), `reference.md documents ${verb.replace("### ", "")} with its own example`);
}
const BRIEF_ID_RULE = "Use `current` for the page this conversation is on even when the caller's brief names an id: the caller cannot see the page id, and an id that looks like a message id is not a page. Use an explicit id only for a DIFFERENT page the person named.";
const flat = (text: string) => text.replace(/\s+/g, " ");
ok(flat(NOTION_REFERENCE_SOURCE).includes(BRIEF_ID_RULE), "OPE-2087: reference.md says to use current even when the caller's brief names an id");
ok(flat(shipped.markdown ?? "").includes(BRIEF_ID_RULE), "OPE-2087: SKILL.md says to use current even when the caller's brief names an id");
ok(NOTION_REFERENCE_SOURCE.includes("nobody shared it with the integration"), "reference.md names the 404 failure mode (the object is not shared with the integration)");
ok(NOTION_REFERENCE_SOURCE.includes("`401`"), "reference.md names the 401 failure mode (the credential is not stamped)");

const markdown = shipped.markdown;
for (const gone of ["no\n\"notion\" MCP connector granted", "rather than the notion MCP connector", "prefer the", "fallback"]) {
  ok(!markdown.includes(gone), `the skill markdown no longer says "${gone}"`);
}
ok(!/only when[^.]*connector/i.test(markdown), "the skill markdown carries no 'use this only when … connector' precondition");
ok(markdown.includes("DOMAIN's road"), "the skill markdown states that this skill is the domain's road");
ok(/PERSON's road/.test(markdown) && /OAuth/.test(markdown), "the skill markdown states that an MCP connector is a person's own account");
ok(markdown.includes("Never fabricate a token"), "the skill markdown forbids fabricating or asking for a token");
ok(markdown.includes("declared egress"), "the skill markdown states that the declared egress decides which verbs work");
ok(markdown.includes("reference.md"), "the skill markdown points at reference.md");

const tmp = mkdtempSync(join(tmpdir(), "open-everywhere-notion-script-"));
const scriptPath = join(tmp, "notion.mjs");
writeFileSync(scriptPath, NOTION_SCRIPT_SOURCE, "utf-8");

let importCalls = 0;
const notion = await withPatchedFetch(
  async (...args: unknown[]) => {
    importCalls++;
    throw new Error(`unexpected network call during import: ${JSON.stringify(args)}`);
  },
  () => import(pathToFileURL(scriptPath).href) as Promise<NotionScript>,
);
rmSync(tmp, { recursive: true, force: true });
ok(importCalls === 0, "importing the skill script fires no network call (the isMain guard holds)");

const FIXTURE_MARKDOWN = [
  "# Runbook",
  "",
  "Restart the **worker** when the *queue* backs up; see `docs/ops.md` and the",
  "[dashboard](https://dash.test/q).",
  "",
  "Watch snake_case_name, a \\* star, a \\[bracket\\] and a \\\\ backslash.",
  "",
  "## Steps",
  "",
  "- drain the queue",
  "  - wait for zero in-flight",
  "- [ ] restart the worker",
  "- [x] confirm the backlog fell",
  "",
  "1. page the owner",
  "2. write the incident note",
  "",
  "> Never restart during a deploy.",
  "> Wait for the deploy to finish.",
  "",
  "```ts",
  "const queue = await drain();",
  "```",
  "",
  "---",
  "",
  "Done.",
].join("\n");

const fixtureBlocks = notion.markdownToBlocks(FIXTURE_MARKDOWN);
eq(
  fixtureBlocks.map((b) => b.type),
  ["heading_1", "paragraph", "paragraph", "heading_2", "bulleted_list_item", "to_do", "to_do", "numbered_list_item", "numbered_list_item", "quote", "code", "divider", "paragraph"],
  "markdownToBlocks: every construct maps to its Notion block type, in document order",
);
ok(fixtureBlocks.every((b) => b.object === "block" && b[b.type] !== undefined), "markdownToBlocks: every block carries object:'block' and a body under its own type key");

const intro = bodyOf<{ rich_text: Run[] }>(fixtureBlocks[1]).rich_text;
eq(intro.map((r) => r.text.content), ["Restart the ", "worker", " when the ", "queue", " backs up; see ", "docs/ops.md", " and the ", "dashboard", "."], "markdownToBlocks: a soft-wrapped paragraph joins into one block, split into inline runs");
eq(intro[1].annotations, { bold: true }, "markdownToBlocks: **bold** becomes a bold annotation");
eq(intro[3].annotations, { italic: true }, "markdownToBlocks: *italic* becomes an italic annotation");
eq(intro[5].annotations, { code: true }, "markdownToBlocks: `code` becomes a code annotation");
eq(intro[7].text.link, { url: "https://dash.test/q" }, "markdownToBlocks: [label](url) becomes a link on the label's run");

const escaped = bodyOf<{ rich_text: Run[] }>(fixtureBlocks[2]).rich_text;
eq(escaped.map((r) => r.text.content), ["Watch snake_case_name, a * star, a [bracket] and a \\ backslash."], "markdownToBlocks: a backslash escape becomes the literal character, inside one run");
eq(escaped[0].annotations, undefined, "markdownToBlocks: an escaped '*' opens no emphasis");
eq(notion.richTextToMarkdown([{ plain_text: "a * star and snake_case_name" }]), "a \\* star and snake_case_name", "richTextToMarkdown: a '*' is escaped on the way out, an underscore inside a word is not");
eq(notion.richTextToMarkdown([{ plain_text: "an _emphasis_ marker" }]), "an \\_emphasis\\_ marker", "richTextToMarkdown: an underscore at a word edge IS escaped, because the writer reads it as emphasis");

const nested = bodyOf<{ children?: Block[] }>(fixtureBlocks[4]);
ok(nested.children?.length === 1 && nested.children[0].type === "bulleted_list_item", "markdownToBlocks: an indented list line becomes the previous item's child");
eq(bodyOf<{ checked: boolean }>(fixtureBlocks[5]).checked, false, "markdownToBlocks: '- [ ]' is an unchecked to_do");
eq(bodyOf<{ checked: boolean }>(fixtureBlocks[6]).checked, true, "markdownToBlocks: '- [x]' is a checked to_do");
eq(bodyOf<{ rich_text: Run[] }>(fixtureBlocks[9]).rich_text[0].text.content, "Never restart during a deploy.\nWait for the deploy to finish.", "markdownToBlocks: consecutive '>' lines merge into one quote block");
const code = bodyOf<{ language: string; rich_text: Run[] }>(fixtureBlocks[10]);
eq(code.language, "typescript", "markdownToBlocks: a 'ts' fence maps to Notion's 'typescript'");
eq(code.rich_text[0].text.content, "const queue = await drain();", "markdownToBlocks: the fence body is kept verbatim, unparsed");
eq(fixtureBlocks[11].divider, {}, "markdownToBlocks: '---' is a divider");

eq(notion.codeLanguage("py"), "python", "codeLanguage: a short spelling maps to Notion's own name");
eq(notion.codeLanguage(""), "plain text", "codeLanguage: a bare fence is plain text");
eq(notion.codeLanguage("brainfuck"), "plain text", "codeLanguage: a language Notion does not know degrades to plain text, never an error");

eq(notion.richText("call snake_case_name now").map((r) => r.text.content), ["call snake_case_name now"], "richText: an underscore inside a word is not italic");
eq(notion.richText("a _real_ emphasis").map((r) => r.annotations?.italic === true), [false, true, false], "richText: _italic_ at word edges is emphasis");

const longRun = bodyOf<{ rich_text: Run[] }>(notion.markdownToBlocks("x".repeat(2500))[0]);
eq(longRun.rich_text.map((r) => r.text.content.length), [2000, 500], "markdownToBlocks: a rich-text run longer than 2000 characters is split, never truncated");
const longFence = bodyOf<{ rich_text: Run[] }>(notion.markdownToBlocks("```js\n" + "x".repeat(2600) + "\n```")[0]);
eq(longFence.rich_text.map((r) => r.text.content.length), [2000, 600], "markdownToBlocks: a code fence past 2000 characters is split too — code is never truncated");
eq(longFence.rich_text.map((r) => r.text.content).join("").length, 2600, "markdownToBlocks: every character of a long fence survives");
eq(bodyOf<{ rich_text: Run[] }>(notion.markdownToBlocks("```\n```")[0]).rich_text, [], "markdownToBlocks: an empty fence carries no rich-text run");
const manyBullets = notion.markdownToBlocks(new Array(250).fill("- item").join("\n"));
eq(notion.chunkBlocks(manyBullets).map((batch) => batch.length), [100, 100, 50], "chunkBlocks: a long document is batched to Notion's 100-children limit");

const RECORDED_CHILDREN = {
  object: "list",
  results: [
    { object: "block", id: "b1", type: "heading_2", has_children: false, heading_2: { rich_text: [{ type: "text", text: { content: "Steps" }, plain_text: "Steps" }] } },
    {
      object: "block",
      id: "b2",
      type: "paragraph",
      has_children: false,
      paragraph: {
        rich_text: [
          { type: "text", text: { content: "See " }, plain_text: "See " },
          { type: "text", text: { content: "the dashboard", link: { url: "https://dash.test/q" } }, annotations: { bold: true }, plain_text: "the dashboard", href: "https://dash.test/q" },
          { type: "text", text: { content: " first." }, plain_text: " first." },
        ],
      },
    },
    { object: "block", id: "b3", type: "bulleted_list_item", has_children: false, bulleted_list_item: { rich_text: [{ type: "text", text: { content: "drain" }, plain_text: "drain" }] } },
    { object: "block", id: "b4", type: "to_do", has_children: false, to_do: { checked: true, rich_text: [{ type: "text", text: { content: "restart" }, plain_text: "restart" }] } },
    { object: "block", id: "b5", type: "code", has_children: false, code: { language: "python", rich_text: [{ type: "text", text: { content: "print(1)" }, plain_text: "print(1)" }] } },
    { object: "block", id: "b6", type: "child_page", has_children: true, child_page: { title: "Sub" } },
    { object: "block", id: "b7", type: "table_of_contents", has_children: false, table_of_contents: {} },
  ],
  has_more: false,
  next_cursor: null,
};

const rendered = notion.formatBlocks(RECORDED_CHILDREN);
eq(
  rendered,
  ["## Steps", "", "See [**the dashboard**](https://dash.test/q) first.", "", "- drain", "- [x] restart", "", "```python", "print(1)", "```", "", "[page] Sub (id b6)", "", "[table_of_contents] (id b7)"].join("\n"),
  "blocksToMarkdown: a recorded children response renders back to markdown, annotations, links and all",
);
ok(rendered.includes("[table_of_contents] (id b7)"), "blocksToMarkdown: a block type it cannot render becomes a typed placeholder, never a silent drop");
eq(notion.formatBlocks({ results: [] }), "(no content)", "formatBlocks: an empty children list says so");

const withChildren = [{ object: "block", id: "p1", type: "bulleted_list_item", bulleted_list_item: { rich_text: [{ plain_text: "outer" }] }, children: [{ object: "block", id: "c1", type: "bulleted_list_item", bulleted_list_item: { rich_text: [{ plain_text: "inner" }] } }] }];
eq(notion.blocksToMarkdown(withChildren as unknown as Block[], 0), "- outer\n  - inner", "blocksToMarkdown: a block's children render indented under it");

function asReadBack(blocks: Block[]): Block[] {
  const copy = JSON.parse(JSON.stringify(blocks)) as Block[];
  const walk = (list: Block[]): Block[] => {
    for (const b of list) {
      const body = b[b.type] as { rich_text?: Run[]; children?: Block[] } | undefined;
      if (body?.rich_text) {
        for (const run of body.rich_text) {
          run.plain_text = run.text.content;
          if (run.text.link) run.href = run.text.link.url;
        }
      }
      if (body?.children) {
        b.children = walk(body.children);
      }
    }
    return list;
  };
  return walk(copy);
}
function withoutReadBackFields(blocks: Block[]): unknown {
  return JSON.parse(JSON.stringify(blocks, (key, value) => (key === "plain_text" || key === "href" ? undefined : value)));
}

const roundTripped = notion.markdownToBlocks(notion.blocksToMarkdown(asReadBack(fixtureBlocks), 0));
eq(withoutReadBackFields(roundTripped), withoutReadBackFields(fixtureBlocks), "round trip: markdown -> blocks -> markdown -> blocks returns the same blocks");

eq(notion.withCursor("GET", "/v1/users?page_size=100", undefined, "cur1"), { path: "/v1/users?page_size=100&start_cursor=cur1", body: undefined }, "withCursor: a GET carries the cursor in the query string");
eq(notion.withCursor("GET", "/v1/users", undefined, "cur1").path, "/v1/users?start_cursor=cur1", "withCursor: a GET with no query string opens one");
eq(notion.withCursor("POST", "/v1/search", { query: "x" }, "cur1"), { path: "/v1/search", body: { query: "x", start_cursor: "cur1" } }, "withCursor: a POST carries the cursor in the body");
eq(notion.withCursor("POST", "/v1/search", { query: "x" }, null), { path: "/v1/search", body: { query: "x" } }, "withCursor: no cursor leaves the request untouched");

type Recorded = { status?: number; headers?: Record<string, string>; body: unknown };
function stubFetch(responses: Recorded[], seen: { method: string; url: string; body: string | undefined }[]): typeof fetch {
  let index = 0;
  return (async (url: unknown, init: { method: string; body?: string }) => {
    seen.push({ method: init.method, url: String(url), body: init.body });
    const recorded = responses[Math.min(index, responses.length - 1)];
    index++;
    const status = recorded.status ?? 200;
    return {
      ok: status < 400,
      status,
      headers: { get: (name: string) => (recorded.headers ?? {})[name.toLowerCase()] ?? null },
      text: async () => JSON.stringify(recorded.body),
    };
  }) as unknown as typeof fetch;
}

const getSeen: { method: string; url: string; body: string | undefined }[] = [];
const folded = await withPatchedFetch(
  stubFetch(
    [
      { body: { object: "list", results: [{ id: "u1" }], has_more: true, next_cursor: "cur1" } },
      { body: { object: "list", results: [{ id: "u2" }], has_more: true, next_cursor: "cur2" } },
      { body: { object: "list", results: [{ id: "u3" }], has_more: false, next_cursor: null } },
    ],
    getSeen,
  ),
  () => notion.callAll("GET", "/v1/users?page_size=100", undefined, {}),
);
eq(folded.results.map((r) => (r as { id: string }).id), ["u1", "u2", "u3"], "callAll: every page's results fold into one list");
eq(folded.pages, 3, "callAll: the fold reports how many pages it read");
eq(folded.has_more, false, "callAll: a fold that reached the end reports has_more false");
ok(getSeen[1].url.includes("start_cursor=cur1") && getSeen[2].url.includes("start_cursor=cur2"), "callAll: each GET follows the previous page's next_cursor");

const postSeen: { method: string; url: string; body: string | undefined }[] = [];
await withPatchedFetch(
  stubFetch(
    [
      { body: { results: [{ id: "p1" }], has_more: true, next_cursor: "curA" } },
      { body: { results: [{ id: "p2" }], has_more: false } },
    ],
    postSeen,
  ),
  () => notion.callAll("POST", "/v1/search", { query: "notes" }, {}),
);
eq(JSON.parse(postSeen[1].body ?? "{}"), { query: "notes", start_cursor: "curA" }, "callAll: a POST fold puts the cursor in the body and keeps the original query");

const cappedSeen: { method: string; url: string; body: string | undefined }[] = [];
const capped = await withPatchedFetch(
  stubFetch([{ body: { results: [{ id: "x" }], has_more: true, next_cursor: "forever" } }], cappedSeen),
  () => notion.callAll("GET", "/v1/blocks/b/children", undefined, { maxPages: 4 }),
);
eq(cappedSeen.length, 4, "callAll: the fold stops at its page cap instead of following next_cursor forever");
eq(capped.has_more, true, "callAll: a fold stopped by the cap reports has_more true, so the caller knows it is partial");

eq(notion.retryAfterMs("2", 0), 2000, "retryAfterMs: Retry-After is seconds, and it wins");
eq(notion.retryAfterMs(null, 0), 500, "retryAfterMs: no header falls back to backoff");
eq(notion.retryAfterMs("not-a-number", 3), 4000, "retryAfterMs: an unparsable header falls back to backoff, growing with the attempt");
eq(notion.retryAfterMs(null, 9), 8000, "retryAfterMs: the backoff is capped");

const retrySeen: { method: string; url: string; body: string | undefined }[] = [];
const waits: number[] = [];
const afterRetry = await withPatchedFetch(
  stubFetch(
    [
      { status: 429, headers: { "retry-after": "3" }, body: { code: "rate_limited", message: "slow down" } },
      { status: 429, headers: {}, body: { code: "rate_limited", message: "slow down" } },
      { body: { object: "list", results: [{ id: "ok" }] } },
    ],
    retrySeen,
  ),
  () => notion.call("GET", "/v1/users", undefined, { sleep: async (ms: number) => void waits.push(ms) }),
);
eq(retrySeen.length, 3, "call: a 429 is retried until the request succeeds");
eq(waits, [3000, 1000], "call: the first wait honours Retry-After, the second falls back to backoff");
eq((afterRetry.results as unknown[]).length, 1, "call: the retried request's answer is what the caller gets");

const longWaitSeen: { method: string; url: string; body: string | undefined }[] = [];
const longWaits: number[] = [];
const refusedWait = await withPatchedFetch(
  stubFetch([{ status: 429, headers: { "retry-after": "3600" }, body: { code: "rate_limited", message: "back off" } }], longWaitSeen),
  async () => {
    try {
      await notion.call("GET", "/v1/users", undefined, { sleep: async (ms: number) => void longWaits.push(ms) });
      return null;
    } catch (err) {
      return err;
    }
  },
);
eq(notion.retryAfterMs("3600", 0), 3600000, "retryAfterMs: the parser reports what the header asked for, honestly");
eq(longWaits, [], "call: a Retry-After of an hour is never slept through inside one turn");
eq(longWaitSeen.length, 1, "call: a Retry-After past the ceiling stops the retries at once");
eq(notion.errorReport(refusedWait).error.status, 429, "call: the over-long 429 surfaces as an error the caller can act on");

const exhausted = await withPatchedFetch(
  stubFetch([{ status: 429, headers: { "retry-after": "1" }, body: { code: "rate_limited", message: "too many requests" } }], []),
  async () => {
    try {
      await notion.call("GET", "/v1/users", undefined, { retries: 2, sleep: async () => {} });
      return null;
    } catch (err) {
      return err;
    }
  },
);
ok(exhausted !== null, "call: a 429 past the retry budget throws instead of returning a body");
eq(notion.errorReport(exhausted).error.status, 429, "errorReport: the exhausted 429 keeps its status");
eq(notion.errorReport(exhausted).error.code, "rate_limited", "errorReport: the exhausted 429 keeps Notion's machine code");

async function failWith(status: number, body: unknown): Promise<unknown> {
  return withPatchedFetch(stubFetch([{ status, body }], []), async () => {
    try {
      await notion.call("GET", "/v1/pages/p1", undefined, { retries: 0 });
      return null;
    } catch (err) {
      return err;
    }
  });
}

const notFound = notion.errorReport(await failWith(404, { code: "object_not_found", message: "Could not find page with ID p1" }));
eq(notFound.error.status, 404, "errorReport: a 404 reports its status");
eq(notFound.error.code, "object_not_found", "errorReport: a 404 reports Notion's code");
ok(notFound.error.message.includes("Could not find page"), "errorReport: a 404 reports Notion's own message");
ok(notFound.error.hint?.includes("not shared with this integration") === true, "errorReport: the 404 hint names the real cause — the page is not shared with the integration");

const unauthorized = notion.errorReport(await failWith(401, { code: "unauthorized", message: "API token is invalid" }));
ok(unauthorized.error.hint?.includes("does not stamp a Notion credential") === true, "errorReport: the 401 hint names the unstamped connection");
ok(unauthorized.error.hint?.includes("never a token to ask for") === true, "errorReport: the 401 hint forbids asking for a token");

eq(notion.errorReport(new Error("bad flag")).error.code, "script_error", "errorReport: a script-side failure is reported in the same shape");
eq(notion.errorReport(new Error("bad flag")).error.status, null, "errorReport: a script-side failure has no HTTP status");

eq(notion.parseArgs(["a", "--all", "--title", "T", "--depth=3"]), { positional: ["a"], flags: { all: true, title: "T", depth: "3" } }, "parseArgs: positionals, boolean flags, '--flag value' and '--flag=value' all parse");
eq(notion.parseArgs(["--set", "A=1", "--set", "B=2"]).flags.set, ["A=1", "B=2"], "parseArgs: --set repeats into a list");

function planOf(argv: string[]): Plan {
  return notion.planCommand(argv);
}

async function silently<T>(fn: () => Promise<T>): Promise<T> {
  const real = console.log;
  console.log = () => {};
  try {
    return await fn();
  } finally {
    console.log = real;
  }
}
function refusal(argv: string[]): string {
  try {
    notion.planCommand(argv);
    return "(no error)";
  } catch (err) {
    return String((err as Error).message);
  }
}

const rawGet = planOf(["api", "get", "/v1/users", "--all"]);
eq([rawGet.op, rawGet.method, rawGet.path, rawGet.all], ["api", "GET", "/v1/users", true], "plan api: a lowercase method is normalised, and --all is carried");
eq(planOf(["api", "POST", "/v1/search", "--json", '{"query":"x"}']).body, { query: "x" }, "plan api: --json is parsed into the request body");
ok(refusal(["api", "TRACE", "/v1/users"]).includes("unknown HTTP method"), "plan api: an unknown HTTP method is refused");
ok(refusal(["api", "POST", "/v1/search", "--json", "{oops"]).includes("not valid JSON"), "plan api: malformed --json is refused by name");

const search = planOf(["search", "quarterly", "plan", "--filter", "database", "--sort", "descending", "--all"]);
eq([search.op, search.method, search.path], ["search", "POST", "/v1/search"], "plan search: POSTs /v1/search");
eq(search.body, { query: "quarterly plan", filter: { property: "object", value: "database" }, sort: { direction: "descending", timestamp: "last_edited_time" } }, "plan search: query, object filter and sort are assembled");
eq(planOf(["search"]).body, {}, "plan search: a bare search sends no query, which lists everything shared");
ok(refusal(["search", "--filter", "block"]).includes('"page" or "database"'), "plan search: --filter refuses anything but page or database");

eq(planOf(["page", "get", "p1"]).path, "/v1/pages/p1", "plan page get: reads the page");
eq([planOf(["page", "markdown", "p1", "--depth", "2"]).op, planOf(["page", "markdown", "p1", "--depth", "2"]).depth], ["page.markdown", 2], "plan page markdown: carries the recursion depth");
eq(planOf(["page", "markdown", "p1"]).depth, 3, "plan page markdown: depth defaults to 3");
const created = planOf(["page", "create", "--parent", "par1", "--title", "Runbook", "--text", "# H\n\nbody"]);
eq([created.op, created.method, created.path], ["page.create", "POST", "/v1/pages"], "plan page create: POSTs /v1/pages");
eq((created.body as { parent: unknown }).parent, { type: "page_id", page_id: "par1" }, "plan page create: a page parent is sent as page_id");
eq(((created.body as { properties: { title: { title: Run[] } } }).properties.title.title)[0].text.content, "Runbook", "plan page create: --title becomes the title property");
eq(((created.body as { children: Block[] }).children).map((b) => b.type), ["heading_1", "paragraph"], "plan page create: --text becomes the page's first children batch");
eq((planOf(["page", "create", "--parent", "db1", "--parent-type", "database", "--title", "Row"]).body as { parent: unknown }).parent, { type: "database_id", database_id: "db1" }, "plan page create: --parent-type database is sent as database_id");
const longPage = planOf(["page", "create", "--parent", "par1", "--title", "Long", "--text", new Array(150).fill("- item").join("\n")]);
eq((longPage.body as { children: Block[] }).children.length, 100, "plan page create: the first batch stops at Notion's 100-children limit");
eq(longPage.extraBlocks?.[0].length, 50, "plan page create: the rest is carried as a follow-up append batch");
eq(planOf(["page", "update", "p1", "--title", "New"]).body, { properties: { title: { title: [{ type: "text", text: { content: "New" } }] } } }, "plan page update: --title becomes a properties patch");
eq(planOf(["page", "archive", "p1"]).body, { archived: true }, "plan page archive: PATCHes archived:true — no DELETE method needed");
eq(planOf(["page", "archive", "p1"]).method, "PATCH", "plan page archive: stays inside a GET/POST/PATCH egress");
ok(refusal(["page", "update", "p1"]).includes("--title, --set or --json"), "plan page update: an update with nothing to change is refused");
ok(refusal(["page", "create", "--parent", "p1", "--title", "T", "--set", "Status=Done"]).includes("--parent-type database"), "plan page create: --set without a database parent is refused");
ok(refusal(["page", "list"]).includes("unknown page op"), "plan page: an unknown sub-verb is named in the refusal");

eq(planOf(["blocks", "list", "b1", "--all"]).path, "/v1/blocks/b1/children?page_size=100", "plan blocks list: reads the children endpoint");
eq(planOf(["blocks", "list", "b1", "--depth", "4"]).depth, 4, "plan blocks list: --depth is carried for the recursive read");
const appended = planOf(["blocks", "append", "b1", "--text", "- one\n- two"]);
eq([appended.method, appended.path], ["PATCH", "/v1/blocks/b1/children"], "plan blocks append: PATCHes the children collection (append, never replace)");
eq((appended.body as { children: Block[] }).children.map((b) => b.type), ["bulleted_list_item", "bulleted_list_item"], "plan blocks append: markdown becomes Notion blocks");
eq((planOf(["blocks", "append", "b1", "a", "note"]).body as { children: Block[] }).children.length, 1, "plan blocks append: trailing words still work as plain text");
eq(planOf(["blocks", "update", "b1", "--json", '{"paragraph":{"rich_text":[]}}']).body, { paragraph: { rich_text: [] } }, "plan blocks update: --json is sent verbatim");
eq(planOf(["blocks", "update", "b1", "--text", "fixed"]).body, undefined, "plan blocks update: --text defers the body until the block's type is read");
eq(planOf(["blocks", "delete", "b1"]), { op: "blocks.delete", method: "PATCH", path: "/v1/blocks/b1", body: { archived: true }, all: false, raw: false }, "plan blocks delete: archives with a PATCH, which a GET/POST/PATCH egress allows");
ok(refusal(["blocks", "update", "b1"]).includes("--text or --json"), "plan blocks update: an update with no new content is refused");
ok(refusal(["blocks", "append"]).includes("usage:"), "plan blocks append: a missing id is refused with usage");

eq(planOf(["db", "get", "d1"]).path, "/v1/databases/d1", "plan db get: reads the schema endpoint");
const query = planOf(["db", "query", "d1", "--filter", '{"property":"Status","status":{"equals":"Done"}}', "--sorts", '[{"property":"Due","direction":"ascending"}]', "--all"]);
eq([query.method, query.path, query.all], ["POST", "/v1/databases/d1/query", true], "plan db query: POSTs the query endpoint with --all");
eq(query.body, { filter: { property: "Status", status: { equals: "Done" } }, sorts: [{ property: "Due", direction: "ascending" }] }, "plan db query: Notion's own filter and sort JSON is passed through verbatim");
eq((planOf(["db", "create", "--parent", "p1", "--title", "Incidents", "--properties", '{"Name":{"title":{}}}']).body as { properties: unknown }).properties, { Name: { title: {} } }, "plan db create: the column schema is passed through");
ok(refusal(["db", "create", "--parent", "p1", "--title", "T"]).includes("--properties"), "plan db create: a database with no columns is refused");

eq(planOf(["comments", "list", "b1"]).path, "/v1/comments?block_id=b1&page_size=100", "plan comments list: reads the comments endpoint for the block");
eq(planOf(["comments", "create", "--page", "p1", "--text", "looks right"]).body, { rich_text: [{ type: "text", text: { content: "looks right" } }], parent: { page_id: "p1" } }, "plan comments create: a page comment carries a page parent");
eq((planOf(["comments", "create", "--discussion", "d9", "--text", "reply"]).body as { discussion_id: string }).discussion_id, "d9", "plan comments create: --discussion replies in an existing thread");
eq(planOf(["users", "me"]).path, "/v1/users/me", "plan users me: reads the integration's own identity");
eq(planOf(["users", "list"]).path, "/v1/users?page_size=100", "plan users list: reads the users endpoint");
eq(planOf(["users"]).op, "users.list", "plan users: a bare 'users' lists them");

ok(refusal([]).includes("unknown verb"), "planCommand: an empty argv is refused, naming the verbs");
ok(refusal(["nope"]).includes("api | search | page | blocks | db | comments | users"), "planCommand: an unknown verb lists the real ones");
ok(refusal(["search", "--nope", "x"]).includes('unknown flag "--nope"'), "planCommand: an unknown flag is refused rather than ignored");
ok(refusal(["page", "get", "p1", "--title"]).includes("needs a value"), "planCommand: a value flag with no value is refused");
ok(refusal(["blocks", "list", "b1", "--depth", "deep"]).includes("takes a number"), "planCommand: a numeric flag given a word is refused, never read as NaN");
ok(refusal(["db", "query", "d1", "--sort", "ascending"]).includes('for "db query"'), "planCommand: --sort on db query is refused by name (it reads --sorts)");
ok(refusal(["db", "query", "d1", "--sort", "ascending"]).includes("--sorts"), "planCommand: the refusal names the flag db query does read");
ok(refusal(["search", "x", "--sorts", "[]"]).includes('for "search"'), "planCommand: --sorts on search is refused (it reads --sort)");
ok(refusal(["page", "get", "p1", "--depth", "2"]).includes('for "page get"'), "planCommand: --depth on a verb that does not read it is refused");
ok(refusal(["blocks", "append", "b1", "--text", "x", "--title", "T"]).includes('for "blocks append"'), "planCommand: an out-of-place flag is refused even when the verb is otherwise valid");
eq(planOf(["search", "x", "--page-size", "5"]).body, { query: "x", page_size: 5 }, "planCommand: a numeric flag is sent as a number");

eq(notion.parseSets(["Status=In progress"]), [{ name: "Status", raw: "In progress" }], "parseSets: the FIRST '=' splits the pair, so a value may contain one");
eq(notion.propertyValue("number", "41"), { number: 41 }, "propertyValue: a number column takes a number");
eq(notion.propertyValue("checkbox", "yes"), { checkbox: true }, "propertyValue: a checkbox reads the usual truthy spellings");
eq(notion.propertyValue("multi_select", "a, b"), { multi_select: [{ name: "a" }, { name: "b" }] }, "propertyValue: a multi-select splits on commas and trims");
eq(notion.propertyValue("date", "2026-09-19"), { date: { start: "2026-09-19" } }, "propertyValue: a date column takes an ISO start");
eq(notion.propertyValue("select", ""), { select: null }, "propertyValue: an empty value clears the property");
try {
  notion.propertyValue("number", "soon");
  ok(false, "propertyValue: a number column must refuse a word");
} catch (err) {
  ok(String((err as Error).message).includes("cannot take"), "propertyValue: a number column refuses a word instead of writing null");
}
try {
  notion.propertyValue("rollup", "x");
  ok(false, "propertyValue: a computed column must be refused");
} catch (err) {
  ok(String((err as Error).message).includes("--json"), "propertyValue: a column type --set cannot express names the way round it");
}
const schema = { Status: { type: "status" }, Owner: { type: "people" } };
eq(notion.propertiesFromSets(schema, [{ name: "Status", raw: "Done" }]), { Status: { status: { name: "Done" } } }, "propertiesFromSets: the database's schema decides the shape");
try {
  notion.propertiesFromSets(schema, [{ name: "Missing", raw: "x" }]);
  ok(false, "propertiesFromSets: a column the database does not have must be refused");
} catch (err) {
  ok(String((err as Error).message).includes("no property named"), "propertiesFromSets: a column the database does not have is refused, listing the real ones");
}

eq(notion.titleOf({ properties: { Name: { type: "title", title: [{ plain_text: "Runbook" }] } } }), "Runbook", "titleOf: reads the title-typed property whatever its name");
eq(notion.titleOf({ title: [{ plain_text: "A Database" }] }), "A Database", "titleOf: falls back to a database's bare title array");
eq(notion.titleOf({}), "(untitled)", "titleOf: falls back to (untitled)");
eq(notion.formatSearchResults({ results: [] }), "No results.", "formatSearchResults: an empty search says so");
ok(notion.formatSearchResults({ results: [{ object: "page", id: "p1", properties: { Name: { type: "title", title: [{ plain_text: "Onboarding" }] } } }] }).includes("Onboarding  (page p1)"), "formatSearchResults: one short line per hit, never the raw JSON");
eq(notion.formatRows({ results: [] }), "No rows.", "formatRows: an empty database query says so");
const backCompat = notion.buildAppendRequest("blk123", "hello");
eq([backCompat.method, backCompat.path], ["PATCH", "/v1/blocks/blk123/children"], "buildAppendRequest: appends to the block's children, never replaces them");
eq(backCompat.body.children.map((b) => b.type), ["paragraph"], "buildAppendRequest: plain text is one paragraph block");
eq(backCompat.extraBlocks, [], "buildAppendRequest: a short document needs no follow-up batch");
eq(notion.buildAppendRequest("blk123", new Array(120).fill("- item").join("\n")).extraBlocks.map((batch) => batch.length), [20], "buildAppendRequest: the overflow past 100 children becomes a follow-up batch");

const appendSeen: { method: string; url: string; body: string | undefined }[] = [];
const longAppend = planOf(["blocks", "append", "b1", "--text", new Array(230).fill("- item").join("\n")]);
await withPatchedFetch(stubFetch([{ body: { object: "list", results: [] } }], appendSeen), () => silently(() => notion.runPlan(longAppend, {})));
eq(appendSeen.length, 3, "runPlan blocks append: a 230-block document is appended in three calls");
eq(appendSeen.map((r) => JSON.parse(r.body ?? "{}").children.length), [100, 100, 30], "runPlan blocks append: each call carries at most 100 children, in document order");
ok(appendSeen.every((r) => r.method === "PATCH" && r.url === "https://api.notion.com/v1/blocks/b1/children"), "runPlan blocks append: every call is a PATCH to the same children collection");

const updateSeen: { method: string; url: string; body: string | undefined }[] = [];
await withPatchedFetch(
  stubFetch(
    [
      { body: { object: "block", id: "b1", type: "heading_2", heading_2: { rich_text: [] } } },
      { body: { object: "block", id: "b1", type: "heading_2" } },
    ],
    updateSeen,
  ),
  () => silently(() => notion.runPlan(planOf(["blocks", "update", "b1", "--text", "Corrected"]), {})),
);
eq(updateSeen.map((r) => r.method), ["GET", "PATCH"], "runPlan blocks update: --text reads the block, then patches it");
eq(JSON.parse(updateSeen[1].body ?? "{}"), { heading_2: { rich_text: [{ type: "text", text: { content: "Corrected" } }] } }, "runPlan blocks update: the patch targets the block's own type key");

const rowSeen: { method: string; url: string; body: string | undefined }[] = [];
await withPatchedFetch(
  stubFetch(
    [
      { body: { object: "database", id: "db1", properties: { Status: { type: "select" } } } },
      { body: { object: "page", id: "new1", url: "https://notion.test/new1", properties: {} } },
    ],
    rowSeen,
  ),
  () => silently(() => notion.runPlan(planOf(["page", "create", "--parent", "db1", "--parent-type", "database", "--title", "Bug 41", "--set", "Status=open"]), {})),
);
eq(rowSeen.map((r) => r.method), ["GET", "POST"], "runPlan page create --set: the database's schema is read before the row is written");
eq(JSON.parse(rowSeen[1].body ?? "{}").properties.Status, { select: { name: "open" } }, "runPlan page create --set: the column is written in the shape its declared type takes");

const printed: string[] = [];
const realLog = console.log;
console.log = (...parts: unknown[]) => void printed.push(parts.map(String).join(" "));
try {
  await withPatchedFetch(
    stubFetch([{ body: { object: "list", results: [{ id: "r1", properties: {} }], has_more: true, next_cursor: "more" } }], []),
    () => notion.runPlan(planOf(["db", "query", "d1"]), {}),
  );
} finally {
  console.log = realLog;
}
ok(printed.some((line) => line.startsWith("(partial")), "runPlan: a reduced answer with more behind it ends with a (partial …) line");
ok(printed.some((line) => line.includes("--all")), "runPlan: an unfolded page tells the caller how to get the rest");

const readSeen: { method: string; url: string; body: string | undefined }[] = [];
await withPatchedFetch(
  stubFetch(
    [
      { body: { object: "page", id: "p1", properties: { Name: { type: "title", title: [{ plain_text: "Runbook" }] } } } },
      { body: { object: "list", results: [{ object: "block", id: "b1", type: "paragraph", has_children: false, paragraph: { rich_text: [{ plain_text: "body" }] } }], has_more: false } },
    ],
    readSeen,
  ),
  () => silently(() => notion.runPlan(planOf(["page", "markdown", "p1", "--depth", "1"]), {})),
);
eq(readSeen.map((r) => r.url), ["https://api.notion.com/v1/pages/p1", "https://api.notion.com/v1/blocks/p1/children?page_size=100"], "runPlan page markdown: reads the page, then walks its children");

const headerSeen: { method: string; url: string; body: string | undefined }[] = [];
let sentHeaders: Record<string, string> = {};
await withPatchedFetch(
  (async (url: unknown, init: { method: string; headers: Record<string, string>; body?: string }) => {
    headerSeen.push({ method: init.method, url: String(url), body: init.body });
    sentHeaders = init.headers;
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => "{}" };
  }) as unknown as typeof fetch,
  () => notion.call("GET", "/v1/users/me", undefined, {}),
);
eq(Object.keys(sentHeaders).sort(), ["Notion-Version", "content-type"], "call: the script sends only the version and content-type headers — the firewall stamps the credential");
eq(sentHeaders["Notion-Version"], "2022-06-28", "call: the pinned Notion-Version goes on every request");
ok(!/Authorization\s*:/.test(NOTION_SCRIPT_SOURCE), "no code in the script sets an Authorization header, in any spelling, so it can never carry a token");
ok(!/["'][Bb]earer/.test(NOTION_SCRIPT_SOURCE), "no code in the script writes a bearer value");
ok(!/process\.env/.test(NOTION_SCRIPT_SOURCE), "the script never reads an environment variable, so it can never read a secret");

const PAGE = "40000000-0000-4000-8000-000000000105";
await import("../agent/lib/register-config.js");
const { getConfig } = await import("@open-everywhere/core/agent/access/config.js");
ok(getConfig().skillSessionFiles?.["notion-rest"] === notionRestSessionFiles, "the registered config wires notion-rest's session file to notionRestSessionFiles");
eq(notionRestSessionFiles({ platform: "notion", surface: PAGE }), { "current-page.json": `{"pageId":"${PAGE}"}\n` }, "session file: a Notion page surface writes its page id");
eq(notionRestSessionFiles({ platform: "notion", surface: PAGE.replace(/-/g, "") }), { "current-page.json": `{"pageId":"${PAGE.replace(/-/g, "")}"}\n` }, "session file: an undashed Notion id is a page id too");
eq(notionRestSessionFiles({ platform: "slack", surface: "C0123" }), { "current-page.json": '{"pageId":null}\n' }, "session file: a Slack surface never sets a page id");
eq(notionRestSessionFiles({ platform: "slack", surface: PAGE }), { "current-page.json": '{"pageId":null}\n' }, "session file: an id-shaped surface on another platform never sets a page id");
eq(notionRestSessionFiles({ platform: "notion", surface: "notion" }), { "current-page.json": '{"pageId":null}\n' }, "session file: a Notion surface that is not a page id never sets one");
eq(notionRestSessionFiles({ platform: "subagent", surface: "unresolved" }), { "current-page.json": '{"pageId":null}\n' }, "session file: an unresolved worker binding never sets a page id");

const pageDir = mkdtempSync(join(tmpdir(), "open-everywhere-notion-current-"));
try {
  const onPage = join(pageDir, "on-page.json");
  const offPage = join(pageDir, "off-page.json");
  writeFileSync(onPage, notionRestSessionFiles({ platform: "notion", surface: PAGE })["current-page.json"]);
  writeFileSync(offPage, notionRestSessionFiles({ platform: "slack", surface: "C0123" })["current-page.json"]);

  eq(notion.currentPageId({ currentPageFile: onPage }), PAGE, "currentPageId: reads the id the host wrote");
  eq(notion.planCommand(["page", "current"], { currentPageFile: onPage }).path, `/v1/pages/${PAGE}`, "planCommand page current: one GET on the page this conversation is on");
  const md = notion.planCommand(["page", "markdown", "current"], { currentPageFile: onPage });
  eq([md.op, md.path], ["page.markdown", `/v1/pages/${PAGE}`], "planCommand page markdown current: the markdown read on the resolved id");
  eq(notion.planCommand(["page", "markdown", "p1"], { currentPageFile: onPage }).path, "/v1/pages/p1", "planCommand page markdown <id>: an explicit id still wins over the current page");

  const refusedWith = (argv: string[], file: string): string => {
    try {
      notion.planCommand(argv, { currentPageFile: file });
      return "(no error)";
    } catch (err) {
      return String((err as Error).message);
    }
  };
  eq(refusedWith(["page", "current"], offPage), notion.NOT_ON_A_PAGE, "page current off a Notion page: the one plain sentence");
  eq(refusedWith(["page", "markdown", "current"], offPage), notion.NOT_ON_A_PAGE, "page markdown current off a Notion page: the same sentence");
  eq(refusedWith(["page", "current"], join(pageDir, "absent.json")), notion.NOT_ON_A_PAGE, "page current with no host file: the same sentence, never a guess");
  ok(notion.NOT_ON_A_PAGE.includes("not on a Notion page"), "the sentence says the conversation is not on a Notion page");
  try {
    notion.currentPageId({ currentPageFile: offPage });
  } catch (err) {
    eq(notion.errorReport(err).error.code, "not_on_a_notion_page", "errorReport: the refusal has its own code, never script_error");
  }

  const currentSeen: { method: string; url: string; body: string | undefined }[] = [];
  const currentPrinted: string[] = [];
  const logBefore = console.log;
  console.log = (...parts: unknown[]) => void currentPrinted.push(parts.map(String).join(" "));
  try {
    await withPatchedFetch(
      stubFetch([{ body: { object: "page", id: PAGE, url: `https://www.notion.so/${PAGE.replace(/-/g, "")}`, properties: { title: { type: "title", title: [{ plain_text: "Fixture page" }] } } } }], currentSeen),
      () => notion.runPlan(notion.planCommand(["page", "current"], { currentPageFile: onPage }), {}),
    );
  } finally {
    console.log = logBefore;
  }
  eq(currentSeen.map((r) => `${r.method} ${r.url}`), [`GET https://api.notion.com/v1/pages/${PAGE}`], "runPlan page current: exactly one GET");
  eq(JSON.parse(currentPrinted[0] ?? "{}"), { id: PAGE, title: "Fixture page", url: `https://www.notion.so/${PAGE.replace(/-/g, "")}` }, "runPlan page current: prints the id, title and url");

  const skillRoot = join(pageDir, "notion-rest");
  mkdirSync(join(skillRoot, "scripts"), { recursive: true });
  writeFileSync(join(skillRoot, "scripts", "notion.mjs"), NOTION_SCRIPT_SOURCE);
  writeFileSync(join(skillRoot, "current-page.json"), notionRestSessionFiles({ platform: "slack", surface: "C0123" })["current-page.json"]);
  const cli = spawnSync(process.execPath, ["scripts/notion.mjs", "page", "markdown", "current"], { cwd: skillRoot, encoding: "utf-8" });
  ok(cli.status !== 0, `the CLI exits non-zero off a Notion page (status ${cli.status})`);
  eq(cli.stderr.trim(), notion.NOT_ON_A_PAGE, "the CLI prints the one plain sentence, read from the default file beside the skill");
} finally {
  rmSync(pageDir, { recursive: true, force: true });
}

console.log(`✓ notion-rest-script: ${passed} assertions passed (markdown<->block round trip, pagination fold, 429 retry, structured errors, the argument grammar of every verb, the shipped package)`);
