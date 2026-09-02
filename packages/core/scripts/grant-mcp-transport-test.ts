import assert from "node:assert/strict";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { resetRegisteredConnectorCredentials, setRegisteredConnectorCredentials, vercelConnectorHome } from "../agent/access/connector-credentials.js";
import { McpCallFenceError } from "../agent/access/mcp-call-fence.js";
import type { GrantOwnerSubject } from "../agent/access/credential-grant-owner.js";
import { grantMcpTransport } from "../agent/connections/grant-mcp-transport.js";
import { borrowDeadline, borrowRetryFetch, grantBorrowFetch } from "../agent/connections/grant-mcp-borrow.js";
import type { ConnectorTransportSpec } from "../agent/connections/connector-transport.js";
import type { CredentialGrantRow } from "../agent/operational/credential-grant-rows.js";

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};
const eq = (a: unknown, b: unknown, label: string): void => {
  assert.deepStrictEqual(a, b, label);
  n++;
};

const MCP_URL = "https://mcp.notion.com/mcp";
const OWNER_SUBJECT = "oe-org:slack:W1:U-OWNER";
const REQUESTER_SUBJECT = "oe-org:slack:W1:U-REQUESTER";
const OWNER: GrantOwnerSubject = { org: "oe-org", vaultSubject: OWNER_SUBJECT };

const SPEC: ConnectorTransportSpec = { connector: "notion", directUrl: MCP_URL, provider: "notion" };

const catalogue = (endpoints?: { readonly hosts: readonly string[] }): void => {
  setRegisteredConnectorCredentials([
    {
      allows: ["user-oauth"],
      connector: "notion",
      credentials: [
        {
          home: vercelConnectorHome("mcp.notion.com/notion-mcp"),
          id: "user-oauth",
          type: "user-oauth",
          ...(endpoints === undefined ? {} : { endpoints }),
        },
      ],
    },
  ]);
};

const grantRow = (over: Partial<CredentialGrantRow> = {}): CredentialGrantRow => ({
  askId: "ask-1",
  connector: "notion",
  createdAt: "2026-08-25T10:00:00.000Z",
  expiresAt: "2099-01-01T00:00:00.000Z",
  frozenArgs: { page_id: "OWNER-PAGE" },
  id: "grant-1",
  inputSchema: { properties: { page_id: { const: "OWNER-PAGE", type: "string" }, page_size: { type: "number" } }, required: ["page_id"], type: "object" },
  mcpTool: "notion-fetch",
  mode: "session",
  ownerPrincipalId: "slack/W1/U-OWNER",
  ownerSlug: "rowan",
  purpose: "read the launch page",
  requesterPrincipalId: "slack/W1/U-REQUESTER",
  resource: "notion-fetch page_id=OWNER-PAGE",
  scopeKey: "wrun_1",
  status: "active",
  tier: "read",
  toolName: "grant__rowan_notion__notion_fetch",
  verb: "notion_fetch",
  ...over,
});

interface SeenRequest {
  readonly method: string;
  readonly url: string;
  readonly redirect: string | undefined;
  readonly authorization: string | null;
  readonly body: Record<string, unknown> | undefined;
}

