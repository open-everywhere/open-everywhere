import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";

export interface SeenRequest {
  readonly method: string;
  readonly url: string;
  readonly redirect: string | undefined;
  readonly authorization: string | null;
  readonly body: Record<string, unknown> | undefined;
}

export interface FakeMcpTool {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: unknown;
}

export interface FakeMcpServerOptions {
  readonly toolResult?: unknown;
  readonly tools?: readonly FakeMcpTool[];
  readonly failWithStatus?: number;
}

export interface FakeMcpServer {
  readonly fetch: FetchLike;
  readonly seen: SeenRequest[];
}

export function fakeMcpServer(opts: FakeMcpServerOptions = {}): FakeMcpServer {
  const seen: SeenRequest[] = [];
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
    if (opts.failWithStatus !== undefined) return new Response("upstream is unwell", { status: opts.failWithStatus });
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
    if (rpc["method"] === "tools/list") {
      return json({
        id,
        jsonrpc: "2.0",
        result: { tools: (opts.tools ?? []).map((t) => ({ description: t.description ?? "", inputSchema: t.inputSchema ?? { type: "object" }, name: t.name })) },
      });
    }
    if (rpc["method"] === "tools/call") {
      return json({ id, jsonrpc: "2.0", result: opts.toolResult ?? { content: [{ text: "the page body", type: "text" }] } });
    }
    return json({ error: { code: -32601, message: "method not found" }, id, jsonrpc: "2.0" });
  };
  return { fetch, seen };
}

export async function settleMcp(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
}
