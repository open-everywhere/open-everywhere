import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { registerConfig } from "../agent/access/config.js";
import type { AccessRequestsConfig } from "../agent/access/config.js";
import { insertMcpServerEntry, renderMcpServerEntry } from "../agent/connections/mcp-servers-codemod.js";
import { declaredMcpServers, defineMcpServers, type McpServerDeclaration } from "../agent/connections/mcp-servers.js";
import { executeMcpServerPropose, mcpServerReachLine, mcpServerSetupSteps, requireMcpServerProposeConfig, validateMcpServerProposal, type McpServerProposeArgs } from "../agent/approvals/mcp-server-propose.js";
import proposeTool, { isSecretRef, mcpServerProposeAudienceRefusal, nonMemberWake } from "../agent/tools/propose_mcp_server.js";
import { actionKind } from "../agent/approvals/actions.js";
import { OE_CHAT_NONMEMBER_ATTR } from "../agent/identity/non-member.js";
import { WORKER_CAPABILITY_GROUPS } from "../agent/access/worker-capabilities.js";
import { NEW_CONNECTOR_ROUTE } from "../agent/access/delta.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../..");

let passed = 0;
function ok(cond: unknown, msg: string): void {
  assert.ok(cond, msg);
  passed++;
  console.log(`  ✓ ${msg}`);
}
async function rejects(fn: () => Promise<unknown>, needle: string, msg: string): Promise<void> {
  let err = "";
  try {
    await fn();
  } catch (e) {
    err = e instanceof Error ? e.message : String(e);
  }
  ok(err.includes(needle), `${msg}${err.includes(needle) ? "" : ` — got ${err === "" ? "no throw" : JSON.stringify(err)}`}`);
}

delete process.env.DATABASE_URL;
process.env.OE_SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "oe-mcp-propose-store-")), "ops.sqlite3");

registerConfig({ loadBundles: () => [], loadBindings: () => [], pluginRegistry: {}, skillContent: {}, loadDomains: () => [] } as never);

const FULLSTORY: McpServerDeclaration = {
  name: "fullstory",
  url: "https://api.fullstory.example/mcp",
  description: "FullStory: search sessions and read session summaries.",
};
const STATIC: McpServerDeclaration = {
  name: "acme",
  url: "https://mcp.acme.example/mcp",
  description: "Acme CRM.",
  signIn: {
    mode: "static-confidential",
    authorizationEndpoint: "https://acme.example/oauth/authorize",
    tokenEndpoint: "https://acme.example/oauth/token",
    clientId: "public-id",
    clientSecretRef: "db:acme:oauth-client-secret",
    bodyEncoding: "form",
    scopes: ["accounts.read"],
  },
};
const TEMPLATE = readFileSync(join(REPO, "packages/create/template/agent/access/mcp-servers.ts"), "utf8");

