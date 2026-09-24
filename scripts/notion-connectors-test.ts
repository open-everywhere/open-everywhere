import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { withPatchedFetch } from "../packages/core/scripts/_fetch-test-utils.js";
import { loadBindings, loadBundles } from "../agent/access/bundles.js";
import { domainsForSurface, loadDomains } from "../agent/memory/config/domains.js";
import { loadConnectorCredentials } from "../agent/access/connector-credentials.js";
import { PLUGIN_REGISTRY } from "../agent/plugins/registry.js";
import { SKILL_CONTENT, NOTION_SCRIPT_SOURCE } from "../agent/plugins/skill-content.js";
import { resolveAccess, type ResolveRequest } from "@open-everywhere/core/agent/access/resolver.js";
import { bundleConnectorNames } from "@open-everywhere/core/agent/access/bundle.js";
import { definedConnectors, definedConnectorCredentials, planAccessDelta } from "@open-everywhere/core/agent/access/delta.js";
import { connectorGrantCredentialProblems } from "@open-everywhere/core/agent/access/lint.js";
import { compileNetworkPolicy } from "@open-everywhere/core/agent/access/egress.js";
import { resolveHeaders } from "@open-everywhere/core/agent/access/credentials.js";
import { credentialEndpointVerdict, credentialEndpointHostVerdict } from "@open-everywhere/core/agent/access/credential-endpoints.js";
import { vercelConnectorOf } from "@open-everywhere/core/agent/access/connector-credentials.js";
import { offerableCredential } from "@open-everywhere/core/agent/connections/connector-offer.js";

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
const catalogues = loadConnectorCredentials();
const domains = loadDomains();

