import assert from "node:assert/strict";
import { execTool } from "./_tool-exec.js";
import { registerIdentityMapper, type BindableContext } from "../agent/identity/binding.js";
import { defineDomain, type Domain } from "../agent/memory/domain.js";
import { workDestinationPlatforms } from "../agent/channels/work-destinations.js";
import {
  searchGrantedConnectors,
  registerWorkSearchAdapter,
  registerCoreWorkSearchAdapter,
  workSearchAdapterFor,
  registeredSearchConnectors,
  _resetWorkSearchRegistryForTest,
  type WorkSearchAdapter,
  type WorkSearchHit,
} from "../agent/channels/work-search.js";
import { searchEntry, default as searchDefault } from "../agent/tools/search.js";
import { _dynamicResolverForTest } from "../agent/access/window-gated.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

const PLATFORM = "worksearchtestplatform";
registerIdentityMapper(PLATFORM, (c) => {
  const a = (c as BindableContext).session?.auth?.current?.attributes as Record<string, string> | undefined;
  return { workspace: a?.["ws"], surface: a?.["room"], mode: "channel", visibility: "public", trust: "internal", principalId: "U_WS" };
});

function ctxIn(room: string): BindableContext {
  return {
    channel: { kind: PLATFORM },
    session: { auth: { current: { attributes: { ws: "W1", room }, principalId: "U_WS", principalType: "test-user" } } },
  } as unknown as BindableContext;
}

const NOTION_ROOM = "CNOTION";
const notionGranted: Domain = defineDomain({
  name: "ws-notion",
  reach: [`${PLATFORM}/W1/${NOTION_ROOM}`],
  credentials: [{ connector: "notion", credential: "team-key", use: "ws-notion-key" }],
});
ok(
  searchGrantedConnectors(ctxIn(NOTION_ROOM), [notionGranted]).includes("notion"),
  "🔴 the raw grant set names Notion — the whole reason `search` does not reuse workDestinationPlatforms",
);
ok(
  workDestinationPlatforms(ctxIn(NOTION_ROOM), [notionGranted]).includes("notion") === false,
  "NEGATIVE CONTROL: the ticket-registry-filtered set does NOT name Notion (no ticket-create/entity adapter registered for it) — proving the two sets are genuinely different, not just differently spelled",
);

const { defineBundle, defineBinding } = await import("../agent/access/bundle.js");
const { registerConfig: registerConfigEarly } = await import("../agent/access/config.js");
const UNMATCHED_ROOM = "CNOWHERE";
registerConfigEarly({
  loadBundles: () => [defineBundle({ name: "coding", repos: ["acme/api"] })],
  loadBindings: () => [defineBinding({ bundle: "coding", scope: { level: "org" } })],
  pluginRegistry: {},
  skillContent: {},
  loadDomains: () => [],
  loadSilos: () => [],
  domainsForSurface: () => [],
});
ok(
  searchGrantedConnectors(ctxIn(UNMATCHED_ROOM), []).includes("github"),
  "🔴 a ctx with NO resolved memory domain still names github when the access bundle grants repos org-wide (the domain-free GitHub grant path)",
);
ok(
  searchGrantedConnectors(ctxIn(UNMATCHED_ROOM), []).includes("notion") === false,
  "NEGATIVE CONTROL: the SAME domain-free ctx names no domain-keyed connector — only github's repo-grant path survives an unresolved domain",
);

const fakeHit = (connector: string, id: string): WorkSearchHit => ({ connector, id, title: `title-${id}` });

const fakeNotion: WorkSearchAdapter = {
  connector: "notion",
  search: async (_ctx, _domain, query, opts) => [fakeHit("notion", `n-${query}-${opts.insideDomain ? "in" : "out"}`)],
};
const fakeGithub: WorkSearchAdapter = {
  connector: "github",
  search: async (_ctx, _domain, query) => [fakeHit("github", `g-${query}`)],
};
_resetWorkSearchRegistryForTest([]);
ok(workSearchAdapterFor("notion") === undefined, "an unregistered connector resolves to undefined");
registerWorkSearchAdapter(fakeNotion);
ok(workSearchAdapterFor("notion") === fakeNotion, "registerWorkSearchAdapter registers a provider-bundle adapter (library mode admits it)");
registerCoreWorkSearchAdapter(fakeGithub);
ok(workSearchAdapterFor("github") === fakeGithub, "registerCoreWorkSearchAdapter registers a core-resident adapter, ungated");
ok(registeredSearchConnectors().join(",") === "github,notion", "registeredSearchConnectors lists both, sorted");

type Handler = (event: unknown, ctx: unknown) => unknown;
async function armed<T>(tool: unknown, c: BindableContext): Promise<T | null> {
  const handler = _dynamicResolverForTest(tool);
  return (await handler({}, c)) as T | null;
}

const BARE_ROOM = "CBARE";
const bareDomain: Domain = defineDomain({ name: "ws-bare", reach: [`${PLATFORM}/W1/${BARE_ROOM}`] });
const gitGranted: Domain = defineDomain({ name: "ws-git", reach: [`${PLATFORM}/W1/CGIT`] });
const DOMAINS: readonly Domain[] = [notionGranted, bareDomain, gitGranted];

const { registerConfig } = await import("../agent/access/config.js");
registerConfig({
  loadBundles: () => [],
  loadBindings: () => [],
  pluginRegistry: {},
  skillContent: {},
  loadDomains: () => DOMAINS,
  loadSilos: () => [],
  domainsForSurface: ({ workspaceKey, surface }) => DOMAINS.filter((d) => (d.reach ?? []).includes(`${workspaceKey}/${surface}`)).map((d) => d.name),
});

