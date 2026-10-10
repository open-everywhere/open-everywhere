import assert from "node:assert/strict";
import { assertBindingsValid, assertBundlesValid } from "../agent/access/bundle.js";
import { assertConnectorCredentialsValid } from "../agent/access/connector-credentials.js";
import { lintBroadGrants } from "../agent/access/lint.js";
import { resolveAccess, type ResolveRequest } from "../agent/access/resolver.js";
import {
  defineMcpServers,
  mcpServerBindings,
  mcpServerBundles,
  mcpServerConnectionSignIn,
  mcpServerConnectorCredentials,
  mcpServerHomeRef,
  type McpServerDeclaration,
} from "../agent/connections/mcp-servers.js";
import { EVERYONE_GROUP, assertGroupsValid, type Group } from "../agent/identity/groups.js";
import { goldenPlanLines, planRoster, renderMcpServerStub } from "../agent/scaffold/roster-plan.js";

let passed = 0;
function ok(cond: unknown, msg: string): void {
  assert.ok(cond, msg);
  passed++;
  console.log(`  ✓ ${msg}`);
}
function refuses(fn: () => unknown, needle: string, msg: string): void {
  let err = "";
  try {
    fn();
  } catch (e) {
    err = e instanceof Error ? e.message : String(e);
  }
  ok(err.includes(needle), `${msg}${err.includes(needle) ? "" : ` — got ${err === "" ? "no throw" : JSON.stringify(err)}`}`);
}

const FULLSTORY: McpServerDeclaration = {
  name: "fullstory",
  url: "https://mcp.fullstory.example/mcp",
  description: "FullStory: search sessions and read session summaries.",
};

console.log("§1 the declaration");
{
  const one = (s: Partial<McpServerDeclaration> & Record<string, unknown>) => () => defineMcpServers([{ ...FULLSTORY, ...s } as McpServerDeclaration]);
  ok(defineMcpServers([FULLSTORY]).length === 1, "§1 a name, an https URL and a description are a whole declaration");
  refuses(one({ url: "http://mcp.fullstory.example/mcp" }), "must be https", "§1 a clear-text URL is refused");
  refuses(one({ url: "https://user:pw@mcp.fullstory.example/mcp" }), "user-info", "§1 🔴 a URL carrying a credential is refused");
  refuses(one({ url: "https://mcp.fullstory.example/mcp?token=abc" }), "query string", "§1 🔴 a URL carrying a query string is refused");
  refuses(one({ url: "not a url" }), "is not a URL", "§1 a malformed URL is refused");
  refuses(one({ description: "  " }), "description is empty", "§1 an empty description is refused");
  refuses(one({ name: "Full_Story" }), "name must match", "§1 a name eve would not mount is refused");
  refuses(() => defineMcpServers([FULLSTORY, FULLSTORY]), "declared twice", "§1 a duplicate name is refused");
  refuses(one({ signIn: { clientSecret: "s3cret" } as never }), "literal clientSecret", "§1 🔴 a literal client secret is refused");
  refuses(
    one({
      signIn: {
        mode: "static-confidential",
        authorizationEndpoint: "https://a.example/authorize",
        tokenEndpoint: "https://a.example/token",
        clientId: "public",
        clientSecretRef: "",
        bodyEncoding: "form",
      },
    }),
    "needs a clientSecretRef",
    "§1 a static client with no secret REF is refused",
  );
  refuses(one({ people: { groups: [] } }), "people.groups", "§1 an empty people.groups is refused (omit it for everyone)");
}