console.log("§1 the codemod adds one entry to the app's list, and the file still loads");
{
  const one = insertMcpServerEntry(TEMPLATE, FULLSTORY);
  ok(one.changed && one.text.includes(renderMcpServerEntry(FULLSTORY)), "§1 the entry lands in the template's list");
  ok(one.text.indexOf(renderMcpServerEntry(FULLSTORY)) < one.text.lastIndexOf("]);"), "§1 …before the list's closing line");
  ok(!insertMcpServerEntry(one.text, FULLSTORY).changed, "§1 a re-request of the same entry changes nothing");
  const two = insertMcpServerEntry(one.text, STATIC);
  const file = join(mkdtempSync(join(tmpdir(), "oe-mcp-propose-")), "mcp-servers.ts");
  writeFileSync(file, two.text.replace("@open-everywhere/core/agent/connections/mcp-servers.js", pathToFileURL(join(HERE, "../agent/connections/mcp-servers.ts")).href));
  const loaded = (await import(pathToFileURL(file).href)) as { MCP_SERVERS: readonly McpServerDeclaration[] };
  ok(JSON.stringify(loaded.MCP_SERVERS.map((s) => s.name)) === JSON.stringify(["fullstory", "acme"]), "§1 the edited file loads, and defineMcpServers holds both entries");
  ok(loaded.MCP_SERVERS[1]!.signIn?.mode === "static-confidential", "§1 a static client survives the round trip");
  const injected = insertMcpServerEntry(TEMPLATE, { ...FULLSTORY, description: 'x"]); process.exit(1); //' });
  ok(injected.text.includes(String.raw`"x\"]); process.exit(1); //"`), "§1 a hostile description stays one escaped JSON string");
  let err = "";
  try {
    insertMcpServerEntry("export const MCP_SERVERS = [];\n", FULLSTORY);
  } catch (e) {
    err = String(e);
  }
  ok(err.includes("Add it by hand"), "§1 a file with no defineMcpServers([ call is refused, naming the hand edit");
  err = "";
  try {
    insertMcpServerEntry('defineMcpServers([\n]);\n// ]);\n]);\n', FULLSTORY);
  } catch (e) {
    err = String(e);
  }
  ok(err.includes("more than one"), "§1 a file with two closing lines is refused, not guessed");
  const bare = 'import { defineMcpServers } from "@open-everywhere/core/agent/connections/mcp-servers.js";\n\nexport const MCP_SERVERS = defineMcpServers([\n  { name: "a", url: "https://a.example/mcp", description: "A." } // no comma\n]);\n';
  const fixed = insertMcpServerEntry(bare, FULLSTORY);
  const bareFile = join(mkdtempSync(join(tmpdir(), "oe-mcp-propose-")), "mcp-servers.ts");
  writeFileSync(bareFile, fixed.text.replace("@open-everywhere/core/agent/connections/mcp-servers.js", pathToFileURL(join(HERE, "../agent/connections/mcp-servers.ts")).href));
  const bareLoaded = (await import(pathToFileURL(bareFile).href)) as { MCP_SERVERS: readonly McpServerDeclaration[] };
  ok(JSON.stringify(bareLoaded.MCP_SERVERS.map((s) => s.name)) === JSON.stringify(["a", "fullstory"]), "§1 a last entry with no trailing comma gets one, and the edited file still loads");
  const callTail = 'import { defineMcpServers } from "@open-everywhere/core/agent/connections/mcp-servers.js";\n\nexport const MCP_SERVERS = defineMcpServers([\n  Object.freeze({ name: "a", url: "https://a.example/mcp", description: "A." })\n]);\n';
  const callFile = join(mkdtempSync(join(tmpdir(), "oe-mcp-propose-")), "mcp-servers.ts");
  writeFileSync(callFile, insertMcpServerEntry(callTail, FULLSTORY).text.replace("@open-everywhere/core/agent/connections/mcp-servers.js", pathToFileURL(join(HERE, "../agent/connections/mcp-servers.ts")).href));
  const callLoaded = (await import(pathToFileURL(callFile).href)) as { MCP_SERVERS: readonly McpServerDeclaration[] };
  ok(JSON.stringify(callLoaded.MCP_SERVERS.map((s) => s.name)) === JSON.stringify(["a", "fullstory"]), "§1 a call-expression last entry with no comma gets one, and the edited file still loads");
  err = "";
  try {
    insertMcpServerEntry("defineMcpServers([\n  ...OTHER_SERVERS\n]);\n", FULLSTORY);
  } catch (e) {
    err = String(e);
  }
  ok(err.includes('list ends in "S"'), "§1 a list that ends in an expression, not an entry, is refused");
  err = "";
  try {
    insertMcpServerEntry("defineMcpServers([\n  { name: \"a\", url: \"https://a.example/mcp\", description: \"A.\" },\n/*\n]);\n*/\n  ]);\n", FULLSTORY);
  } catch (e) {
    err = String(e);
  }
  ok(err.includes("inside a comment or a string"), "§1 a `]);` line inside a block comment is refused, never written into");
}

console.log("§2 external rooms, guests, non-member turns and fires cannot trigger it");
{
  ok(mcpServerProposeAudienceRefusal({ trust: "internal" }, { nonMember: false, actingPrincipal: "U1" }) === undefined, "§2 an internal person on a live turn may propose (negative control)");
  ok(mcpServerProposeAudienceRefusal({ trust: "external" }, { nonMember: false, actingPrincipal: "U1" })?.includes("external") === true, "§2 an external conversation (a shared channel, a guest's DM) is refused");
  ok(mcpServerProposeAudienceRefusal({ trust: "internal" }, { nonMember: true, actingPrincipal: "U1" })?.includes("outside the workspace") === true, "§2 a turn that read a non-member's message is refused");
  ok(mcpServerProposeAudienceRefusal({ trust: "internal" }, { nonMember: false, actingPrincipal: undefined })?.includes("needs a person") === true, "§2 a routine fire (no acting person) is refused");
  const stamped = { session: { auth: { current: { attributes: { [OE_CHAT_NONMEMBER_ATTR]: "true" } } } } } as never;
  const clean = { session: { auth: { current: { attributes: {} } } } } as never;
  ok(nonMemberWake(stamped, undefined) === true && nonMemberWake(clean, undefined) === false, "§2 with no dispatch row, the host-set non-member stamp decides (negative control: no stamp, no refusal)");
  ok(nonMemberWake(clean, true) === true, "§2 a worker whose DISPATCH row says a non-member woke it is refused, even when its launch auth carries no stamp");
  ok(nonMemberWake(stamped, false) === false, "§2 the dispatch row wins over a later sibling's launch auth");
  ok(nonMemberWake(clean) === false, "§2 outside a delegated turn the live default reads no dispatch row");
  const source = readFileSync(join(HERE, "../agent/tools/propose_mcp_server.ts"), "utf8");
  const exec = source.slice(source.indexOf("async execute("));
  ok(exec.indexOf("mcpServerProposeAudienceRefusal(binding") > 0 && exec.indexOf("mcpServerProposeAudienceRefusal(binding") < exec.indexOf("requestApproval("), "§2 execute() asks the audience refusal before it posts the card");
  ok(exec.includes("nonMember: nonMemberWake(ctx)"), "§2 execute() feeds the refusal the live non-member fact");
}

