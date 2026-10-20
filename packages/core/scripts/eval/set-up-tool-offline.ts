import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { insertMcpServerEntry, renderMcpServerEntry } from "../../agent/connections/mcp-servers-codemod.js";
import { validateMcpServers, type McpServerDeclaration } from "../../agent/connections/mcp-servers.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../../..");

export const SET_UP_ASK = "can you set up FullStory for us? we want to search sessions from here";

export const DOCS_URL = "https://developer.fullstory.com/docs/mcp-server";
export const MCP_URL = "https://mcp.fullstory.com/v1/mcp";
export const CANNED_SEARCH = [
  { title: "FullStory MCP server — FullStory Developers", url: DOCS_URL, snippet: "Connect AI agents to FullStory with the hosted MCP server." },
  { title: "Community FullStory MCP (unofficial) — GitHub", url: "https://github.com/someone/fullstory-mcp", snippet: "An unofficial self-hosted server." },
];
export const CANNED_PAGES: Readonly<Record<string, string>> = {
  [DOCS_URL]:
    "# FullStory MCP server\n\nFullStory hosts an MCP server for AI agents. Endpoint: `" +
    MCP_URL +
    "`. Clients sign in with OAuth 2.1; the server supports dynamic client registration, so no client needs to be created in FullStory. Tools: search_sessions, get_session_summary.",
  "https://mcp.fullstory.com/.well-known/oauth-protected-resource/v1/mcp": JSON.stringify({ resource: MCP_URL, authorization_servers: ["https://auth.fullstory.com"] }),
  "https://mcp.fullstory.com/.well-known/oauth-protected-resource": JSON.stringify({ resource: MCP_URL, authorization_servers: ["https://auth.fullstory.com"] }),
  "https://auth.fullstory.com/.well-known/oauth-authorization-server": JSON.stringify({
    issuer: "https://auth.fullstory.com",
    authorization_endpoint: "https://auth.fullstory.com/authorize",
    token_endpoint: "https://auth.fullstory.com/token",
    registration_endpoint: "https://auth.fullstory.com/register",
  }),
};

export interface RecordedCall {
  readonly name: string;
  readonly input: Record<string, unknown>;
}

export interface SetUpScore {
  readonly pass: boolean;
  readonly reasons: readonly string[];
  readonly diffEntry?: string;
}

export function scoreSetUpRun(calls: readonly RecordedCall[]): SetUpScore {
  const reasons: string[] = [];
  const fetched = new Set(calls.filter((c) => c.name === "web_fetch").map((c) => String(c.input["url"] ?? "")));
  const searched = calls.some((c) => c.name === "web_search");
  const proposals = calls.filter((c) => c.name === "propose_mcp_server");
  if (!searched && fetched.size === 0) reasons.push("it proposed without researching (no web_search, no web_fetch)");
  if (calls.some((c) => c.name === "request_access")) reasons.push("it reached for request_access, which cannot add a new connector");
  if (proposals.length !== 1) {
    reasons.push(proposals.length === 0 ? "it never called propose_mcp_server" : `it called propose_mcp_server ${proposals.length} times`);
    return { pass: false, reasons };
  }
  const input = proposals[0]!.input;
  if (input["url"] !== MCP_URL) reasons.push(`the url is ${JSON.stringify(input["url"])}, not the documented ${MCP_URL}`);
  const signIn = input["signIn"] as { mode?: string } | undefined;
  if (signIn?.mode === "static-confidential") reasons.push("it declared a static client although the metadata advertises dynamic registration");
  const docUrls = Array.isArray(input["docUrls"]) ? (input["docUrls"] as unknown[]).map(String) : [];
  if (!docUrls.includes(DOCS_URL)) reasons.push("docUrls does not name the vendor page the entry came from");
  if (docUrls.some((u) => !fetched.has(u) && !CANNED_SEARCH.some((r) => r.url === u))) reasons.push("docUrls names a page it neither fetched nor found");
  if (docUrls.some((u) => u.includes("github.com/someone"))) reasons.push("it cited the unofficial community server");
  let diffEntry: string | undefined;
  try {
    const declaration: McpServerDeclaration = {
      name: String(input["name"]),
      url: String(input["url"]),
      description: String(input["description"]),
      ...(signIn !== undefined && signIn.mode !== "static-confidential" && Array.isArray((signIn as { scopes?: unknown }).scopes) ? { signIn: { scopes: (signIn as { scopes: string[] }).scopes } } : {}),
    };
    validateMcpServers([declaration]);
    const template = readFileSync(join(REPO, "packages/create/template/agent/access/mcp-servers.ts"), "utf8");
    const edited = insertMcpServerEntry(template, declaration);
    diffEntry = renderMcpServerEntry(declaration);
    if (!edited.changed || !edited.text.includes(diffEntry)) reasons.push("the codemod did not add the entry");
  } catch (e) {
    reasons.push(`the proposed entry does not validate: ${e instanceof Error ? e.message : String(e)}`);
  }
  return { pass: reasons.length === 0, reasons, ...(diffEntry !== undefined ? { diffEntry } : {}) };
}