function fakeMcpServer(
  opts: {
    readonly toolResult?: unknown;
    readonly refuseCalls?: number;
    readonly refusalStatus?: number;
    readonly refusalRetryAfter?: string;
  } = {},
): { readonly fetch: FetchLike; readonly seen: SeenRequest[] } {
  const seen: SeenRequest[] = [];
  let refused = 0;
  const json = (body: unknown, extra: Record<string, string> = {}): Response =>
    new Response(JSON.stringify(body), { headers: { "content-type": "application/json", ...extra }, status: 200 });
  const fetch: FetchLike = async (url, init) => {
    const method = (init?.method ?? "GET").toUpperCase();
    const raw = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    seen.push({
      authorization: new Headers(init?.headers).get("authorization"),
      body: raw,
      method,
      redirect: init?.redirect,
      url: typeof url === "string" ? url : url.href,
    });
    if (method === "GET") return new Response(null, { status: 405 });
    if (method === "DELETE") return new Response(null, { status: 200 });
    const rpc = raw ?? {};
    const id = rpc["id"];
    if (rpc["method"] === "initialize") {
      const params = rpc["params"] as { readonly protocolVersion?: string } | undefined;
      return json(
        {
          id,
          jsonrpc: "2.0",
          result: {
            capabilities: { tools: {} },
            protocolVersion: params?.protocolVersion ?? "2025-06-18",
            serverInfo: { name: "fake-notion-mcp", version: "1.0.0" },
          },
        },
        { "mcp-session-id": "sess-abc" },
      );
    }
    if (rpc["method"] === "notifications/initialized") return new Response(null, { status: 202 });
    if (rpc["method"] === "tools/call") {
      if (refused < (opts.refuseCalls ?? 0)) {
        refused += 1;
        const headers = new Headers({ "content-type": "application/json" });
        if (opts.refusalRetryAfter !== undefined) headers.set("retry-after", opts.refusalRetryAfter);
        return new Response(JSON.stringify({ message: "rate limited" }), { headers, status: opts.refusalStatus ?? 429 });
      }
      return json({ id, jsonrpc: "2.0", result: opts.toolResult ?? { content: [{ text: "the page body", type: "text" }] } });
    }
    return json({ error: { code: -32601, message: "method not found" }, id, jsonrpc: "2.0" });
  };
  return { fetch, seen };
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
};

console.log("1. the fence sits in the real SDK's request path:");
{
  catalogue({ hosts: ["mcp.notion.com"] });
  const server = fakeMcpServer();
  const minted: { provider: string; ref: string; subject: string }[] = [];
  const transport = grantMcpTransport({
    connectorSpec: () => SPEC,
    fetch: server.fetch,
    mintOwnerToken: async (provider, ref, subject) => {
      minted.push({ provider, ref, subject });
      return "OWNER-TOKEN";
    },
  });
  const result = (await transport({ input: { page_id: "OWNER-PAGE", page_size: 5 }, mcpTool: "notion-fetch" }, grantRow(), OWNER)) as { content: unknown };
  await settle();

  eq(result.content, [{ text: "the page body", type: "text" }], "the borrow returns the vendor's tools/call result, unshaped");
  ok(
    server.seen.every((r) => r.redirect === "error"),
    "EVERY request the vendor saw carries redirect:\"error\" — the fence wrapper, not the bare SDK fetch, sent it",
  );
  eq(
    server.seen.filter((r) => r.method === "GET").length,
    0,
    "…and NO GET reached the vendor, though the server answered 202 to notifications/initialized",
  );
  const call = server.seen.find((r) => (r.body?.["method"] as string | undefined) === "tools/call");
  ok(call !== undefined, "the tools/call did reach the vendor");
  eq((call!.body!["params"] as Record<string, unknown>)["name"], "notion-fetch", "…naming the VENDOR's exact bytes, not the mounted slug");
  ok(
    server.seen.some((r) => r.method === "DELETE"),
    "the session teardown DELETE also passed the fence — the method allowlist admits it",
  );

  eq(minted, [{ provider: "notion", ref: "mcp.notion.com/notion-mcp", subject: OWNER_SUBJECT }], "the mint is addressed by the OWNER's vault subject");
  ok(
    !minted.some((m) => m.subject === REQUESTER_SUBJECT),
    "…and the REQUESTER's subject never reaches the mint — that one line is the whole difference from the member plane",
  );
  eq(call!.authorization, "Bearer OWNER-TOKEN", "the owner's token rides the request the vendor received");
}

