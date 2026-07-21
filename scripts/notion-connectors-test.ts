import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { loadBindings, loadBundles } from "../agent/access/bundles.js";
import { loadProviders } from "../agent/access/providers.js";
import { PLUGIN_REGISTRY } from "../agent/plugins/registry.js";
import { SKILL_CONTENT, NOTION_SCRIPT_SOURCE } from "../agent/plugins/skill-content.js";
import { resolveAccess, type ResolveRequest } from "@open-everywhere/core/agent/access/resolver.js";
import { compileNetworkPolicy } from "@open-everywhere/core/agent/access/egress.js";
import { resolveHeaders } from "@open-everywhere/core/agent/access/credentials.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

const bundles = loadBundles();
const bindings = loadBindings();
const providers = loadProviders();

function resolveFor(workspace: string, channel: string) {
  const req: ResolveRequest = { mode: "channel", platform: "slack", workspace, channel };
  return resolveAccess(req, bundles, bindings, PLUGIN_REGISTRY, providers);
}

const TEST_WORKSPACE = "T0EXAMPLE";
const TEST_CHANNEL = "C0EXGENRL";
const bound = resolveFor(TEST_WORKSPACE, TEST_CHANNEL);

ok(
  bound.warnings.length === 0,
  `bound channel resolves with no warnings (got: ${JSON.stringify(bound.warnings)})`,
);

const notionHost = bound.reachableHosts.find((h) => h.host === "api.notion.com");
ok(notionHost !== undefined, "route ①: api.notion.com is reachable");
ok(notionHost?.viaConnection === "notion-rest", "route ①: reachable via the notion-rest connection (credentialed, not bare)");
ok(
  new Set(notionHost?.methods).size === 3 && ["GET", "POST", "PATCH"].every((m) => notionHost?.methods?.includes(m as never)),
  "route ①: scoped to GET/POST/PATCH (no DELETE)",
);
const notionConn = bound.connections.find((c) => c.id === "notion-rest");
ok(notionConn?.credentialType === "bearer" && notionConn?.secretRef === "NOTION_API_KEY", "route ①: bearer credential, secretRef NOTION_API_KEY");

ok(bound.plugins.includes("notion"), "route ②: bundle grants the 'notion' plugin");
ok(bound.skills.includes("notion-rest"), "route ②: plugin expands to the 'notion-rest' skill (scoped visibility)");
ok(SKILL_CONTENT["notion-rest"] !== undefined, "route ②: skill content exists in the registry");
ok(
  SKILL_CONTENT["notion-rest"].description.length > 0 && SKILL_CONTENT["notion-rest"].markdown.includes("Notion"),
  "route ②: skill has a description and Notion-referencing prose",
);
ok(
  Object.keys(SKILL_CONTENT["notion-rest"].files ?? {}).includes("scripts/notion.mjs"),
  "route ②: skill package ships scripts/notion.mjs",
);

ok(!bound.connectors.includes("notion"), "route ③ REMOVED: the org/channel does NOT grant the notion MCP connector (service-oauth was a dead end)");
ok(bound.connectorCredentials["notion"] === undefined, "route ③ REMOVED: no service/org connector credential is bound for 'notion' on the channel");

const unbound = resolveFor("T_SOME_OTHER_WORKSPACE", "C_SOME_OTHER_CHANNEL");
ok(!unbound.reachableHosts.some((h) => h.host === "api.notion.com"), "unbound channel: api.notion.com NOT reachable");
ok(!unbound.plugins.includes("notion"), "unbound channel: 'notion' plugin NOT granted");
ok(!unbound.skills.includes("notion-rest"), "unbound channel: 'notion-rest' skill NOT visible");
ok(!unbound.connectors.includes("notion"), "unbound channel: 'notion' connector NOT granted");
ok(unbound.connectorCredentials["notion"] === undefined, "unbound channel: no notion connector credential bound");

const dm = resolveAccess(
  { mode: "dm", platform: "slack", workspace: TEST_WORKSPACE, channel: TEST_CHANNEL, principalId: "U_SOMEONE" },
  bundles,
  bindings,
  PLUGIN_REGISTRY,
  providers,
);
ok(!dm.connectors.includes("notion"), "DM: 'notion' connector NOT granted via the caller's own scope (no such binding exists)");
ok(!dm.reachableHosts.some((h) => h.host === "api.notion.com"), "DM: api.notion.com NOT reachable");

const providersByName = new Map(providers.map((p) => [p.name, p]));
const grantedConnectorNames = new Set<string>();
for (const b of bundles) {
  for (const name of b.connectors ?? []) grantedConnectorNames.add(name);
  for (const g of b.providers ?? []) {
    const p = providersByName.get(g.provider);
    if (p) grantedConnectorNames.add(p.connection);
  }
}
ok(grantedConnectorNames.has("notion"), "connections-lint invariant: 'notion' is granted somewhere (providers.ts + bundles.ts agree)");