function resolveFor(workspace: string, channel: string) {
  const req: ResolveRequest = {
    mode: "channel",
    platform: "slack",
    workspace,
    channel,
    domains: domainsForSurface({ workspaceKey: `slack/${workspace}`, surface: channel }, domains),
  };
  return resolveAccess(req, bundles, bindings, PLUGIN_REGISTRY, catalogues);
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
ok(notionConn?.credentialType === "bearer" && notionConn?.secretRef === "db:notion:team-key", "route ①: bearer credential, secretRef db:notion:team-key");

const unified = domains.find((domain) => domain.name === "e2e-unified");
ok(unified?.mode === "unified", "shared Notion fixture uses the unified domain");
ok(unified?.reach?.includes("github/example-owner/e2e-scratch") === true,
  "the GitHub test repo is a member, so shared access coverage cannot pass without it");
for (const surface of unified?.reach ?? []) {
  const [platform, workspace, ...channelParts] = surface.split("/");
  const channel = channelParts.join("/");
  const access = resolveAccess({
    mode: "channel", platform, workspace, channel,
    domains: domainsForSurface({ workspaceKey: `${platform}/${workspace}`, surface: channel }, domains),
  }, bundles, bindings, PLUGIN_REGISTRY, catalogues);
  const connection = access.connections.find((candidate) => candidate.id === "notion-rest");
  ok(connection?.secretRef === "db:notion:team-key" && connection.broker === "db",
    `${platform} domain member uses the shared Notion credential`);
  ok(access.skills.includes("notion-rest"), `${platform} domain member can use the Notion REST skill`);
  ok(!access.connectors.includes("notion"), `${platform} domain member does not inherit personal Notion MCP access`);
  const host = access.reachableHosts.find((candidate) => candidate.host === "api.notion.com");
  ok(host?.viaConnection === "notion-rest" && host.methods?.includes("PATCH") === true,
    `${platform} domain member can update Notion through the credentialed connection`);
}
const unrelatedGithub = resolveAccess({
  mode: "channel", platform: "github", workspace: "example-owner", channel: "unrelated-notion-test",
  domains: domainsForSurface({ workspaceKey: "github/example-owner", surface: "unrelated-notion-test" }, domains),
}, bundles, bindings, PLUGIN_REGISTRY, catalogues);
ok(!unrelatedGithub.connections.some((connection) => connection.id === "notion-rest"),
  "unrelated GitHub repo does not inherit the domain's shared Notion credential");

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

ok(bound.connectors.includes("notion"), "S24 fixture channel: the notion connector IS granted here (e2e-connector-fixture), so the connector plane is reachable");
ok(
  bound.connectorCredentials["notion"]?.credential === "workspace-oauth",
  `S24 fixture channel: the grant resolves the 'workspace-oauth' credential (got: ${JSON.stringify(bound.connectorCredentials["notion"]?.credential)})`,
);
ok(
  bound.connectorCredentials["notion"]?.principal === "app",
  `S24 fixture channel: the resolved binding is APP-principal (got: ${JSON.stringify(bound.connectorCredentials["notion"]?.principal)})`,
);
ok(
  bound.connectorCredentials["notion"]?.grantFamily === "install",
  "…and its grant family is 'install' — not a human-acting credential wearing an app-principal type",
);

{
  const notionCat = catalogues.find((c) => c.connector === "notion")!;
  ok(notionCat.allows.includes("service-oauth"), "the notion connection ACCEPTS service-oauth again — without this the grant above resolves to nothing");

  const orgCreds = notionCat.credentials.filter((cr) => cr.type === "service-oauth");
  ok(orgCreds.length === 1, `🔴 EXACTLY ONE service-oauth credential — got ${orgCreds.length}; offerableCredential takes the FIRST of a type, so a second is unreachable rather than additive`);
  const org = orgCreds[0];
  ok(org?.id === "workspace-oauth", "…and it is 'workspace-oauth', the id the e2e-connector-fixture grant names");
  ok(
    offerableCredential(notionCat, "service-oauth")?.id === "workspace-oauth",
    "…and it is what the connector card's 'Connect org account' click actually resolves (offerableCredential, the one selector both sides use)",
  );

  ok(org?.dashboardUrl === undefined, "🔴 it declares NO dashboardUrl — that field routes the click away from the mint, to a Vercel page that cannot complete this grant");
  ok(vercelConnectorOf(org!) === "mcp.notion.com/notion-mcp", "…and it is homed at the MCP OAuth ref — the only token family hosted mcp.notion.com accepts");

  const dmCred = notionCat.credentials.find((cr) => cr.id === "user-oauth");
  ok(vercelConnectorOf(org!) === vercelConnectorOf(dmCred!), "…and it shares `user-oauth`'s home ref — one provider entry, one client, two vault rows keyed by subject");

  ok(credentialEndpointHostVerdict(org?.endpoints, "https://mcp.notion.com/mcp").allowed, "the org credential's rules ADMIT hosted MCP — the host connections/notion.ts actually dials");
  ok(
    !credentialEndpointHostVerdict(org?.endpoints, "https://api.notion.com/v1/pages").allowed,
    "🔴 …and REFUSE api.notion.com — an MCP-family token gets 401 there, so a rule naming both hosts would send this token to REST under the ORG's name",
  );
  ok(!credentialEndpointHostVerdict(org?.endpoints, "https://evil.example/mcp").allowed, "🔴 …and REFUSE a wrong host outright");
  ok((org?.endpoints?.hosts?.length ?? 0) === 1, "🔴 …and name EXACTLY ONE host");

  const bothHosts = notionCat.credentials.filter((cr) => {
    const hosts = cr.endpoints?.hosts ?? [];
    return hosts.includes("api.notion.com") && hosts.includes("mcp.notion.com");
  });
  ok(
    bothHosts.length === 0,
    `🔴 no Notion credential names BOTH api.notion.com and mcp.notion.com — got ${JSON.stringify(bothHosts.map((cr) => cr.id))}`,
  );
  ok(
    notionCat.credentials.some((cr) => (cr.endpoints?.hosts ?? []).length > 0),
    "…and that sweep reads real endpoint rules — at least one notion credential narrows its hosts, so the check above is not vacuously true",
  );
}

{
  const { routineConnectorFixture, NOTION_MCP_HOST } = await import("../packages/core/scripts/e2e/routine-connector-fixture.js");
  const e2eConnector = domains.find((d) => d.name === "e2e-connector");
  ok(e2eConnector !== undefined, "the shipped config still declares the e2e-connector domain the fixture bundle binds to");
  const surfaceKey = e2eConnector?.reach?.[0];
  ok(typeof surfaceKey === "string" && surfaceKey.length > 0, "…and that domain still declares the surface S-ROUTINE-CONNECTOR-WRITE fires in");

  const live = routineConnectorFixture({
    surfaceKey: surfaceKey!,
    connector: "notion",
    op: "notion__create_page",
    mcpHost: NOTION_MCP_HOST,
    domains,
    bundles,
    bindings,
    credentials: catalogues,
  });
  ok(
    live.ok,
    `🔴 the SHIPPED config arms S-ROUTINE-CONNECTOR-WRITE — an unattended fire in this room reaches a notion MCP op (reason when red: ${live.ok ? "" : live.reason})`,
  );
  ok(live.ok && live.bundle === "e2e-connector-fixture" && live.credential === "workspace-oauth", "…through the e2e-connector-fixture bundle, as the 'workspace-oauth' credential");
  const fixtureGrant = bundles.find((b) => b.name === "e2e-connector-fixture")?.connectors?.find((c) => typeof c !== "string" && c.name === "notion");
  ok(
    fixtureGrant !== undefined && typeof fixtureGrant !== "string" && fixtureGrant.contentOrigin === "internal",
    `🔴 the e2e org Notion connection declares contentOrigin "internal" (found ${JSON.stringify(fixtureGrant)})`,
  );

  const elsewhere = routineConnectorFixture({
    surfaceKey: "slack/T_NOT_OURS/C_NOT_OURS",
    connector: "notion",
    op: "notion__create_page",
    mcpHost: NOTION_MCP_HOST,
    domains,
    bundles,
    bindings,
    credentials: catalogues,
  });
  ok(!elsewhere.ok, "🔴 …and an unrelated room is NOT armed — the grant is a domain binding, not a blanket one");
}

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
  catalogues,
);
ok(!dm.connectors.includes("notion"), "DM: 'notion' connector NOT granted via the caller's own scope (no such binding exists)");
ok(!dm.reachableHosts.some((h) => h.host === "api.notion.com"), "DM: api.notion.com NOT reachable");