console.log("§2 the derived config");
const SERVERS = defineMcpServers([FULLSTORY, { name: "acme", url: "https://mcp.acme.example/mcp", description: "Acme CRM.", people: { groups: ["sales"] } }]);
const CATALOGUES = mcpServerConnectorCredentials(SERVERS);
const BUNDLES = mcpServerBundles(SERVERS);
const BINDINGS = mcpServerBindings(SERVERS);
const GROUPS: Group[] = [{ name: "sales", members: ["slack/T1/USALES"] }];
{
  const fs = CATALOGUES.find((c) => c.connector === "fullstory");
  const personal = fs?.credentials.find((c) => c.id === "user-oauth");
  const org = fs?.credentials.find((c) => c.id === "workspace-oauth");
  ok(personal?.type === "user-oauth" && org?.type === "service-oauth", "§2 each server carries the person's user-oauth and the org's service-oauth credential");
  ok(
    JSON.stringify(personal?.home) === JSON.stringify(org?.home) && JSON.stringify(personal?.home).includes(mcpServerHomeRef("fullstory")),
    "§2 both credentials name the server's one home ref",
  );
  ok(personal?.endpoints?.hosts?.join() === "mcp.fullstory.example", "§2 the credentials are narrowed to the server's own host");
  assertConnectorCredentialsValid(CATALOGUES);
  assertBundlesValid(BUNDLES);
  assertBindingsValid(BINDINGS, BUNDLES, GROUPS);
  ok(true, "§2 the derived catalogues, bundles and bindings pass core's own config-load checks");
  const signIn = mcpServerConnectionSignIn(FULLSTORY);
  ok(signIn.mode === "discovery-dcr-pkce" && "resource" in signIn && signIn.resource === FULLSTORY.url, "§2 the default sign-in is discovery + DCR + PKCE, with the URL as the resource");
}

console.log("§3 who reaches it");
{
  const resolve = (req: ResolveRequest) => resolveAccess(req, BUNDLES, BINDINGS, {}, CATALOGUES);
  const dm: ResolveRequest = { mode: "dm", platform: "slack", workspace: "T1", channel: "D1", principalId: "U1" };
  const inDm = resolve(dm);
  ok(inDm.connectors.includes("fullstory"), "§3 🔴 in a DM, any attested caller reaches a declared server");
  ok(inDm.connectorCredentials["fullstory"]?.principal === "user", "§3 …as THEMSELVES: the bound credential is user-principal");
  ok(!inDm.connectors.includes("acme"), "§3 a server narrowed to a group is not reached by a caller outside it");
  ok(resolve({ ...dm, groups: ["sales"] }).connectors.includes("acme"), "§3 …and is reached by a caller inside it");
  ok(resolve({ ...dm, mode: "channel", channel: "C1" }).connectors.length === 0, "§3 🔴 a channel reaches no declared server: a personal login never resolves there");
  ok(resolve({ ...dm, mode: "mpim" }).connectors.length === 0, "§3 🔴 a group DM reaches none either");
  const { principalId: _p, ...anonymous } = dm;
  ok(resolve(anonymous).connectors.length === 0, "§3 🔴 a DM with no attested caller reaches none — oe:everyone is never 'anybody'");
  ok(resolve({ ...dm, groups: [EVERYONE_GROUP] , mode: "channel" }).connectors.length === 0, "§3 naming oe:everyone in the request opens no channel");
}

console.log("§4 the registries");
{
  assertBindingsValid([{ bundle: "mcp-server:fullstory", scope: { level: "group", group: EVERYONE_GROUP } }], BUNDLES, []);
  ok(true, "§4 oe:everyone is a known group with an EMPTY registry — nobody declares it");
  refuses(() => assertGroupsValid([{ name: EVERYONE_GROUP, members: ["slack/T1/U1"] }]), "is reserved", "§4 a declared group may not take the name oe:everyone");
  const bare = lintBroadGrants(BUNDLES, [{ bundle: "mcp-server:fullstory", scope: { level: "group", group: EVERYONE_GROUP } }], [], GROUPS);
  ok(bare.some((p) => p.includes("broad credentialed grant (person-group)")), "§4 the lint calls a credentialed oe:everyone binding broad");
  ok(lintBroadGrants(BUNDLES, BINDINGS, [], GROUPS).length === 0, "§4 …and the derived binding carries its allowBroad reason, so it lints clean");
  const wide: Group = { name: "everybody-in-sales", members: Array.from({ length: 8 }, (_, i) => `slack/T1/U${i}`) };
  const narrowTo = (people: McpServerDeclaration["people"]) =>
    defineMcpServers([{ ...FULLSTORY, people } as McpServerDeclaration]);
  const unacked = narrowTo({ groups: [wide.name] });
  ok(
    lintBroadGrants(mcpServerBundles(unacked), mcpServerBindings(unacked), [], [wide]).some((p) => p.includes("person-group")),
    "§4 a broad named group with no people.allowBroad is refused by the lint",
  );
  const acked = narrowTo({ groups: [wide.name], allowBroad: "the whole sales org uses FullStory" });
  ok(mcpServerBindings(acked)[0]?.allowBroad === "the whole sales org uses FullStory", "§4 people.allowBroad is carried onto the derived binding");
  ok(lintBroadGrants(mcpServerBundles(acked), mcpServerBindings(acked), [], [wide]).length === 0, "§4 …and the acknowledged broad group lints clean");
  refuses(() => narrowTo({ groups: [wide.name], allowBroad: " " }), "people.allowBroad is empty", "§4 an empty people.allowBroad is refused");
}

