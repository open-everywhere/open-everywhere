import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { withRetryAfter, type RetryPolicy } from "../channels/rate-limit-retry.js";

/**
 * OE's own MCP client for a connector call. On eve 1.x a connector op reaches the model as an
 * OE-owned deferred tool (`connector-tools.ts`), so OE, not eve's connection runtime, sends the
 * MCP requests. This module owns the wire half only:
 *
 * - **Timeout.** One call, connect included, has five minutes (`CONNECTOR_CALL_TIMEOUT_MS`).
 *   The turn's abort signal also ends it.
 * - **Retries.** A `429` is retried after the server's `Retry-After` delay (`withRetryAfter`):
 *   the server refused the request, so a retry cannot run a write twice. No other failure is
 *   retried here, because a write that timed out may have run.
 * - **An expired token.** A `401` raises `ConnectorUnauthorizedError`. The token source in
 *   `connector-tools.ts` decides what follows: a second token request and one retry, then a
 *   message that the connector needs a new sign-in.
 *
 * A result is shaped as eve's connection runtime shaped it, so the fence reads the same value on
 * both routes: `structuredContent` when the server sends it, else the text parts, parsed as JSON
 * when the tool declares no output schema. A result with a non-text block (an image, audio or a
 * resource) returns its blocks as `{ content }`, and the fence sends each file to the model as a
 * file part beside the fenced text (`connector-result-fence.ts#fenceFileContent`), as eve's runtime
 * sent file parts. A result with `isError: true` does NOT throw, which
 * is where eve's runtime differs: the error text is the connector's own bytes, and a thrown error
 * reaches the model with no `toModelOutput`, so unfenced. It returns `{ isError: true, error }`,
 * which the fence wraps and marks as a failed call. An error that carries a sign-in challenge
 * (`_meta["mcp/www_authenticate"]`) raises `ConnectorUnauthorizedError` instead.
 */

export const CONNECTOR_CALL_TIMEOUT_MS = 300_000;

const CLIENT_INFO = { name: "open-everywhere-connector", version: "1.0.0" } as const;

export interface ConnectorEndpoint {
  readonly connection: string;
  readonly url: string;
}

export interface ConnectorClientDeps {
  readonly fetch?: FetchLike;
  readonly retry?: RetryPolicy;
  readonly timeoutMs?: number;
}

export interface ListedConnectorTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly hasOutputSchema: boolean;
  readonly annotations?: Readonly<Record<string, unknown>>;
}

class ConnectorUnauthorizedError extends Error {
  constructor(connection: string) {
    super(`connection "${connection}": the MCP server answered 401 (the token is missing, expired or revoked).`);
    this.name = "ConnectorUnauthorizedError";
  }
}

export function isConnectorUnauthorizedError(err: unknown): err is ConnectorUnauthorizedError {
  return err instanceof Error && err.name === "ConnectorUnauthorizedError";
}

const WWW_AUTHENTICATE_META = "mcp/www_authenticate";

function isUnauthorizedTransportError(err: unknown): boolean {
  if (err === null || typeof err !== "object") return false;
  const e = err as { code?: unknown; name?: unknown };
  return e.code === 401 || e.name === "UnauthorizedError";
}

function retryingFetch(endpoint: ConnectorEndpoint, base: FetchLike, retry: RetryPolicy | undefined): FetchLike {
  return (url, init) => {
    if ((init?.method ?? "GET").toUpperCase() === "DELETE") return base(url, init);
    return withRetryAfter(async () => await base(url, init), {
      surface: "connector",
      operation: `POST /mcp (${endpoint.connection})`,
      ...retry,
    });
  };
}

async function withConnectorClient<T>(
  endpoint: ConnectorEndpoint,
  token: string | undefined,
  deps: ConnectorClientDeps,
  signal: AbortSignal | undefined,
  body: (client: Client, timeout: { timeout: number; signal?: AbortSignal }) => Promise<T>,
): Promise<T> {
  const fetch = retryingFetch(endpoint, deps.fetch ?? (globalThis.fetch as FetchLike), deps.retry);
  const transport = new StreamableHTTPClientTransport(new URL(endpoint.url), {
    fetch,
    ...(token === undefined ? {} : { requestInit: { headers: { authorization: `Bearer ${token}` } } }),
  });
  const client = new Client(CLIENT_INFO, { capabilities: {} });
  const deadline = Date.now() + (deps.timeoutMs ?? CONNECTOR_CALL_TIMEOUT_MS);
  const remaining = (): { timeout: number; signal?: AbortSignal } => ({
    timeout: Math.max(1, deadline - Date.now()),
    ...(signal === undefined ? {} : { signal }),
  });
  try {
    await client.connect(transport, remaining());
    return await body(client, remaining());
  } catch (err) {
    if (isUnauthorizedTransportError(err)) throw new ConnectorUnauthorizedError(endpoint.connection);
    throw err;
  } finally {
    try {
      await transport.terminateSession();
    } catch {
    }
    try {
      await client.close();
    } catch {
    }
  }
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

export async function listConnectorTools(
  endpoint: ConnectorEndpoint,
  token: string | undefined,
  deps: ConnectorClientDeps = {},
  signal?: AbortSignal,
): Promise<readonly ListedConnectorTool[]> {
  return await withConnectorClient(endpoint, token, deps, signal, async (client, options) => {
    const out: ListedConnectorTool[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor === undefined ? undefined : { cursor }, options);
      for (const tool of page.tools) {
        const annotations = recordOf((tool as { annotations?: unknown }).annotations);
        out.push({
          name: tool.name,
          description: tool.description ?? "",
          inputSchema: recordOf(tool.inputSchema) ?? { type: "object" },
          hasOutputSchema: recordOf((tool as { outputSchema?: unknown }).outputSchema) !== undefined,
          ...(annotations === undefined ? {} : { annotations }),
        });
      }
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    return out;
  });
}

function resultText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is { type: "text"; text: string } => recordOf(part)?.type === "text" && typeof recordOf(part)?.text === "string")
    .map((part) => part.text)
    .join("\n");
}

/** Shape one `tools/call` result as eve's connection runtime did. Exported for the tests. */
export function connectorCallOutput(connection: string, result: unknown, hasOutputSchema: boolean): unknown {
  const r = recordOf(result) ?? {};
  const meta = recordOf(r["_meta"]);
  if (r["isError"] === true) {
    if (meta !== undefined && meta[WWW_AUTHENTICATE_META] !== undefined) throw new ConnectorUnauthorizedError(connection);
    return { isError: true, error: resultText(r["content"]) || "The tool reported an error with no text." };
  }
  if (r["structuredContent"] !== undefined) return r["structuredContent"];
  const content = Array.isArray(r["content"]) ? (r["content"] as unknown[]) : [];
  if (content.some((part) => recordOf(part)?.type !== "text")) return { content };
  const text = resultText(content);
  if (hasOutputSchema) return text;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

export async function callConnectorTool(
  endpoint: ConnectorEndpoint,
  call: { readonly tool: string; readonly arguments: Record<string, unknown>; readonly hasOutputSchema?: boolean },
  token: string | undefined,
  deps: ConnectorClientDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  return await withConnectorClient(endpoint, token, deps, signal, async (client, options) => {
    const result = await client.callTool({ name: call.tool, arguments: call.arguments }, undefined, options);
    return connectorCallOutput(endpoint.connection, result, call.hasOutputSchema === true);
  });
}
