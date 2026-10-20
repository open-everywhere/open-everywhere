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
  const XAA = {
    mode: "xaa",
    idpIssuer: "https://acme.okta.com",
    idpClientId: "0oaOE",
    idpClientSecretRef: "db:okta:oe-client-secret",
    audience: "https://auth.fullstory.example",
    resourceTokenEndpoint: "https://auth.fullstory.example/token",
    resourceClientId: "fs-client-for-oe",
    resourceClientSecretRef: "db:fullstory:xaa-client-secret",
  } as const;
  ok(defineMcpServers([{ ...FULLSTORY, signIn: XAA }]).length === 1, "§1 an xaa sign-in with every field is a whole declaration");
  refuses(one({ signIn: { ...XAA, resourceClientSecretRef: "" } }), "needs resourceClientSecretRef", "§1 an xaa sign-in with no app secret REF is refused");
  refuses(one({ signIn: { ...XAA, idpClientSecret: "s3cret" } as never }), "literal idpClientSecret", "§1 🔴 a literal IdP client secret is refused");
  const xaaSignIn = mcpServerConnectionSignIn({ ...FULLSTORY, signIn: XAA });
  ok(xaaSignIn.mode === "xaa" && "resource" in xaaSignIn && xaaSignIn.resource === FULLSTORY.url, "§1 an xaa sign-in names the server's URL as the resource both legs carry");
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
  const dm: ResolveRequest = { mode: "dm", platform: "slack", workspace: "T1", channel: "D1", principalId: "U1", callerTrust: "internal" };
  const inDm = resolve(dm);
  ok(inDm.connectors.includes("fullstory"), "§3 🔴 in a DM, an attested internal caller reaches a declared server");
  ok(inDm.connectorCredentials["fullstory"]?.principal === "user", "§3 …as THEMSELVES: the bound credential is user-principal");
  ok(!inDm.connectors.includes("acme"), "§3 a server narrowed to a group is not reached by a caller outside it");
  ok(resolve({ ...dm, groups: ["sales"] }).connectors.includes("acme"), "§3 …and is reached by a caller inside it");
  ok(resolve({ ...dm, mode: "channel", channel: "C1" }).connectors.length === 0, "§3 🔴 a channel reaches no declared server: a personal login never resolves there");
  ok(resolve({ ...dm, mode: "mpim" }).connectors.length === 0, "§3 🔴 a group DM reaches none either");
  const { principalId: _p, ...anonymous } = dm;
  ok(resolve(anonymous).connectors.length === 0, "§3 🔴 a DM with no attested caller reaches none — oe:everyone is never 'anybody'");
  ok(resolve({ ...dm, groups: [EVERYONE_GROUP] , mode: "channel" }).connectors.length === 0, "§3 naming oe:everyone in the request opens no channel");

  const external: ResolveRequest = { ...dm, principalId: "UEXT", callerTrust: "external" };
  ok(resolve(external).connectors.length === 0, "§3 🔴 an EXTERNAL DM caller (a Slack Connect user, a guest) reaches no declared server by default");
  const { callerTrust: _t, ...unstated } = dm;
  ok(resolve(unstated).connectors.length === 0, "§3 🔴 a DM request with no caller trust fails closed: it reaches none");
  ok(resolve({ ...dm, callerTrust: "Internal" as never }).connectors.length === 0, "§3 🔴 only the exact verdict `internal` admits — an unknown value reaches none");
  ok(resolve({ ...external, groups: [EVERYONE_GROUP] }).connectors.length === 0, "§3 🔴 an external caller who CARRIES oe:everyone in its groups is still not in it");
  ok(resolve({ ...dm, platform: "discord", workspace: "G1", principalId: "D9", callerTrust: "external" }).connectors.length === 0, "§3 🔴 an external caller on another platform reaches none (the real Discord mapper's verdict: scripts/discord-provider-integration-test.ts)");
  ok(resolve({ ...external, groups: ["sales"] }).connectors.join() === "acme", "§3 an external caller in a DECLARED group reaches that group's server, and only it");
  const named = resolveAccess(external, BUNDLES, [...BINDINGS, { bundle: "mcp-server:fullstory", scope: { level: "principal", principal: "slack/T1/UEXT" } }], {}, CATALOGUES);
  ok(named.connectors.includes("fullstory"), "§3 …and a principal binding that names the external caller grants them the server on purpose");
  ok(resolve({ ...dm, mode: "channel", channel: "C1", callerTrust: "internal" }).connectors.length === 0, "§3 an internal trust verdict opens no channel either");
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