const grantedConnectorNames = new Set<string>();
for (const b of bundles) {
  for (const name of bundleConnectorNames(b)) grantedConnectorNames.add(name);
}
ok(grantedConnectorNames.has("notion"), "connections-lint invariant: 'notion' is granted somewhere on the one connectors list");
ok(
  catalogues.some((c) => c.connector === "notion" && c.credentials.some((cr) => cr.id === "team-key")),
  "the shipped notion catalogue configures the 'team-key' credential the work-surface REST routes name",
);

{
  const notionCat = catalogues.find((c) => c.connector === "notion")!;
  const teamKey = notionCat.credentials.find((cr) => cr.id === "team-key");
  const channelKey = notionCat.credentials.find((cr) => cr.id === "channel-key");
  ok(teamKey?.endpoints !== undefined, "🔴 the shipped 'team-key' credential now declares `endpoints` (was undefined before OPE-934)");
  ok(
    JSON.stringify(teamKey?.endpoints) === JSON.stringify(channelKey?.endpoints),
    "…and its rules match 'channel-key' — team-key runs through the SAME guarded notionFetch (search/pages/blocks/comments), so it needs the same host/path/method reach",
  );

  ok(
    credentialEndpointVerdict(teamKey?.endpoints, "https://api.notion.com/v1/pages/abc", "GET").allowed,
    "the real rules ADMIT team-key's actual work-plane call shape (GET /v1/pages/…) — a positive control, so the refusal below proves something",
  );
  ok(
    !credentialEndpointVerdict(teamKey?.endpoints, "https://evil.example/v1/pages/abc", "GET").allowed,
    "🔴 the real rules REFUSE a wrong-host call — this is exactly what ran unfenced (silently ALLOWED) before OPE-934, since `rules === undefined` short-circuits to allowed",
  );
  ok(
    !credentialEndpointVerdict(teamKey?.endpoints, "https://api.notion.com/v1/pages/abc", "DELETE").allowed,
    "…and a wrong-method call, same fence",
  );

  ok(
    !credentialEndpointHostVerdict(teamKey?.endpoints, "https://mcp.notion.com/mcp").allowed,
    "team-key's rules do NOT admit mcp.notion.com (the MCP connector's directUrl) — an api-key grant on that connector fails at the credential wall instead of at Notion's 401",
  );

  const memoryKey = notionCat.credentials.find((cr) => cr.id === "memory");
  ok(memoryKey !== undefined, "the shipped notion catalogue still carries the 'memory' credential the backing resolves");
  ok(
    JSON.stringify(memoryKey?.endpoints?.methods) === JSON.stringify(["GET"]),
    "🔴 the shipped 'memory' credential admits GET ONLY — Notion memory write-back stays fenced out until an operator widens it, and three documents say so",
  );
  ok(
    credentialEndpointVerdict(memoryKey?.endpoints, "https://api.notion.com/v1/blocks/abc/children", "GET").allowed,
    "positive control: the real 'memory' rules ADMIT the subtree pull (GET /v1/blocks/…/children), so the refusal below proves something",
  );
  ok(
    !credentialEndpointVerdict(memoryKey?.endpoints, "https://api.notion.com/v1/blocks/abc/children", "PATCH").allowed,
    "🔴 …and REFUSE the memory backing's block-append PATCH on the same path — the fence, driven through the real rules",
  );
}