console.log("§2b no secret value reaches the PR");
{
  ok(isSecretRef("db:acme:oauth-client-secret"), "§2b a db:<vendor>:<name> REF is accepted");
  for (const v of ["sk_live_51HxYzAbCdEf", "db:acme:Sk+Live/9x", "acme-oauth-client-secret", "db:acme", ""]) ok(!isSecretRef(v), `§2b ${JSON.stringify(v)} is not a REF, so it is refused`);
  const schema = (proposeTool as unknown as { inputSchema: { safeParse(v: unknown): { success: boolean } } }).inputSchema;
  const base = { name: "acme", url: "https://mcp.acme.example/mcp", description: "Acme.", docUrls: ["https://docs.acme.example/mcp"] };
  const staticSignIn = (ref: string) => ({ mode: "static-confidential", authorizationEndpoint: "https://acme.example/a", tokenEndpoint: "https://acme.example/t", clientId: "id", clientSecretRef: ref, bodyEncoding: "form" });
  ok(schema.safeParse({ ...base, signIn: staticSignIn("db:acme:oauth-client-secret") }).success, "§2b the tool schema accepts a REF (negative control)");
  ok(!schema.safeParse({ ...base, signIn: staticSignIn("sk_live_51HxYzAbCdEf") }).success, "§2b the tool schema refuses a secret-shaped value as clientSecretRef");
}

console.log("§3 the PR");
{
  const baseConfig: AccessRequestsConfig = {
    adminChannel: "C0ADMIN",
    configRepo: "acme/oe-config",
    baseBundles: () => [],
    baseBindings: () => [],
    baseMcpServers: () => [],
  };
  const args: McpServerProposeArgs = {
    org: "default",
    scopeKey: "slack/T1/D1",
    requestId: "11111111-2222-4333-8444-555555555555",
    declaration: STATIC,
    docUrls: ["https://docs.acme.example/mcp", "https://docs.acme.example/oauth"],
    vendorSteps: ["Create an OAuth app in Settings → Integrations"],
    requestedBy: "U1",
    channelId: "D1",
    threadTs: null,
    configRepo: "acme/oe-config",
  };
  let network = 0;
  const dry = await executeMcpServerPropose(args, "U2", { config: { ...baseConfig, dryRun: true }, resolveToken: async () => (network++, "t"), getBranchSha: (async () => { network++; throw new Error("network reached"); }) as never });
  ok(dry.startsWith("dry-run") && network === 0, "§3 dryRun validates and opens nothing");

  const writes: { path: string; content: string }[] = [];
  let body = "";
  const result = await executeMcpServerPropose(args, "U2", {
    config: baseConfig,
    resolveToken: async () => "tok",
    getBranchSha: (async ({ branch }: { branch: string }) => (branch === "main" ? "base-sha" : null)) as never,
    createBranch: (async () => undefined) as never,
    contents: {
      getFile: (async () => ({ content: TEMPLATE, sha: "file-sha" })) as never,
      putFile: (async (_repo: string, path: string, content: string) => {
        writes.push({ path, content });
      }) as never,
    },
    createPr: (async (a: { body: string }) => {
      body = a.body;
      return { url: "https://github.example/acme/oe-config/pull/7", number: 7, updated: false };
    }) as never,
    post: async () => ({ ok: true }),
    postThreadNote: async () => undefined,
    committer: { name: "bot", email: "bot@example.com" },
  });
  ok(result.includes("opened PR #7"), "§3 a live run opens the PR");
  const card = actionKind("mcp-server.propose")!.summarize(args).join("\n");
  for (const field of [STATIC.description, "https://acme.example/oauth/token", "https://acme.example/oauth/authorize", "public-id", "db:acme:oauth-client-secret", "accounts.read"]) {
    ok(card.includes(field), `§3 the card shows ${JSON.stringify(field)} — every field that lands in the file`);
  }
  ok(writes.length === 1 && writes[0]!.path === "agent/access/mcp-servers.ts" && writes[0]!.content.includes(renderMcpServerEntry(STATIC)), "§3 it commits the entry to agent/access/mcp-servers.ts");
  ok(args.docUrls.every((u) => body.includes(u)), "§3 the PR body names every vendor doc URL the agent used");
  ok(body.includes("Create an OAuth app in Settings → Integrations"), "§3 …the vendor-side step the agent named");
  ok(body.includes("/oauth/v1/callback") && body.includes("npx oe secret set db:acme:oauth-client-secret"), "§3 …and, for a static client, the redirect URI and the secret-store command");
  ok(body.includes("EVERY internal person who can DM the agent") && body.includes("only through a person-group that lists them"), "§3 …and says a merged entry reaches every internal person who can DM the agent, and an external one only through a group");
  ok(mcpServerReachLine({ ...FULLSTORY, people: { groups: ["support"] } }).includes("`support`"), "§3 a narrowed entry says which group it reaches");
  ok(mcpServerSetupSteps({ declaration: FULLSTORY, vendorSteps: [] }).length === 0, "§3 a dynamic-registration server adds no client steps");
  network = 0;
  await rejects(
    () => executeMcpServerPropose(args, "U2", { config: { ...baseConfig, baseMcpServers: () => [STATIC] }, resolveToken: async () => (network++, "t"), getBranchSha: (async () => { network++; throw new Error("network reached"); }) as never }),
    "declared twice",
    "§3 a name the app already declares is refused",
  );
  ok(network === 0, "§3 …before any network");
  network = 0;
  await rejects(
    () => executeMcpServerPropose({ ...args, declaration: { ...FULLSTORY, name: "notion" } }, "U2", { config: baseConfig, resolveToken: async () => (network++, "t"), getBranchSha: (async () => { network++; throw new Error("network reached"); }) as never }),
    'a connection or tool named "notion" is already mounted',
    "§3 a name a core connection already mounts is refused, because oe build would refuse it after the merge",
  );
  ok(network === 0, "§3 …before any network");
  const toolSource = readFileSync(join(HERE, "../agent/tools/propose_mcp_server.ts"), "utf8");
  ok(toolSource.includes("validateMcpServerProposal(declaration, cfg.baseMcpServers!())"), "§3 the tool runs the same validation at propose time, before the card");
  ok((() => {
    try {
      requireMcpServerProposeConfig({ ...baseConfig, baseMcpServers: undefined });
      return false;
    } catch (e) {
      return String(e).includes("baseMcpServers");
    }
  })(), "§3 a deployment with no MCP server baseline refuses, naming it");
}