console.log("§7 a personal-surface server (OPE-2421)");
{
  const SLACK_AS_YOU: McpServerDeclaration = {
    name: "slack-as-you",
    url: "https://mcp.slack.com/mcp",
    description: "Search Slack as you.",
    personalSurface: { platform: "slack", label: "Slack" },
  };
  const one = (s: Partial<McpServerDeclaration>) => () => defineMcpServers([{ ...SLACK_AS_YOU, ...s } as McpServerDeclaration]);
  refuses(one({ personalSurface: { platform: "Slack Inc", label: "Slack" } }), "personalSurface.platform", "§7 a platform that is not a bare name is refused");
  refuses(one({ personalSurface: { platform: "slack", label: " " } }), "personalSurface.label", "§7 an empty label is refused");
  const servers = defineMcpServers([SLACK_AS_YOU]);
  const catalogues = mcpServerConnectorCredentials(servers);
  const bundles = mcpServerBundles(servers);
  const bindings = mcpServerBindings(servers);
  const cat = catalogues[0]!;
  ok(
    cat.credentials.map((c) => c.type).join() === "user-oauth" && cat.allows.join() === "user-oauth",
    "§7 🔴 it carries the person's user-oauth credential ONLY — no org credential an admin could grant to a channel",
  );
  ok(bindings.length === 1 && bindings[0]!.scope.platform === "slack" && bindings[0]!.scope.group === EVERYONE_GROUP, "§7 its binding is narrowed to its own platform");
  assertConnectorCredentialsValid(catalogues);
  assertBundlesValid(bundles);
  assertBindingsValid(bindings, bundles, []);
  ok(lintBroadGrants(bundles, bindings, [], []).length === 0, "§7 the derived config passes core's config-load checks and the broad-grant lint");
  refuses(
    () => assertBindingsValid([{ bundle: bundles[0]!.name, scope: { level: "domain", domain: "eng", platform: "slack" } }], bundles, []),
    "only a group-level binding takes a platform",
    "§7 a platform narrowing on a container scope is refused, never ignored",
  );
  refuses(
    () => assertBindingsValid([{ bundle: bundles[0]!.name, scope: { level: "group", group: EVERYONE_GROUP, platform: "slack/T1" } }], bundles, []),
    "BARE platform name",
    "§7 a qualified platform is refused",
  );

  const botSlack: (typeof bundles)[number] = {
    name: "bot-slack",
    connections: [{ id: "slack-bot", credentialType: "bearer", secretRef: "SLACK_BOT_TOKEN", broker: "env", allowedWebsites: ["slack.com"] }],
  };
  const all = [...bundles, botSlack];
  const allBindings = [...bindings, { bundle: "bot-slack", scope: { level: "principal" as const, principal: "slack/T1/U1" } }];
  const resolve = (req: ResolveRequest) => resolveAccess(req, all, allBindings, {}, catalogues);
  const slackDm: ResolveRequest = { mode: "dm", platform: "slack", workspace: "T1", channel: "D1", principalId: "U1", callerTrust: "internal" };
  const inDm = resolve(slackDm);
  ok(inDm.connectors.includes("slack-as-you") && inDm.connectorCredentials["slack-as-you"]?.principal === "user", "§7 🔴 a Slack DM reaches it, as the person");
  ok(
    inDm.reachableHosts.some((h) => h.host === "slack.com" && h.viaConnection === "slack-bot") && !inDm.reachableHosts.some((h) => h.host.includes("mcp.slack.com")),
    "§7 🔴 it rides the connector plane: the DM's egress keeps the bot's Slack key and gains no Slack MCP host",
  );
  ok(!resolve({ ...slackDm, platform: "discord", workspace: "G1" }).connectors.includes("slack-as-you"), "§7 🔴 a DM on ANOTHER platform does not reach it");
  ok(!resolve({ ...slackDm, callerTrust: "external" }).connectors.includes("slack-as-you"), "§7 🔴 an external Slack DM partner (a Slack Connect user, a guest) does not reach it (OPE-2415)");
  ok(!resolve({ ...slackDm, mode: "channel", channel: "C1" }).connectors.includes("slack-as-you"), "§7 🔴 a Slack channel does not reach it");
  ok(!resolve({ ...slackDm, mode: "mpim", channel: "G2" }).connectors.includes("slack-as-you"), "§7 🔴 a Slack group DM does not reach it");
  const { CREDENTIAL_GRANT_ROLES } = await import("../agent/access/credential-grant.js");
  ok(!CREDENTIAL_GRANT_ROLES.some((r) => r.connector === "slack-as-you"), "§7 🔴 it is not a credential-grant connector, so no channel can borrow it");

  const copy = bundles[0]!.instructions ?? "";
  ok(copy.includes("Answer from your own Slack access (the bot) first"), "§7 the seat's copy says the bot answers first");
  ok(copy.includes("I can only see channels I am in. Want me to see what you see?"), "§7 …and makes the offer in the moment, in the agreed words");
  ok(copy.includes("approval card first"), "§7 …and says a write as the person takes a card");

  const { personalSurfaceRefusal } = await import("../agent/connections/personal-surface-fence.js");
  const rows: { action: string; detail?: Readonly<Record<string, unknown>> }[] = [];
  const audit = async (row: { action: string; detail?: Readonly<Record<string, unknown>> }) => void rows.push(row);
  const at = (mode: string | undefined, platform: string | undefined) => ({
    audit,
    dmPrincipal: async () => ({ ...(mode ? { mode } : {}), ...(platform ? { platform } : {}) }),
  });
  const auth = {} as never;
  ok((await personalSurfaceRefusal("slack-as-you", "slack", auth, at("dm", "slack"))) === undefined, "§7 the fence passes a 1:1 DM on its own platform");
  ok(rows.length === 0, "§7 …and writes no refusal row for it");
  ok(((await personalSurfaceRefusal("slack-as-you", "slack", auth, at("channel", "slack"))) ?? "").includes("a channel on slack"), "§7 🔴 the fence refuses a channel");
  ok(
    rows[0]?.action === "connector.refused" && rows[0]?.detail?.["reason"] === "personal_surface" && rows[0]?.detail?.["mode"] === "channel",
    "§7 …and audits the refusal as connector.refused, reason personal_surface",
  );
  ok(((await personalSurfaceRefusal("slack-as-you", "slack", auth, at("mpim", "slack"))) ?? "").includes("a group DM"), "§7 🔴 the fence refuses a group DM");
  ok(((await personalSurfaceRefusal("slack-as-you", "slack", auth, at("dm", "discord"))) ?? "").includes("a DM on discord"), "§7 🔴 the fence refuses a DM on another platform");
  ok(
    (await personalSurfaceRefusal("slack-as-you", "slack", auth, { audit, dmPrincipal: async () => Promise.reject(new Error("x")) })) !== undefined,
    "§7 🔴 an unreadable surface is refused (fail closed)",
  );
  ok((await personalSurfaceRefusal("slack-as-you", "slack", undefined, at("dm", "slack"))) !== undefined, "§7 🔴 a call with no auth is refused");

  const { personalSurfaceUnattendedWriteRefusal, personalSurfaceApprovalRefusal, declarePersonalSurfaceConnection } = await import(
    "../agent/connections/personal-surface-fence.js"
  );
  const noHints = async () => undefined;
  const writeAt = (attended: boolean | undefined) => ({ audit, toolHints: noHints, attended: async () => attended });
  const WRITE = "slack-as-you__slack_send_message";
  const READ = "slack-as-you__slack_read_channel";
  rows.length = 0;
  ok((await personalSurfaceUnattendedWriteRefusal("slack-as-you", WRITE, auth, writeAt(true))) === undefined, "§7 an ATTENDED write passes on, to the ordinary card");
  ok(
    ((await personalSurfaceUnattendedWriteRefusal("slack-as-you", WRITE, auth, writeAt(false))) ?? "").includes("A routine permission does not lift it"),
    "§7 🔴 an UNATTENDED write is refused — a routine permission cannot post in the person's name",
  );
  ok(rows[0]?.detail?.["reason"] === "personal_surface_unattended", "§7 …and the refusal is audited");
  ok((await personalSurfaceUnattendedWriteRefusal("slack-as-you", WRITE, auth, writeAt(undefined))) !== undefined, "§7 🔴 an unreadable attendance refuses the write (fail closed)");
  ok((await personalSurfaceUnattendedWriteRefusal("slack-as-you", READ, auth, writeAt(false))) === undefined, "§7 an unattended READ still runs");
  declarePersonalSurfaceConnection("slack-as-you", "slack");
  const both = (attended: boolean) => ({ ...at("dm", "slack"), toolHints: noHints, attended: async () => attended });
  ok((await personalSurfaceApprovalRefusal(WRITE, auth, both(true))) === undefined, "§7 the approval fence passes an attended write in the person's Slack DM");
  ok((await personalSurfaceApprovalRefusal(WRITE, auth, both(false))) !== undefined, "§7 🔴 …and refuses the same write on an unattended turn");
  ok((await personalSurfaceApprovalRefusal("notion__create_page", auth, both(false))) === undefined, "§7 a connection no personal-surface declaration names passes untouched");

  const { declaredMcpServerConnection } = await import("../agent/connections/mcp-server-connection.js");
  const conn = declaredMcpServerConnection(servers, "slack-as-you") as unknown as {
    auth: (ctx: unknown) => Promise<unknown>;
    approval: (ctx: unknown) => Promise<unknown>;
  };
  const verdict = (await conn.approval({ toolName: "slack-as-you__slack_send_message", approvedTools: new Set(), session: {} })) as { type?: string; reason?: string };
  ok(verdict?.type === "denied" && String(verdict.reason).includes("answers only in that person's 1:1 DM"), "§7 🔴 the built connection's approval denies a call it cannot place in a DM, before any card");
  let authErr = "";
  try {
    await conn.auth({ session: {} });
  } catch (e) {
    authErr = e instanceof Error ? e.message : String(e);
  }
  ok(authErr.includes("answers only in that person's 1:1 DM"), "§7 🔴 the built connection's auth refuses it too, before any mint");

  const { declaredMcpServers, validateMcpServers } = await import("../agent/connections/mcp-servers.js");
  ok(declaredMcpServers().map((s) => s.name).join() === "slack-as-you", "§7 defineMcpServers records the list the app declared, for a provider's ops plane");
  ok(validateMcpServers([FULLSTORY]).length === 1, "§7 validateMcpServers accepts a whole declaration (negative control)");
  ok(declaredMcpServers().map((s) => s.name).join() === "slack-as-you", "§7 🔴 validateMcpServers records nothing: an unapproved list never reaches the ops plane (OPE-2642)");
}