console.log("§5 the build");
{
  const base = { config: {}, lock: undefined, acceptLock: true, packages: [], agentDir: "agent" };
  const plan = planRoster({ ...base, mcpServers: ["fullstory"] });
  const stub = plan.files.find((f) => f.path === "agent/connections/fullstory.ts");
  ok(stub?.content === renderMcpServerStub("fullstory"), "§5 the plan writes one connection stub per declared server");
  ok(stub?.content.includes('declaredMcpServerConnection(MCP_SERVERS, "fullstory")') && stub.content.includes('from "../access/mcp-servers.js"'), "§5 …which builds the connection from the app's own list");
  ok(goldenPlanLines(plan, "agent").includes("agent/connections/fullstory.ts\tmcp-server agent/access/mcp-servers.ts"), "§5 the golden plan names the stub, so the review surface shows it");
  ok(planRoster(base).files.every((f) => !f.path.startsWith("agent/connections/")), "§5 no declared server ⇒ no connection stub (the first-run state)");
  const clash = planRoster({
    ...base,
    mcpServers: ["notion"],
    packages: [
      {
        declaredAs: "core",
        name: "@open-everywhere/core",
        decision: true,
        resolvedName: "@open-everywhere/core",
        version: "0.0.1",
        manifest: { schemaVersion: 1, package: "@open-everywhere/core", contributions: [{ kind: "connection", name: "notion", module: "agent/connections/notion.js" }] },
      },
    ],
  });
  ok(clash.verdict === "invalid" && clash.reds.some((r) => r.startsWith("COLLISION") && r.includes('"notion"')), "§5 a declared name that a package already mounts is refused");
}

console.log("§6 the connection the stub builds");
{
  const { declaredMcpServerConnection } = await import("../agent/connections/mcp-server-connection.js");
  const { declaredConnectionSignIns, _resetConnectionSignInsForTest } = await import("../agent/connections/connection-sign-in.js");
  const { connectorTransportSpec } = await import("../agent/connections/connector-transport.js");
  _resetConnectionSignInsForTest();
  const conn = declaredMcpServerConnection(SERVERS, "fullstory") as unknown as Record<string, unknown>;
  ok(conn["url"] === FULLSTORY.url && conn["description"] === FULLSTORY.description, "§6 the connection dials the declared URL and carries the declared description");
  ok(typeof conn["auth"] === "function" && typeof conn["approval"] === "function", "§6 🔴 it carries the gated auth resolver AND the OE approval policy, as Notion does");
  ok(declaredConnectionSignIns().get(mcpServerHomeRef("fullstory"))?.mode === "discovery-dcr-pkce", "§6 building it declares the sign-in under the server's home ref");
  ok(connectorTransportSpec("fullstory")?.directUrl === FULLSTORY.url, "§6 …and records the transport spec the connection dials");
  refuses(() => declaredMcpServerConnection(SERVERS, "nonesuch"), "declares no such server", "§6 a stub for a server the list no longer declares fails loud (the tree is stale)");
}

console.log(`\n✓ mcp-servers: ${passed} assertions passed`);