{
  const notionCat = catalogues.find((c) => c.connector === "notion")!;
  const perUser = notionCat.credentials.filter((cr) => cr.type === "user-oauth");
  ok(perUser.length === 1, `🔴 the shipped notion catalogue declares EXACTLY ONE per-user credential — got ${perUser.length}; a second is unreachable, not additive`);
  const mcpUser = perUser[0];
  ok(mcpUser?.id === "user-oauth", "…and it is the MCP-family credential `user-oauth`, the only family hosted mcp.notion.com accepts");
  ok(mcpUser?.endpoints !== undefined, "🔴 …and it declares `endpoints` — `guardCredentialFetch` returns the base fetch BY IDENTITY when handed no rules, so an unfenced per-user credential is an unfenced person");

  ok(
    credentialEndpointHostVerdict(mcpUser?.endpoints, "https://mcp.notion.com/mcp").allowed,
    "the real rules ADMIT hosted MCP — the host a borrowed Notion tool call is sent to",
  );
  ok(
    !credentialEndpointHostVerdict(mcpUser?.endpoints, "https://evil.example/mcp").allowed,
    "🔴 …and REFUSE a wrong-host call, which is what an unfenced credential would have allowed",
  );
  ok(
    !credentialEndpointHostVerdict(mcpUser?.endpoints, "https://api.notion.com/v1/users/me").allowed,
    "🔴 …and REFUSE api.notion.com — no granted Notion call reaches REST at all now the REST arm is deleted",
  );
}