console.log("§8 the seam: the DM binding's trust reaches the resolver (OPE-2415)");
{
  const { registerSlackFixtureMapper } = await import("./_slack-test-stubs.js");
  registerSlackFixtureMapper();
  const { registerConfig } = await import("../agent/access/config.js");
  registerConfig({
    loadBundles: () => BUNDLES,
    loadBindings: () => BINDINGS,
    pluginRegistry: {},
    skillContent: {},
    loadDomains: () => [],
    loadSilos: () => [],
    domainsForSurface: () => [],
    loadGroups: () => GROUPS,
  });
  const { buildResolveRequest } = await import("../agent/access/request.js");
  const ctx = (attrs: Record<string, string>, user = "U1"): never =>
    ({
      channel: { kind: "slack" },
      session: { auth: { current: { attributes: { team_id: "T1", channel_id: "D1", channel_type: "im", user_id: user, ...attrs }, principalId: user, principalType: "slack-user" } } },
    }) as never;
  const reach = (c: never) => resolveAccess(buildResolveRequest(c), BUNDLES, BINDINGS, {}, CATALOGUES);
  const internalReq = buildResolveRequest(ctx({ dm_partner_trust: "internal" }));
  ok(internalReq.callerTrust === "internal", "§8 a verified internal Slack DM partner carries callerTrust internal");
  ok(reach(ctx({ dm_partner_trust: "internal" })).connectors.includes("fullstory"), "§8 🔴 …and reaches the declared server through the real request builder");
  ok(reach(ctx({ dm_partner_trust: "external" }, "UEXT")).connectors.length === 0, "§8 🔴 a verified EXTERNAL Slack DM partner reaches none");
  ok(reach(ctx({}, "UEXT")).connectors.length === 0, "§8 🔴 an UNVERIFIED DM partner fails closed to external and reaches none");
  ok(reach(ctx({ dm_partner_trust: "external" }, "USALES")).connectors.join() === "acme", "§8 an external partner listed in a declared group reaches that group's server only");
  const channelReq = buildResolveRequest(ctx({ channel_type: "channel", channel_id: "C1", trust_checked: "true" }));
  ok(channelReq.callerTrust === undefined, "§8 a channel request carries no caller trust: a group binding never resolves there");
}

console.log(`\n✓ mcp-servers: ${passed} assertions passed`);