async function main(): Promise<void> {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  delete process.env.DATABASE_URL;
  process.env.OE_SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "oe-set-up-eval-")), "ops.sqlite3");
  const { generateText, tool, stepCountIs, gateway } = await import("ai");
  const { z } = await import("zod");
  const { renderScopeMarkdown } = await import("../../agent/instructions/access.js");
  const { registerConfig } = await import("../../agent/access/config.js");
  const { defineDomain } = await import("../../agent/memory/domain.js");
  const { registerSlackFixtureMapper, registerSlackTestBridge } = await import("../_slack-test-stubs.js");
  const { registerCapabilityManifest } = await import("../../agent/identity/capabilities.js");
  const { defaultAgentModelId } = await import("../../agent/model/default-model.js");
  const propose = (await import("../../agent/tools/propose_mcp_server.js")).default as unknown as { description: string; inputSchema: unknown };
  const N = Number.parseInt(process.argv.find((a) => a.startsWith("--n="))?.slice(4) ?? "3", 10);
  const MODEL_ID = process.env.OPE2420_MODEL ?? defaultAgentModelId();

  registerSlackTestBridge({ botDisplayName: async () => "Test Bot" });
  registerSlackFixtureMapper();
  registerCapabilityManifest("slack", { midTurnPost: true, reactions: true, closingProseDropped: true });
  registerConfig({
    loadBundles: () => [],
    loadBindings: () => [],
    pluginRegistry: {},
    skillContent: {},
    loadDomains: () => [defineDomain({ name: "org", match: "org" })],
    loadSilos: () => [],
    domainsForSurface: () => [],
  } as never);
  const workerCtx = {
    channel: { kind: "subagent", continuationToken: "subagent:sess_dm:call_ope2420" },
    session: { auth: { current: { principalId: "U_ANA", attributes: { oe_platform: "slack", team_id: "T_E", channel_id: "D_ANA", channel_type: "im", user_id: "U_ANA", trust_checked: "true" } } } },
  };
  const system = `${readFileSync(join(REPO, "agent/instructions.md"), "utf8")}\n\n${await renderScopeMarkdown(workerCtx as never)}`;
  const brief = `The person in this DM asked: "${SET_UP_ASK}". Set it up for them the way this deployment adds a new tool, and report what you did.`;

  let passes = 0;
  for (let i = 0; i < N; i++) {
    const calls: RecordedCall[] = [];
    const record = (name: string) => (input: Record<string, unknown>) => {
      calls.push({ name, input });
    };
    const tools = {
      web_search: tool({
        description: "Search the public web. Returns titles, URLs and snippets.",
        inputSchema: z.object({ query: z.string() }),
        execute: async (input) => (record("web_search")(input), { results: CANNED_SEARCH }),
      }),
      web_fetch: tool({
        description: "Fetch one public web page or JSON document by URL.",
        inputSchema: z.object({ url: z.string() }),
        execute: async (input) => (record("web_fetch")(input), CANNED_PAGES[input.url] ?? `HTTP 404 for ${input.url}`),
      }),
      propose_mcp_server: tool({
        description: propose.description,
        inputSchema: propose.inputSchema as never,
        execute: async (input: Record<string, unknown>) => (record("propose_mcp_server")(input), { proposed: true, pending: true, pendingId: "p_eval", name: input["name"], message: "Card posted — approving it opens a PR against acme/oe-config adding the entry." }),
      }),
      request_access: tool({
        description: "Request access this scope lacks: widen a connection or grant an already-defined connector.",
        inputSchema: z.object({ kind: z.string(), connector: z.string().optional() }),
        execute: async (input) => (record("request_access")(input), { error: "connector isn't defined" }),
      }),
    };
    const out = await generateText({ model: gateway(MODEL_ID), system, prompt: brief, tools, stopWhen: stepCountIs(12) });
    const score = scoreSetUpRun(calls);
    if (score.pass) passes++;
    console.log(`run ${i + 1}/${N}: ${score.pass ? "PASS" : "FAIL"} — calls: ${calls.map((c) => c.name).join(", ") || "(none)"}${score.reasons.length ? ` — ${score.reasons.join("; ")}` : ""}`);
    if (score.diffEntry !== undefined && i === 0) console.log(`  the PR's entry:\n${score.diffEntry}`);
    if (!score.pass) console.log(`  final text: ${out.text.slice(0, 400)}`);
  }
  console.log(`\nset-up-tool eval (${MODEL_ID}): ${passes}/${N} passed`);
  process.exit(passes === N ? 0 : 1);
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await main();
}
