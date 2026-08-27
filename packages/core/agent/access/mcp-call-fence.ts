import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { GrantUndispatchedError, quotedPurpose } from "../operational/credential-grant-rows.js";

export interface McpBorrowPin {
  readonly host: string;
  readonly tool: string;
  readonly frozenArgs: Readonly<Record<string, unknown>>;
}

export class McpCallFenceError extends GrantUndispatchedError {}

const ALLOWED_JSONRPC_METHODS: ReadonlySet<string> = new Set([
  "initialize",
  "notifications/initialized",
  "ping",
  "tools/list",
  "tools/call",
]);

const TOOLS_CALL_PARAM_KEYS: ReadonlySet<string> = new Set(["name", "arguments", "_meta"]);

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function deepEqualJson(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((element, i) => deepEqualJson(element, b[i]));
  }
  if (isJsonRecord(a) || isJsonRecord(b)) {
    if (!isJsonRecord(a) || !isJsonRecord(b)) return false;
    const keysA = Object.keys(a);
    if (keysA.length !== Object.keys(b).length) return false;
    return keysA.every((key) => Object.hasOwn(b, key) && deepEqualJson(a[key], b[key]));
  }
  return Object.is(a, b);
}

function label(value: unknown): string {
  if (typeof value === "string") return quotedPurpose(value);
  let rendered: string;
  try {
    rendered = JSON.stringify(value) ?? String(value);
  } catch {
    return "unrenderable";
  }
  return quotedPurpose(rendered);
}

function cloneJsonPinValue(value: unknown): unknown {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((element) => cloneJsonPinValue(element));
  const proto: unknown = typeof value === "object" ? Object.getPrototypeOf(value) : undefined;
  if (isJsonRecord(value) && (proto === Object.prototype || proto === null)) {
    const copy: Record<string, unknown> = {};
    for (const key of Object.keys(value)) copy[key] = cloneJsonPinValue(value[key]);
    return copy;
  }
  throw new McpCallFenceError(
    "mcp-call-fence: a frozen argument is not a JSON value — refusing to build a fence on a pin it cannot compare.",
  );
}

export function fenceMcpBorrowFetch(pin: McpBorrowPin, base: FetchLike): FetchLike {
  if (typeof pin.host !== "string" || pin.host.trim() === "") {
    throw new McpCallFenceError("mcp-call-fence: the pin names no host — refusing to build a fence that cannot check one.");
  }
  if (typeof pin.tool !== "string" || pin.tool === "") {
    throw new McpCallFenceError("mcp-call-fence: the pin names no tool — refusing to build a fence that cannot check one.");
  }
  if (!isJsonRecord(pin.frozenArgs)) {
    throw new McpCallFenceError("mcp-call-fence: the pin's frozen arguments are not a JSON object — refusing to build.");
  }
  const pinnedHost = pin.host.trim().toLowerCase();
  const pinnedTool = pin.tool;
  const frozenArgs = cloneJsonPinValue(pin.frozenArgs) as Record<string, unknown>;
  const frozenKeys = Object.keys(frozenArgs);
  const boundary = `the grant lends only \`${label(pinnedTool)}\` on \`${pinnedHost}\``;
  const refuse: (reason: string) => never = (reason) => {
    throw new McpCallFenceError(`mcp-call-fence: ${reason} — ${boundary}; this request was not sent.`);
  };

  return async (url, init) => {
    const href = typeof url === "string" ? url : url instanceof URL ? url.href : undefined;
    if (href === undefined) refuse("the request URL is neither a string nor a URL");
    let parsed: URL | undefined;
    try {
      parsed = new URL(href);
    } catch {
      parsed = undefined;
    }
    if (parsed === undefined) refuse("the request URL does not parse");
    if (parsed.protocol !== "https:") refuse(`the request scheme is \`${label(parsed.protocol)}\`, not https`);
    if (parsed.host !== pinnedHost) refuse(`the request host is \`${label(parsed.host)}\``);

    const rawMethod = init?.method;
    if (rawMethod !== undefined && typeof rawMethod !== "string") refuse("the request method is not a string");
    const method = (typeof rawMethod === "string" ? rawMethod : "GET").toUpperCase();
    if (method === "GET") {
      refuse("GET opens the server-initiated SSE stream, which a borrow never needs");
    }
    if (method !== "POST" && method !== "DELETE") refuse(`the request method \`${label(method)}\` is not POST or DELETE`);

    const fenced: RequestInit = { ...init, redirect: "error" };

    const body = init?.body;
    if (method === "DELETE") {
      if (body !== undefined && body !== null) refuse("the session-teardown DELETE carries a body");
      return base(url, fenced);
    }
    if (typeof body !== "string") refuse("the POST body is not a JSON string");
    let message: unknown;
    let parseFailed = false;
    try {
      message = JSON.parse(body);
    } catch {
      parseFailed = true;
    }
    if (parseFailed) refuse("the POST body does not parse as JSON");
    if (Array.isArray(message)) refuse("the POST body is a JSON-RPC batch, which a borrow never sends");
    if (!isJsonRecord(message)) refuse("the POST body is not a single JSON object");
    const jsonRpcMethod = message["method"];
    if (typeof jsonRpcMethod !== "string") refuse("the POST body names no JSON-RPC method");
    if (!ALLOWED_JSONRPC_METHODS.has(jsonRpcMethod)) {
      refuse(`the JSON-RPC method \`${label(jsonRpcMethod)}\` is not one a borrow may send`);
    }
    if (jsonRpcMethod === "tools/call") {
      const params = message["params"];
      if (!isJsonRecord(params)) refuse("the tools/call carries no params object");
      for (const key of Object.keys(params)) {
        if (!TOOLS_CALL_PARAM_KEYS.has(key)) refuse(`the tools/call params carry the unread key \`${label(key)}\``);
      }
      if (params["name"] !== pinnedTool) refuse(`the tools/call names the tool \`${label(params["name"])}\``);

      const args = params["arguments"];
      if (args !== undefined && !isJsonRecord(args)) refuse("the tools/call arguments are not a JSON object");
      if (frozenKeys.length > 0) {
        if (!isJsonRecord(args)) {
          refuse(`the grant freezes ${frozenKeys.length} argument(s) and the tools/call carries no arguments object`);
        }
        for (const key of frozenKeys) {
          if (!Object.hasOwn(args, key)) refuse(`the frozen argument \`${label(key)}\` is absent from the tools/call`);
          if (!deepEqualJson(args[key], frozenArgs[key])) {
            refuse(`the frozen argument \`${label(key)}\` does not match the value the grant froze`);
          }
        }
      }
    }

    return base(url, { ...fenced, body: JSON.stringify(message) });
  };
}