{
  const server = fakeMcpServer();
  const sdk = new StreamableHTTPClientTransport(new URL(MCP_URL), { fetch: server.fetch });
  const client = new Client({ name: "unfenced-control", version: "1.0.0" }, { capabilities: {} });
  await client.connect(sdk);
  await settle();
  await client.close();
  ok(
    server.seen.some((r) => r.method === "GET"),
    "the UNFENCED SDK client DOES open the standalone GET/SSE stream against this server — so leg 1's absence is the fence's doing",
  );
}

console.log("2. the pin the transport installs is built from the grant row:");
{
  catalogue({ hosts: ["mcp.notion.com"] });
  const mismatch = fakeMcpServer();
  await assert.rejects(
    grantMcpTransport({ connectorSpec: () => SPEC, fetch: mismatch.fetch, mintOwnerToken: async () => "OWNER-TOKEN" })(
      { input: {}, mcpTool: "notion-search" },
      grantRow({ mcpTool: "notion-fetch" }),
      OWNER,
    ),
    /names a different vendor tool than the grant row lends/u,
    "a call naming a tool the ROW does not lend is refused, whichever tool it names",
  );
  n++;
  eq(mismatch.seen.length, 0, "…and neither tool was dialled");

  const row = grantRow();
  let baseCalls = 0;
  const base: FetchLike = async () => {
    baseCalls++;
    return new Response("{}", { status: 200 });
  };
  const fenced = grantBorrowFetch({ frozenArgs: row.frozenArgs, mcpTool: row.mcpTool! }, MCP_URL, base);
  const post = (body: unknown, url = MCP_URL): Promise<Response> => fenced(url, { body: JSON.stringify(body), method: "POST" });
  const callBody = (params: unknown): unknown => ({ id: 1, jsonrpc: "2.0", method: "tools/call", params });

  await assert.rejects(
    post(callBody({ arguments: { page_id: "OWNER-PAGE" }, name: "notion-search" })),
    McpCallFenceError,
    "a WRONG TOOL is refused by the wrapper the transport installs",
  );
  n++;
  await assert.rejects(
    post(callBody({ arguments: { page_id: "SOME-OTHER-PAGE" }, name: "notion-fetch" })),
    McpCallFenceError,
    "a MUTATED FROZEN ARGUMENT is refused",
  );
  n++;
  await assert.rejects(post(callBody({ arguments: { page_id: "OWNER-PAGE" }, name: "notion-fetch" }), "https://evil.example/mcp"), McpCallFenceError, "a WRONG HOST is refused");
  n++;
  eq(baseCalls, 0, "…and NONE of the three reached the base fetch: the vendor was never dialled");

  const allowed = await post(callBody({ arguments: { page_id: "OWNER-PAGE", page_size: 5 }, name: "notion-fetch" }));
  eq(allowed.status, 200, "the call the grant DOES lend passes the same wrapper");
  eq(baseCalls, 1, "…and it is the only one that reached the base fetch");
}

console.log("3. the model's arguments go out unchanged, and the fence is what enforces the freeze:");
{
  catalogue({ hosts: ["mcp.notion.com"] });
  const server = fakeMcpServer();
  const transport = grantMcpTransport({ connectorSpec: () => SPEC, fetch: server.fetch, mintOwnerToken: async () => "OWNER-TOKEN" });
  await transport({ input: { page_id: "OWNER-PAGE", page_size: 5 }, mcpTool: "notion-fetch" }, grantRow(), OWNER);
  await settle();
  const call = server.seen.find((r) => (r.body?.["method"] as string | undefined) === "tools/call");
  eq(
    (call!.body!["params"] as { arguments: unknown }).arguments,
    { page_id: "OWNER-PAGE", page_size: 5 },
    "the vendor received the model's arguments UNCHANGED — the transport merges nothing in",
  );
}

