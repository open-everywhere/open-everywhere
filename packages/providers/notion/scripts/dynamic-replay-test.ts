import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateDynamic } from "@open-everywhere/core/agent/adapter-api.js";
import { defineDomain, registerConfig } from "@open-everywhere/core/agent/adapter-api.js";
import { registerNotionProvider } from "../agent/register.js";

delete process.env.OE_PLATFORM;

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};
const eq = (a: unknown, b: unknown, label: string) => {
  assert.deepStrictEqual(a, b, label);
  n++;
};

const notionCtx = {
  channel: { kind: "subagent", continuationToken: "subagent:sess-parent:call_1" },
  session: { id: "sess-child", auth: { current: { attributes: { oe_platform: "notion", oe_grain: "standing" } } } },
};
const WORK_WS = "ws-replay";
const WORK_PAGE = "eeeeeeee-1111-4111-8111-eeeeeeeeeeee";
registerNotionProvider();
registerConfig({
  loadDomains: () => [
    defineDomain({
      name: "replay",
      reach: [`notion/${WORK_WS}/${WORK_PAGE}`],
      credentials: [{ connector: "notion", credential: "team-key", use: "team-key" }],
    }),
  ],
  loadSilos: () => [],
  loadBundles: () => [],
  loadBindings: () => [],
  domainsForSurface: () => [],
  pluginRegistry: {},
  skillContent: {},
});
const notionWorkCtx = {
  channel: { kind: "notion" },
  session: { auth: { current: { attributes: { workspace_id: WORK_WS, page_id: WORK_PAGE }, principalId: "U_R", principalType: "notion-user" } } },
};
const CASES: readonly { slug: string; ctx: { channel: unknown; session: Record<string, unknown> } }[] = [
  { slug: "read_notion_page", ctx: notionCtx },
  { slug: "read_notion_comments", ctx: notionCtx },
  { slug: "notion_search", ctx: notionWorkCtx },
];
const SLUGS = [...new Set(CASES.map((c) => c.slug))];

const toolsDir = join(dirname(fileURLToPath(import.meta.url)), "../agent/tools");

console.log("1. source scan (one helper, closed inventory):");
{
  let scanned = 0;
  for (const f of readdirSync(toolsDir).filter((f) => f.endsWith(".ts"))) {
    const src = readFileSync(join(toolsDir, f), "utf8");
    if (!src.includes("sessionMountedTool(") && !src.includes("defineDynamic(")) continue;
    scanned++;
    const slug = f.replace(/\.ts$/, "");
    ok((SLUGS as readonly string[]).includes(slug), `${f} is a dynamic tool but has no row in this test's inventory — add the (slug, ctx) row here`);
    ok(src.includes(`export default sessionMountedTool("${slug}",`), `${f} mounts through sessionMountedTool under its own file name, so its seat decision is memoized per session`);
    ok(!src.includes("events:"), `${f} declares no eve 0.x lifecycle-event map`);
  }
  eq(scanned, SLUGS.length, `the scan saw exactly the ${SLUGS.length} inventoried dynamic tool files`);
}

console.log("2. each tool mounts on its happy-path session, and the seat stays fixed for the session:");
const memoStore = () => {
  const saved = new Map<string, unknown>();
  return {
    saved,
    memo: async (key: unknown, fn: () => unknown) => {
      const k = JSON.stringify(key);
      if (!saved.has(k)) saved.set(k, JSON.parse(JSON.stringify(await fn())));
      return saved.get(k);
    },
  };
};
const BARE_CTX = { channel: { kind: "unified" }, session: { id: "sess-bare", auth: { current: { attributes: {} } } } };
for (const c of CASES) {
  const mod = (await import(`../agent/tools/${c.slug}.js`)) as { default: unknown };
  const store = memoStore();
  const first = (await evaluateDynamic(mod.default, { ...c.ctx, session: { ...c.ctx.session, id: `sess-${c.slug}` }, memo: store.memo })) as Record<string, unknown> | null;
  ok(first !== null && typeof first.execute === "function", `${c.slug} mounts on its happy-path session`);
  eq([...store.saved.values()], [true], `${c.slug} memoizes its mount decision as JSON`);
  const later = await evaluateDynamic(mod.default, { ...BARE_CTX, session: { ...BARE_CTX.session, id: `sess-${c.slug}` }, memo: store.memo });
  ok(later === first, `${c.slug}: a later model call of the same session keeps the tool`);
  eq(await evaluateDynamic(mod.default, { ...BARE_CTX, memo: memoStore().memo }), null, `NEGATIVE CONTROL: ${c.slug} does not mount on a session with no grant`);
}

console.log(`\nnotion dynamic tools: ${n} assertions passed.`);