ok((await armed(searchDefault, ctxIn(NOTION_ROOM))) !== null, "search MOUNTS for a domain holding ANY work grant (Notion here)");
ok((await armed(searchDefault, ctxIn(BARE_ROOM))) === null, "NEGATIVE CONTROL: search is ABSENT for a domain with no work grant at all");

const execRaw = execTool(searchEntry);
const exec = (input: Parameters<typeof execRaw>[0], c: BindableContext) => execRaw(input, c as never);

const bothGranted: Domain = defineDomain({
  name: "ws-both",
  reach: [`${PLATFORM}/W1/CBOTH`],
  credentials: [{ connector: "notion", credential: "team-key", use: "both-notion-key" }],
});
const BOTH_DOMAINS: readonly Domain[] = [bothGranted, gitGranted, bareDomain];
registerConfig({
  loadBundles: () => [],
  loadBindings: () => [],
  pluginRegistry: {},
  skillContent: {},
  loadDomains: () => BOTH_DOMAINS,
  loadSilos: () => [],
  domainsForSurface: ({ workspaceKey, surface }) => BOTH_DOMAINS.filter((d) => (d.reach ?? []).includes(`${workspaceKey}/${surface}`)).map((d) => d.name),
});
const bothGrantedTwo: Domain = defineDomain({
  name: "ws-both",
  reach: [`${PLATFORM}/W1/CBOTH2`],
  credentials: [
    { connector: "notion", credential: "team-key", use: "both-notion-key" },
    { connector: "linear", credential: "workspace", use: "both-linear-key" },
  ],
});
const BOTH2_DOMAINS: readonly Domain[] = [bothGrantedTwo, bareDomain];
registerConfig({
  loadBundles: () => [],
  loadBindings: () => [],
  pluginRegistry: {},
  skillContent: {},
  loadDomains: () => BOTH2_DOMAINS,
  loadSilos: () => [],
  domainsForSurface: ({ workspaceKey, surface }) => BOTH2_DOMAINS.filter((d) => (d.reach ?? []).includes(`${workspaceKey}/${surface}`)).map((d) => d.name),
});

const bothCtx = ctxIn("CBOTH2");
const res = await exec({ query: "spec" }, bothCtx);
ok(res.hits.some((h) => h.connector === "notion"), "federated call returns the registered Notion adapter's hit");
ok(res.absent.some((a) => a.connector === "linear" && a.reason.includes("no search-capable credential")), "🔴 a GRANTED connector with NO registered adapter is a NAMED absence, never a silent drop");
ok(res.absent.every((a) => a.connector !== "notion"), "the connector that DID resolve is never also listed absent");

const resInside = await exec({ query: "q", insideDomain: true }, bothCtx);
ok(
  resInside.hits.find((h) => h.connector === "notion")!.id.endsWith("-in"),
  "insideDomain:true reaches the adapter's own opts.insideDomain (the fake adapter tags its id by it)",
);
const resOutside = await exec({ query: "q", insideDomain: false }, bothCtx);
ok(
  resOutside.hits.find((h) => h.connector === "notion")!.id.endsWith("-out"),
  "NEGATIVE CONTROL: insideDomain:false (and the default) reaches the adapter as false, not true",
);
ok(res.insideDomain === false, "the DEFAULT (omitted) insideDomain reports false in the output — never silently true");

const resScoped = await exec({ query: "q", scope: "notion" }, bothCtx);
ok(resScoped.hits.every((h) => h.connector === "notion") && resScoped.absent.length === 0, "scope:\"notion\" narrows to ONE connector and reports no absence for the one not asked about");

await assert.rejects(exec({ query: "q" }, ctxIn(BARE_ROOM)), /holds no work grant/u, "a domain with no grant at all REFUSES the call rather than returning an empty result");
await assert.rejects(exec({ query: "q", scope: "slack" }, bothCtx), /holds no "slack" work grant/u, "scoping to a connector the domain does NOT hold a grant on refuses, naming the connectors it DOES hold");

{
  const roadNotion: WorkSearchAdapter = {
    connector: "notion",
    async search(): Promise<readonly WorkSearchHit[]> {
      return [
        { connector: "notion", id: "page-1", title: "Spec", readWith: { tool: "read_notion_page", args: { page: "page-1" } } },
        { connector: "notion", id: "db-1", title: "Tracker" },
      ];
    },
  };
  _resetWorkSearchRegistryForTest([roadNotion, fakeGithub]);
  const roads = await exec({ query: "spec", scope: "notion" }, bothCtx);
  assert.deepEqual(
    roads.hits.find((h) => h.id === "page-1")!.readWith,
    { tool: "read_notion_page", args: { page: "page-1" } },
    "an adapter's `readWith` reaches the tool's output unchanged",
  );
  passed++;
  ok(roads.hits.find((h) => h.id === "db-1")!.readWith === undefined, "a hit with no road carries no `readWith` — the tool layer invents none");

  const toModel = (searchEntry as unknown as { toModelOutput: (o: typeof roads) => Promise<{ value: string }> }).toModelOutput;
  const rendered = (await toModel(roads)).value;
  ok(rendered.includes('read with: read_notion_page({"page":"page-1"})'), "🔴 the model READS the road: the render names the tool and its arguments under the hit");
  ok(rendered.includes("read with: no tool takes this item as a target."), "🔴 a hit with no road SAYS so in the render, rather than leave the model to guess");
  ok(
    (searchEntry as unknown as { description: string }).description.includes("Read the item before you say anything about its body"),
    "the tool description tells the model a hit is a pointer it must read",
  );
  _resetWorkSearchRegistryForTest([fakeNotion, fakeGithub]);
}

console.log(`✓ work-search: ${passed} assertions passed`);

// proves: TOOL-search