{
  catalogue({ hosts: ["mcp.notion.com"] });
  const server = fakeMcpServer();
  const transport = grantMcpTransport({ connectorSpec: () => SPEC, fetch: server.fetch, mintOwnerToken: async () => "OWNER-TOKEN" });
  await assert.rejects(
    transport({ input: { page_id: "ATTACKER-PAGE", page_size: 5 }, mcpTool: "notion-fetch" }, grantRow(), OWNER),
    McpCallFenceError,
    "a model that sends the WRONG value for a frozen argument is REFUSED, not silently corrected",
  );
  n++;
  await settle();
  ok(
    server.seen.every((r) => (r.body?.["method"] as string | undefined) !== "tools/call"),
    "…and no tools/call ever reached the vendor — the refusal happens before the wire",
  );
}

{
  catalogue({ hosts: ["mcp.notion.com"] });
  const server = fakeMcpServer();
  const transport = grantMcpTransport({ connectorSpec: () => SPEC, fetch: server.fetch, mintOwnerToken: async () => "OWNER-TOKEN" });
  await assert.rejects(
    transport({ input: { page_size: 5 }, mcpTool: "notion-fetch" }, grantRow(), OWNER),
    McpCallFenceError,
    "a model that OMITS a frozen argument is refused too — an absent key is not the granted value",
  );
  n++;
}

console.log("5. the credential's endpoint rules are asserted before the mint:");
{
  catalogue({ hosts: ["api.notion.com"] });
  const server = fakeMcpServer();
  let mints = 0;
  const transport = grantMcpTransport({
    connectorSpec: () => SPEC,
    fetch: server.fetch,
    mintOwnerToken: async () => {
      mints++;
      return "OWNER-TOKEN";
    },
  });
  await assert.rejects(
    transport({ input: {}, mcpTool: "notion-fetch" }, grantRow(), OWNER),
    /BLOCKED MCP transport to https:\/\/mcp\.notion\.com\/mcp/u,
    "a credential fenced to another host refuses the borrow by name",
  );
  n++;
  eq(mints, 0, "…BEFORE the mint, so no token is created for a call that could never be sent");
  eq(server.seen.length, 0, "…and the vendor was never dialled");
}

console.log("6. every absence refuses by name:");
{
  catalogue({ hosts: ["mcp.notion.com"] });
  const server = fakeMcpServer();
  const deps = { fetch: server.fetch, mintOwnerToken: async (): Promise<string> => "OWNER-TOKEN" };

  await assert.rejects(
    grantMcpTransport({ ...deps, connectorSpec: () => undefined })({ input: {}, mcpTool: "notion-fetch" }, grantRow(), OWNER),
    /carries no "notion" connection/u,
    "no connection for the row's connector refuses, naming the connector",
  );
  n++;

  let mintsOnBadUrl = 0;
  await assert.rejects(
    grantMcpTransport({
      connectorSpec: () => ({ connector: "notion", directUrl: "not a url", provider: "notion" }),
      fetch: server.fetch,
      mintOwnerToken: async () => {
        mintsOnBadUrl++;
        return "OWNER-TOKEN";
      },
    })({ input: {}, mcpTool: "notion-fetch" }, grantRow(), OWNER),
    /URL does not parse/u,
    "a connection whose URL does not parse refuses by name",
  );
  n++;
  eq(mintsOnBadUrl, 0, "…BEFORE the mint, so no live token is created for a call that can never be dialled");

  await assert.rejects(
    grantMcpTransport({ ...deps, connectorSpec: () => SPEC })({ input: {}, mcpTool: "notion-fetch" }, grantRow({ connector: "linear" }), OWNER),
    /not in CREDENTIAL_GRANT_ROLES/u,
    "a connector the reviewed list does not admit refuses, rather than guessing a credential id",
  );
  n++;

  resetRegisteredConnectorCredentials();
  await assert.rejects(
    grantMcpTransport({ ...deps, connectorSpec: () => SPEC })({ input: {}, mcpTool: "notion-fetch" }, grantRow(), OWNER),
    /configures no "user-oauth" notion credential/u,
    "an unconfigured credential refuses, naming the credential the deployment must declare",
  );
  n++;

  setRegisteredConnectorCredentials([{ allows: ["user-oauth"], connector: "notion", credentials: [{ id: "user-oauth", type: "user-oauth" }] }]);
  await assert.rejects(
    grantMcpTransport({ ...deps, connectorSpec: () => SPEC })({ input: {}, mcpTool: "notion-fetch" }, grantRow(), OWNER),
    /declares no OAuth home/u,
    "a credential with no OAuth home refuses — there is no per-user token to mint",
  );
  n++;
  eq(server.seen.length, 0, "no absence ever dialled the vendor");
}