console.log("§3b a proposal never changes the live MCP-server registry (OPE-2642)");
{
  const declared = defineMcpServers([FULLSTORY]);
  const names = () => declaredMcpServers().map((s) => s.name).join();
  ok(names() === "fullstory", "§3b the app's declaration records its own list (negative control)");
  validateMcpServerProposal(STATIC, declared);
  ok(names() === "fullstory", `§3b a valid candidate that propose_mcp_server validates does not enter the registry — got ${JSON.stringify(names())}`);
  const dry = await executeMcpServerPropose(
    {
      org: "default",
      scopeKey: "slack/T1/D1",
      requestId: "22222222-3333-4444-8555-666666666666",
      declaration: STATIC,
      docUrls: ["https://docs.acme.example/mcp"],
      vendorSteps: [],
      requestedBy: "U1",
      channelId: "D1",
      threadTs: null,
      configRepo: "acme/oe-config",
    },
    "U2",
    { config: { adminChannel: "C0ADMIN", configRepo: "acme/oe-config", baseBundles: () => [], baseBindings: () => [], baseMcpServers: () => declaredMcpServers(), dryRun: true } },
  );
  ok(dry.includes("validation passed"), "§3b the send path validates the candidate (negative control)");
  ok(names() === "fullstory", `§3b …and a member's send does not put it in the registry either — got ${JSON.stringify(names())}`);
  defineMcpServers([]);
}

console.log("§4 the routing sends \"set up X\" to propose_mcp_server");
{
  for (const rel of ["agent/instructions.md", "packages/create/template/agent/instructions.md"]) {
    const text = readFileSync(join(REPO, rel), "utf8");
    ok(/\*\*Set up a new connector\.\*\*[\s\S]{0,400}`propose_mcp_server`[\s\S]{0,200}agent\/access\/mcp-servers\.ts/u.test(text), `§4 ${rel}: the seat prompt routes "set up X" to propose_mcp_server and names mcp-servers.ts`);
  }
  const group = WORKER_CAPABILITY_GROUPS.find((g) => g.tools.includes("propose_mcp_server"));
  ok(group !== undefined && /set up a vendor's hosted MCP server/u.test(group.headline), "§4 the worker-capability headline a seat routes by names the set-up ask");
  ok(NEW_CONNECTOR_ROUTE.includes("propose_mcp_server") && !NEW_CONNECTOR_ROUTE.includes("bundles.ts"), "§4 request_access's undefined-connector refusal names propose_mcp_server, not bundles.ts");
}

console.log(`\n✓ mcp-server-propose: ${passed} assertions passed`);