{
  const defined = definedConnectors(bundles);
  ok(defined.includes("notion"), "OPE-580 FIX: 'notion' is in the grant-connector VOCABULARY (definedConnectors reads the one list)");
  ok(!defined.includes("linear-mcp"), "…and the defined set is not a wildcard: an ungranted connector name is absent");

  const configured = definedConnectorCredentials(catalogues, "notion");
  ok(
    configured.includes("team-key") && configured.includes("user-oauth") && configured.includes("workspace-oauth"),
    "the notion catalogue's credential ids are the closed set an ask may name",
  );
  ok(!configured.includes("nope"), "…and an id nobody configured is not in it");
  ok(definedConnectorCredentials(catalogues, "linear-mcp").length === 0, "a connector with no catalogue configures nothing — fail-closed, not 'anything goes'");

  const ungranted = resolveFor("T_OTHER", "C_OTHER");
  const planCtx = {
    scope: { level: "surface" as const, surface: "slack/T_OTHER/C_OTHER" },
    access: ungranted,
    bundles,
    connectorCredentials: catalogues,
  };
  const delta = planAccessDelta({ kind: "grant-connector", connector: "notion", credential: "team-key" }, planCtx);
  ok(
    delta.kind === "grant-connector" && delta.connector === "notion" && delta.credential === "team-key",
    "OPE-580 FIX, end to end: a grant-connector ask for 'notion' PLANS against the shipped config",
  );

  function refuses(ask: Parameters<typeof planAccessDelta>[0], fragment: string, label: string): void {
    try {
      planAccessDelta(ask, planCtx);
    } catch (err) {
      ok(String(err).includes(fragment), label);
      return;
    }
    ok(false, `${label} (did not throw)`);
  }
  refuses({ kind: "grant-connector", connector: "notion", credential: "nope" }, 'no credential "nope" configured', "an unconfigured credential is out of vocabulary");
  refuses({ kind: "grant-connector", connector: "notion" }, "needs the credential to reach", "an ask with no credential is refused — every grant names its identity");
  refuses({ kind: "grant-connector", connector: "no-such-connector", credential: "team-key" }, "isn't defined in this deployment's config", "an undefined connector is still out of vocabulary");
}

{
  ok(
    connectorGrantCredentialProblems(bundles, catalogues).length === 0,
    "lint:connections: every shipped connector grant names a credential its connector configures",
  );
  const broken = bundles.map((b) =>
    b.name === "e2e-connector-fixture" ? { ...b, connectors: [{ name: "notion", credential: "ghost-key", contentOrigin: "external" as const }] } : b,
  );
  const problems = connectorGrantCredentialProblems(broken, catalogues);
  ok(problems.length === 1, "…and a grant naming an unconfigured credential is exactly one problem");
  ok(
    problems[0].includes("ghost-key") && problems[0].includes("e2e-connector-fixture") && problems[0].includes("configured: "),
    "…named: the bundle, the credential, and what IS configured",
  );
  const noCatalogue = connectorGrantCredentialProblems(broken, []);
  ok(
    noCatalogue.some((p) => p.includes("NO credential catalogue")),
    "…and a connector with no catalogue at all is a DISTINCT, separately-worded failure",
  );
}

const withHeaders = await compileNetworkPolicy(
  bound,
  async (c) => {
    return { authorization: `Bearer test-token-for-${c.id}` };
  },
  async (ids) => ids,
);
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

try {
  await compileNetworkPolicy(bound, resolveHeaders, async (ids) => ids);
  ok(false, "compileNetworkPolicy with the REAL resolveHeaders + no db broker registered should throw");
} catch (err) {
  ok(
    String(err).includes("db") && String(err).includes("not registered"),
    `throws naming the unregistered db broker (got: ${String(err)})`,
  );
}

const tmp = mkdtempSync(join(tmpdir(), "open-everywhere-notion-skill-"));
const scriptPath = join(tmp, "notion.mjs");
writeFileSync(scriptPath, NOTION_SCRIPT_SOURCE, "utf-8");

let fetchCalls = 0;
const mod = await withPatchedFetch(
  async (...args: unknown[]) => {
    fetchCalls++;
    throw new Error(`unexpected network call during import: ${JSON.stringify(args)}`);
  },
  () =>
    import(pathToFileURL(scriptPath).href) as Promise<{
      titleOf(pageOrDb: unknown): string;
      formatSearchResults(json: unknown): string;
      formatBlocks(json: unknown): string;
      buildAppendRequest(blockId: string, text: string): { method: string; path: string; body: unknown };
    }>,
);
ok(fetchCalls === 0, "importing the skill script does not fire a network call (isMain guard holds)");

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

console.log(`✓ notion-connectors: ${passed} assertions passed (REST + skill route wiring, route ③'s org-subject MCP credential, the S-ROUTINE-CONNECTOR-WRITE preflight over shipped config, scoping, the one grant list, egress policy, skill script)`);