console.log("7. a rate-limited borrow is retried, below the burn:");
{
  catalogue({ hosts: ["mcp.notion.com"] });
  const server = fakeMcpServer({ refuseCalls: 1, refusalRetryAfter: "2" });
  const minted: string[] = [];
  const slept: number[] = [];
  const result = (await grantMcpTransport({
    connectorSpec: () => SPEC,
    fetch: server.fetch,
    mintOwnerToken: async (_provider, _ref, subject) => {
      minted.push(subject);
      return "OWNER-TOKEN";
    },
    retry: { sleep: async (ms: number) => void slept.push(ms) },
  })({ input: { page_id: "OWNER-PAGE" }, mcpTool: "notion-fetch" }, grantRow(), OWNER)) as { content: unknown };
  await settle();

  eq(result.content, [{ text: "the page body", type: "text" }], "🔴 429: a borrow refused once now SURVIVES and returns the vendor's result — it used to fail on the first refusal");
  eq(slept, [2000], "429: the vendor's Retry-After (2 s) is honoured, not the 1 s fallback");
  eq(server.seen.filter((r) => (r.body?.["method"] as string | undefined) === "tools/call").length, 2, "429: the tools/call is re-sent exactly once");
  eq(minted, [OWNER_SUBJECT], "🔴 429: the owner's token was minted ONCE — the retry did NOT re-enter the transport, so it cannot re-take the grant's single-use CAS");
  ok(
    server.seen.filter((r) => (r.body?.["method"] as string | undefined) === "tools/call").every((r) => r.redirect === "error"),
    "🔴 429: BOTH attempts carry redirect:\"error\" — the retry re-sends through the fenced wrapper, so the backoff sits below the fence and not around it",
  );
}
{
  catalogue({ hosts: ["mcp.notion.com"] });
  const server = fakeMcpServer({ refuseCalls: 3, refusalRetryAfter: "2", refusalStatus: 500 });
  const slept: number[] = [];
  await assert.rejects(
    grantMcpTransport({
      connectorSpec: () => SPEC,
      fetch: server.fetch,
      mintOwnerToken: async () => "OWNER-TOKEN",
      retry: { sleep: async (ms: number) => void slept.push(ms) },
    })({ input: { page_id: "OWNER-PAGE" }, mcpTool: "notion-fetch" }, grantRow(), OWNER),
    "a 500 from the vendor still fails the borrow — it is not retried into a success",
  );
  n++;
  await settle();
  eq(slept, [], "🔴 500 negative control: a non-429 vendor failure is NEVER slept on");
  eq(server.seen.filter((r) => (r.body?.["method"] as string | undefined) === "tools/call").length, 1, "🔴 500 negative control: …and the tools/call is sent EXACTLY once");
}
{
  let nowMs = 10_000;
  const deadline = borrowDeadline(2_000, nowMs);
  const realNow = Date.now;
  Date.now = () => nowMs;
  try {
    const slept: number[] = [];
    const wrapped = borrowRetryFetch(
      "notion",
      async () =>
        new Response(JSON.stringify({ message: "rate limited" }), {
          status: 429,
          headers: { "content-type": "application/json", "retry-after": "1" },
        }),
      { retry: { sleep: async (ms: number) => void (slept.push(ms), (nowMs += ms)) } },
      deadline,
    );
    await assert.rejects(wrapped("https://mcp.notion.com/mcp", { method: "POST" }), /rate limited/u, "the first request exhausts its slice of the budget");
    n++;
    eq(slept, [1000, 1000], "deadline: the first request spends the WHOLE 2 s budget across two honoured waits");
    const before = slept.length;
    await assert.rejects(wrapped("https://mcp.notion.com/mcp", { method: "POST" }), /rate limited/u, "the second request also refuses");
    n++;
    eq(
      slept.length,
      before,
      "🔴 deadline: the SECOND request slept ZERO times — it read what was LEFT of the shared budget, not a fresh copy of it. A wrapper that captured the budget once would sleep again here.",
    );
  } finally {
    Date.now = realNow;
  }
}
{
  catalogue({ hosts: ["mcp.notion.com"] });
  const seen: { method: string; n: number }[] = [];
  const inner = fakeMcpServer();
  const slept: number[] = [];
  const rateLimitDeletes: FetchLike = async (url, init) => {
    const method = (init?.method ?? "GET").toUpperCase();
    if (method === "DELETE") {
      seen.push({ method, n: seen.filter((s) => s.method === "DELETE").length + 1 });
      return new Response(JSON.stringify({ message: "rate limited" }), {
        status: 429,
        headers: { "content-type": "application/json", "retry-after": "30" },
      });
    }
    return await inner.fetch(url, init);
  };
  const result = (await grantMcpTransport({
    connectorSpec: () => SPEC,
    fetch: rateLimitDeletes,
    mintOwnerToken: async () => "OWNER-TOKEN",
    retry: { sleep: async (ms: number) => void slept.push(ms) },
  })({ input: { page_id: "OWNER-PAGE" }, mcpTool: "notion-fetch" }, grantRow(), OWNER)) as { content: unknown };
  await settle();

  eq(result.content, [{ text: "the page body", type: "text" }], "teardown: a rate-limited DELETE never changes the borrow's result");
  eq(seen.filter((s) => s.method === "DELETE").length, 1, "🔴 teardown: a 429 on the session DELETE is sent EXACTLY once — the backoff deliberately skips it");
  eq(slept, [], "🔴 teardown: …and nothing is slept on, so a rate-limited teardown cannot stall the turn after its result is in hand");
}
{
  catalogue({ hosts: ["mcp.notion.com"] });
  const server = fakeMcpServer({ refuseCalls: 99, refusalRetryAfter: "1" });
  const slept: number[] = [];
  let caught: unknown;
  try {
    await grantMcpTransport({
      connectorSpec: () => SPEC,
      fetch: server.fetch,
      mintOwnerToken: async () => "OWNER-TOKEN",
      retry: { maxAttempts: 3, sleep: async (ms: number) => void slept.push(ms) },
    })({ input: { page_id: "OWNER-PAGE" }, mcpTool: "notion-fetch" }, grantRow(), OWNER);
  } catch (err) {
    caught = err;
  }
  await settle();
  ok(caught !== undefined, "exhaustion: a borrow the vendor keeps refusing fails rather than answering empty");
  ok(
    /rate limited/u.test(String((caught as Error).message)),
    "🔴 exhaustion: the failure NAMES the rate limit — `grant-borrow POST /mcp (notion)` — so an exhausted borrow is never a silent drop",
  );
  ok(!String((caught as Error).message).includes("OWNER-TOKEN"), "🔴 exhaustion: the message carries NO owner token");
  eq(slept, [1000, 1000], "exhaustion: two waits under a three-attempt bound");
  eq(server.seen.filter((r) => (r.body?.["method"] as string | undefined) === "tools/call").length, 3, "exhaustion: exactly three attempts left the host");
}

resetRegisteredConnectorCredentials();
console.log(`\n✓ grant-mcp-transport: ${String(n)} assertions passed`);