const withHeaders = await compileNetworkPolicy(bound, async (c) => {
  return { authorization: `Bearer test-token-for-${c.id}` };
});
ok(typeof withHeaders !== "string", "compiled policy is a real allow-map, not 'deny-all' (something IS reachable)");
type TestRule = { match?: { method?: string[] }; transform?: { headers?: Record<string, string> }[] };
function rulesFor(policy: typeof withHeaders, host: string): TestRule[] {
  if (typeof policy === "string") return [];
  const allow = (policy as { allow?: Record<string, unknown[]> }).allow;
  return (allow?.[host] ?? []) as TestRule[];
}
if (typeof withHeaders !== "string") {
  const rules = rulesFor(withHeaders, "api.notion.com");
  ok(Array.isArray(rules) && rules.length === 1, "exactly one rule for api.notion.com");
  ok(
    rules?.[0]?.transform?.[0]?.headers?.authorization === "Bearer test-token-for-notion-rest",
    "the rule's transform stamps the bearer header for the notion-rest connection",
  );
  ok(
    JSON.stringify(rules?.[0]?.match?.method?.slice().sort()) === JSON.stringify(["GET", "PATCH", "POST"]),
    "the rule's method match is exactly GET/POST/PATCH",
  );
}

delete process.env.NOTION_API_KEY;
try {
  await compileNetworkPolicy(bound, resolveHeaders);
  ok(false, "compileNetworkPolicy with the REAL resolveHeaders + no NOTION_API_KEY should throw");
} catch (err) {
  ok(String(err).includes("NOTION_API_KEY"), `throws naming the missing secret (got: ${String(err)})`);
}

const tmp = mkdtempSync(join(tmpdir(), "open-everywhere-notion-skill-"));
const scriptPath = join(tmp, "notion.mjs");
writeFileSync(scriptPath, NOTION_SCRIPT_SOURCE, "utf-8");

const originalFetch = globalThis.fetch;
let fetchCalls = 0;
globalThis.fetch = async (...args: unknown[]) => {
  fetchCalls++;
  throw new Error(`unexpected network call during import: ${JSON.stringify(args)}`);
};

const mod = (await import(pathToFileURL(scriptPath).href)) as {
  titleOf(pageOrDb: unknown): string;
  formatSearchResults(json: unknown): string;
  formatBlocks(json: unknown): string;
  buildAppendRequest(blockId: string, text: string): { method: string; path: string; body: unknown };
};
ok(fetchCalls === 0, "importing the skill script does not fire a network call (isMain guard holds)");

globalThis.fetch = originalFetch;
rmSync(tmp, { recursive: true, force: true });

ok(
  mod.titleOf({ properties: { Name: { type: "title", title: [{ plain_text: "Runbook" }] } } }) === "Runbook",
  "titleOf: reads the title-typed property regardless of its property name",
);
ok(mod.titleOf({ title: [{ plain_text: "A Database" }] }) === "A Database", "titleOf: falls back to a bare title array (databases)");
ok(mod.titleOf({}) === "(untitled)", "titleOf: falls back to (untitled) when nothing matches");

const searchOut = mod.formatSearchResults({
  results: [
    { object: "page", id: "p1", properties: { Name: { type: "title", title: [{ plain_text: "Onboarding" }] } } },
    { object: "database", id: "d1", title: [{ plain_text: "Roadmap" }] },
  ],
});
ok(searchOut.includes("Onboarding") && searchOut.includes("page p1"), "formatSearchResults: page result rendered as 'title (object id)'");
ok(searchOut.includes("Roadmap") && searchOut.includes("database d1"), "formatSearchResults: database result rendered too");
ok(mod.formatSearchResults({ results: [] }) === "No results.", "formatSearchResults: empty results → plain 'No results.'");

const blocksOut = mod.formatBlocks({
  results: [
    { type: "heading_1", id: "h1", heading_1: { rich_text: [{ plain_text: "Title" }] } },
    { type: "to_do", id: "t1", to_do: { rich_text: [{ plain_text: "ship it" }], checked: true } },
    { type: "child_page", id: "cp1", child_page: { title: "Sub" } },
    { type: "some_future_block_type", id: "x1" },
  ],
});
ok(blocksOut.includes("# Title"), "formatBlocks: heading_1 rendered");
ok(blocksOut.includes("- [x] ship it"), "formatBlocks: checked to-do rendered");
ok(blocksOut.includes("[page] Sub (id cp1)"), "formatBlocks: child_page rendered as a typed placeholder, not inlined");
ok(blocksOut.includes("[some_future_block_type] (id x1)"), "formatBlocks: unrecognised type → typed placeholder, never silently dropped");
ok(mod.formatBlocks({ results: [] }) === "(no content)", "formatBlocks: empty → '(no content)'");

const append = mod.buildAppendRequest("blk123", "hello from the test");
ok(append.method === "PATCH" && append.path === "/v1/blocks/blk123/children", "buildAppendRequest: PATCHes the block's children (append, not replace)");
const appendBody = append.body as { children: { paragraph: { rich_text: { text: { content: string } }[] } }[] };
ok(appendBody.children.length === 1 && appendBody.children[0].paragraph.rich_text[0].text.content === "hello from the test", "buildAppendRequest: exactly one paragraph block with the given text");

console.log(`✓ notion-connectors: ${passed} assertions passed (REST + skill route wiring, route ③ removal, scoping, egress policy, skill script)`);
