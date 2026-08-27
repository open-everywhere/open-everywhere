import assert from "node:assert/strict";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";

import { fenceMcpBorrowFetch, deepEqualJson, McpCallFenceError, type McpBorrowPin } from "../agent/access/mcp-call-fence.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

const HOST = "mcp.vendor.example";
const URL_OK = `https://${HOST}/mcp`;
const TOOL = "notion-fetch";

function makeBase(): { calls: { url: string; init?: RequestInit }[]; fetchLike: FetchLike } {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchLike: FetchLike = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  };
  return { calls, fetchLike };
}

const pinOf = (frozenArgs: Record<string, unknown> = {}): McpBorrowPin => ({ host: HOST, tool: TOOL, frozenArgs });

const rpc = (method: string, params?: unknown): string =>
  JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params !== undefined ? { params } : {}) });

const post = (body: string): RequestInit => ({ method: "POST", body, headers: { "content-type": "application/json" } });

async function drive(
  pin: McpBorrowPin,
  url: string | URL | unknown,
  init?: RequestInit,
): Promise<{ err?: unknown; dialled: number; forwarded?: RequestInit }> {
  const base = makeBase();
  const fenced = fenceMcpBorrowFetch(pin, base.fetchLike);
  try {
    await fenced(url as string | URL, init);
    return { dialled: base.calls.length, forwarded: base.calls[0]?.init };
  } catch (err) {
    return { err, dialled: base.calls.length, forwarded: base.calls[0]?.init };
  }
}

async function refuses(label: string, pin: McpBorrowPin, url: string | URL | unknown, init?: RequestInit): Promise<void> {
  const { err, dialled } = await drive(pin, url, init);
  ok(err instanceof McpCallFenceError, `${label} — refuses with a host-authored McpCallFenceError`);
  ok(dialled === 0, `${label} — …and the vendor was NEVER dialled`);
}

async function passes(label: string, pin: McpBorrowPin, url: string | URL, init?: RequestInit): Promise<void> {
  const { err, dialled } = await drive(pin, url, init);
  ok(err === undefined, `${label} — passes the fence (no refusal): ${err instanceof Error ? err.message : ""}`);
  ok(dialled === 1, `${label} — …and reached the wrapped fetch exactly once`);
}

{
  const base = makeBase();
  const built = (pin: unknown): unknown => {
    try {
      fenceMcpBorrowFetch(pin as McpBorrowPin, base.fetchLike);
      return undefined;
    } catch (err) {
      return err;
    }
  };
  ok(built({ host: "", tool: TOOL, frozenArgs: {} }) instanceof McpCallFenceError, "§1 an empty pinned host refuses to build a fence");
  ok(built({ host: "   ", tool: TOOL, frozenArgs: {} }) instanceof McpCallFenceError, "§1 a blank pinned host refuses to build");
  ok(built({ host: HOST, tool: "", frozenArgs: {} }) instanceof McpCallFenceError, "§1 an empty pinned tool refuses to build");
  ok(built({ host: HOST, tool: TOOL, frozenArgs: null }) instanceof McpCallFenceError, "§1 non-object frozen arguments refuse to build");
  ok(built({ host: HOST, tool: TOOL, frozenArgs: [] }) instanceof McpCallFenceError, "§1 array frozen arguments refuse to build");
  ok(built({ host: 7, tool: TOOL, frozenArgs: {} }) instanceof McpCallFenceError, "§1 a non-string pinned host refuses to build");
  ok(built({ host: HOST, tool: 7, frozenArgs: {} }) instanceof McpCallFenceError, "§1 a non-string pinned tool refuses to build");
  ok(built({ host: HOST, tool: TOOL, frozenArgs: { f: () => 1 } }) instanceof McpCallFenceError, "🔴 §1 a non-JSON frozen argument refuses to build");
  ok(built({ host: HOST, tool: TOOL, frozenArgs: { d: new Date(0) } }) instanceof McpCallFenceError, "§1 a frozen argument that is not a JSON value refuses to build");
  ok(built({ host: HOST, tool: TOOL, frozenArgs: { u: undefined } }) instanceof McpCallFenceError, "§1 an undefined frozen argument refuses to build");
  ok(built({ host: HOST, tool: TOOL, frozenArgs: { nested: { deep: [1, { bad: Symbol("x") }] } } }) instanceof McpCallFenceError, "§1 …and the check reaches a NESTED non-JSON value");
  ok(built(pinOf()) === undefined, "§1 POSITIVE CONTROL: a well-formed pin builds a fence");
  ok(built({ host: HOST, tool: TOOL, frozenArgs: { a: 1, b: [1, "x", null], c: { d: true } } }) === undefined, "§1 NEGATIVE CONTROL: a nested all-JSON pin builds");
}

{
  const live: { host: string; tool: string; frozenArgs: Record<string, unknown> } = {
    host: HOST,
    tool: TOOL,
    frozenArgs: { page_id: "abc-123", filter: { property: "Status" } },
  };
  const base = makeBase();
  const fenced = fenceMcpBorrowFetch(live, base.fetchLike);

  live.tool = "notion-create-pages";
  live.host = "evil.example";
  live.frozenArgs["page_id"] = "def-456";
  (live.frozenArgs["filter"] as Record<string, unknown>)["property"] = "Owner";
  live.frozenArgs["added_later"] = "surprise";

  const send = async (params: unknown): Promise<unknown> => {
    try {
      await fenced(URL_OK, post(rpc("tools/call", params)));
      return undefined;
    } catch (err) {
      return err;
    }
  };
  ok(await send({ name: TOOL, arguments: { page_id: "abc-123", filter: { property: "Status" } } }) === undefined, "🔴 §1b the fence still admits the pin it was BUILT with");
  ok(base.calls.length === 1, "§1b …and that call reached the vendor");
  ok((await send({ name: TOOL, arguments: { page_id: "def-456", filter: { property: "Status" } } })) instanceof McpCallFenceError, "🔴 §1b a value compose wrote into the pin AFTER the build is still refused");
  ok((await send({ name: "notion-create-pages", arguments: { page_id: "abc-123", filter: { property: "Status" } } })) instanceof McpCallFenceError, "🔴 §1b a tool name compose wrote into the pin after the build is still refused");
  ok((await send({ name: TOOL, arguments: { page_id: "abc-123", filter: { property: "Owner" } } })) instanceof McpCallFenceError, "§1b …including a mutation NESTED inside a frozen object");
  ok(base.calls.length === 1, "🔴 §1b the vendor was dialled ONCE across all of it — only by the call the built pin admits");
}

{
  const CALL = post(rpc("tools/call", { name: TOOL, arguments: { q: "hello" } }));

  await passes("🔴 §2 POSITIVE CONTROL: a pinned tools/call on the pinned https host", pinOf(), URL_OK, CALL);
  await passes("§2 the URL may arrive as a URL object, not only a string", pinOf(), new URL(URL_OK), CALL);

  await refuses("🔴 §2 a DIFFERENT host", pinOf(), "https://evil.example/mcp", CALL);
  await refuses("§2 the pinned host as a SUBDOMAIN of another host", pinOf(), `https://${HOST}.evil.example/mcp`, CALL);
  await refuses("§2 the pinned host as a userinfo prefix", pinOf(), `https://${HOST}@evil.example/mcp`, CALL);
  await refuses("🔴 §2 http, not https, on the pinned host", pinOf(), `http://${HOST}/mcp`, CALL);
  await refuses("§2 a non-http scheme on the pinned host", pinOf(), `file://${HOST}/mcp`, CALL);
  await refuses("§2 a URL that does not parse", pinOf(), "not-a-url", CALL);
  await refuses("§2 a URL that is neither a string nor a URL", pinOf(), { href: URL_OK }, CALL);

  await refuses("§2 a port the pin does not carry", pinOf(), `https://${HOST}:8443/mcp`, CALL);
  await passes("§2 POSITIVE CONTROL: a pin that carries the port admits it", { ...pinOf(), host: `${HOST}:8443` }, `https://${HOST}:8443/mcp`, CALL);

  await passes("§2 a mixed-case pinned host matches the parser's lower-cased host", { ...pinOf(), host: HOST.toUpperCase() }, URL_OK, CALL);

  await passes("§2 the path is not pinned — the host rule is the boundary", pinOf(), `https://${HOST}/some/other/path`, CALL);

  const { err } = await drive(pinOf(), "https://evil.example/mcp", CALL);
  ok(err instanceof Error && err.message.includes("mcp-call-fence"), "§2 the refusal names the fence");
  ok(err instanceof Error && err.message.includes(TOOL), "§2 the refusal names the tool the grant lends");
  ok(err instanceof Error && err.message.includes(HOST), "§2 the refusal names the host the grant is pinned to");
  ok(err instanceof Error && err.message.includes("this request was not sent"), "§2 the refusal says THIS REQUEST was not sent — the narrow claim the fence can actually make");
}

{
  const CALL = post(rpc("tools/call", { name: TOOL }));

  await refuses("🔴 §3 GET — the server-initiated SSE stream", pinOf(), URL_OK, { method: "GET" });
  await refuses("§3 an init with NO method at all (fetch would default to GET)", pinOf(), URL_OK, {});
  await refuses("§3 no init object at all", pinOf(), URL_OK, undefined);
  await refuses("§3 a lower-case get", pinOf(), URL_OK, { method: "get" });
  await refuses("§3 PUT", pinOf(), URL_OK, { method: "PUT" });
  await refuses("§3 PATCH", pinOf(), URL_OK, { method: "PATCH" });
  await refuses("🔴 §3 PUT carrying a body the POST arm would accept", pinOf(), URL_OK, { ...CALL, method: "PUT" });
  await refuses("§3 HEAD carrying a body the POST arm would accept", pinOf(), URL_OK, { ...CALL, method: "HEAD" });
  await refuses("§3 a method that is not a string", pinOf(), URL_OK, { method: 7 } as unknown as RequestInit);

  await passes("🔴 §3 POSITIVE CONTROL: POST carries the JSON-RPC borrow", pinOf(), URL_OK, CALL);
  await passes("§3 a lower-case post is the same method", pinOf(), URL_OK, { ...CALL, method: "post" });
  await passes("🔴 §3 POSITIVE CONTROL: DELETE tears the session down", pinOf(), URL_OK, { method: "DELETE" });
  await passes("§3 DELETE with an explicitly null body is still a teardown", pinOf(), URL_OK, { method: "DELETE", body: null });
  await refuses("§3 a DELETE that grew a body is a shape the fence cannot read", pinOf(), URL_OK, { method: "DELETE", body: rpc("ping") });

  const { err } = await drive(pinOf(), URL_OK, { method: "GET" });
  ok(err instanceof Error && err.message.includes("GET"), "§3 the GET refusal names the method it refused");
  ok(err instanceof Error && err.message.includes("SSE"), "🔴 §3 …and names the server-initiated SSE stream as the reason");
  const badMethod = await drive(pinOf(), URL_OK, { method: 7 } as unknown as RequestInit);
  ok(
    badMethod.err instanceof Error && badMethod.err.message.includes("method is not a string"),
    "🔴 §3 a non-string method refuses AS a non-string method, not by defaulting to GET",
  );
}

{
  await passes("🔴 §4 POSITIVE CONTROL: initialize", pinOf(), URL_OK, post(rpc("initialize", { protocolVersion: "2025-06-18" })));
  await passes("§4 notifications/initialized", pinOf(), URL_OK, post(rpc("notifications/initialized")));
  await passes("§4 ping", pinOf(), URL_OK, post(rpc("ping")));
  await passes("§4 tools/list — the approve-time catalogue read", pinOf(), URL_OK, post(rpc("tools/list")));

  await refuses("🔴 §4 a JSON-RPC BATCH array body", pinOf(), URL_OK, post(JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "ping" }])));
  await refuses("§4 an EMPTY batch array body", pinOf(), URL_OK, post("[]"));
  await refuses("🔴 §4 a body that does not parse as JSON", pinOf(), URL_OK, post("{ this is not json"));
  await refuses("§4 an empty-string body", pinOf(), URL_OK, post(""));
  await refuses("§4 a JSON string body (parses, but is not an object)", pinOf(), URL_OK, post('"ping"'));
  await refuses("§4 a JSON number body", pinOf(), URL_OK, post("7"));
  await refuses("§4 a JSON null body", pinOf(), URL_OK, post("null"));
  await refuses("§4 a POST with NO body", pinOf(), URL_OK, { method: "POST" });
  await refuses(
    "§4 a POST body that is bytes, not a JSON string",
    pinOf(),
    URL_OK,
    { method: "POST", body: new Uint8Array([123, 125]) } as unknown as RequestInit,
  );

  await refuses(
    "🔴 §4 a JSON-RPC RESPONSE (result, no method) — the sampling reply shape",
    pinOf(),
    URL_OK,
    post(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [] } })),
  );
  await refuses("§4 a body whose method is not a string", pinOf(), URL_OK, post(JSON.stringify({ jsonrpc: "2.0", id: 1, method: 5 })));

  await refuses("🔴 §4 resources/read", pinOf(), URL_OK, post(rpc("resources/read", { uri: "file:///etc/passwd" })));
  await refuses("§4 resources/list", pinOf(), URL_OK, post(rpc("resources/list")));
  await refuses("§4 prompts/get", pinOf(), URL_OK, post(rpc("prompts/get", { name: "x" })));
  await refuses("§4 completion/complete", pinOf(), URL_OK, post(rpc("completion/complete")));
  await refuses("§4 sampling/createMessage", pinOf(), URL_OK, post(rpc("sampling/createMessage")));
  await refuses("§4 logging/setLevel", pinOf(), URL_OK, post(rpc("logging/setLevel", { level: "debug" })));
  await refuses("§4 an invented method name", pinOf(), URL_OK, post(rpc("tools/call_unchecked")));
  await refuses("§4 a method that differs from an allowed one only in case", pinOf(), URL_OK, post(rpc("Tools/Call", { name: TOOL })));

  const { err } = await drive(pinOf(), URL_OK, post(rpc("resources/read")));
  ok(err instanceof Error && err.message.includes("resources/read"), "§4 the refusal names the JSON-RPC method it refused");

  const batch = await drive(pinOf(), URL_OK, post(JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "ping" }])));
  ok(batch.err instanceof Error && batch.err.message.includes("batch"), "🔴 §4 the batch refusal names the batch, not a generic shape complaint");
  const unparseable = await drive(pinOf(), URL_OK, post("{ this is not json"));
  ok(
    unparseable.err instanceof Error && unparseable.err.message.includes("does not parse as JSON"),
    "🔴 §4 the unparseable-body refusal names the parse failure",
  );
  const noMethod = await drive(pinOf(), URL_OK, post(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [] } })));
  ok(
    noMethod.err instanceof Error && noMethod.err.message.includes("names no JSON-RPC method"),
    "🔴 §4 the response-shaped body refusal names the MISSING method, not an unknown one",
  );
  for (const [body, shape] of [
    ['"ping"', "a JSON string"],
    ["7", "a JSON number"],
    ["true", "a JSON boolean"],
  ] as const) {
    const scalar = await drive(pinOf(), URL_OK, post(body));
    ok(
      scalar.err instanceof Error && scalar.err.message.includes("not a single JSON object"),
      `🔴 §4 ${shape} body refuses AS a non-object body, not as a missing method`,
    );
  }
}

{
  const FROZEN = { page_id: "abc-123", filter: { property: "Status", equals: "Done" }, tags: ["a", "b"] };
  const pin = pinOf(FROZEN);
  const call = (params: unknown): RequestInit => post(rpc("tools/call", params));

  await passes("🔴 §5 POSITIVE CONTROL: the pinned tool with the frozen arguments intact", pin, URL_OK, call({ name: TOOL, arguments: { ...FROZEN } }));
  await passes(
    "§5 un-frozen arguments beside the frozen ones are the model's half of the call",
    pin,
    URL_OK,
    call({ name: TOOL, arguments: { ...FROZEN, query: "anything the model likes" } }),
  );
  await passes("§5 a `_meta` progress token is permitted params", pin, URL_OK, call({ name: TOOL, arguments: { ...FROZEN }, _meta: { progressToken: 3 } }));

  await refuses("🔴 §5 a DIFFERENT tool name", pin, URL_OK, call({ name: "notion-create-pages", arguments: { ...FROZEN } }));
  await refuses("§5 the pinned tool name in a different case", pin, URL_OK, call({ name: TOOL.toUpperCase(), arguments: { ...FROZEN } }));
  await refuses("§5 the pinned tool name with trailing whitespace", pin, URL_OK, call({ name: `${TOOL} `, arguments: { ...FROZEN } }));
  await refuses("§5 no tool name at all", pin, URL_OK, call({ arguments: { ...FROZEN } }));
  await refuses("§5 a tool name that is not a string", pin, URL_OK, call({ name: 7, arguments: { ...FROZEN } }));
  await refuses("§5 no params object at all", pin, URL_OK, post(rpc("tools/call")));
  await refuses("§5 params that are an array", pin, URL_OK, call([TOOL]));

  await refuses("🔴 §5 a MUTATED frozen scalar argument", pin, URL_OK, call({ name: TOOL, arguments: { ...FROZEN, page_id: "def-456" } }));
  await refuses("§5 a frozen scalar argument that changed type", pin, URL_OK, call({ name: TOOL, arguments: { ...FROZEN, page_id: 123 } }));
  await refuses(
    "🔴 §5 a mutated leaf INSIDE a frozen object argument",
    pin,
    URL_OK,
    call({ name: TOOL, arguments: { ...FROZEN, filter: { property: "Status", equals: "Archived" } } }),
  );
  await refuses(
    "§5 an EXTRA key inside a frozen object argument",
    pin,
    URL_OK,
    call({ name: TOOL, arguments: { ...FROZEN, filter: { property: "Status", equals: "Done", or: true } } }),
  );
  await refuses(
    "§5 a MISSING key inside a frozen object argument",
    pin,
    URL_OK,
    call({ name: TOOL, arguments: { ...FROZEN, filter: { property: "Status" } } }),
  );
  await refuses("§5 a RE-ORDERED frozen ARRAY argument (an array is a sequence)", pin, URL_OK, call({ name: TOOL, arguments: { ...FROZEN, tags: ["b", "a"] } }));
  await refuses("§5 an appended element on a frozen array argument", pin, URL_OK, call({ name: TOOL, arguments: { ...FROZEN, tags: ["a", "b", "c"] } }));
  await refuses("§5 an ABSENT frozen argument", pin, URL_OK, call({ name: TOOL, arguments: { filter: FROZEN.filter, tags: FROZEN.tags } }));
  await refuses("§5 NO arguments object when the grant freezes arguments", pin, URL_OK, call({ name: TOOL }));
  await refuses("§5 an arguments value that is not an object", pin, URL_OK, call({ name: TOOL, arguments: "page_id=abc-123" }));
  await refuses("§5 an arguments value that is an array", pin, URL_OK, call({ name: TOOL, arguments: ["abc-123"] }));

  await passes(
    "🔴 §5 a frozen object argument with RE-ORDERED KEYS still passes — the compare is structural",
    pin,
    URL_OK,
    call({ name: TOOL, arguments: { tags: ["a", "b"], filter: { equals: "Done", property: "Status" }, page_id: "abc-123" } }),
  );

  await refuses("🔴 §5 an UNREAD params key rides alongside the call", pin, URL_OK, call({ name: TOOL, arguments: { ...FROZEN }, _passthrough: { raw: "…" } }));
  await refuses("§5 a params key that shadows the arguments", pin, URL_OK, call({ name: TOOL, arguments: { ...FROZEN }, args: { page_id: "def-456" } }));

  const openPin = pinOf();
  await passes("§5 NEGATIVE CONTROL: a grant that freezes nothing admits any arguments", openPin, URL_OK, call({ name: TOOL, arguments: { anything: 1 } }));
  await passes("§5 …and admits a call with no arguments object at all", openPin, URL_OK, call({ name: TOOL }));
  await refuses("§5 …but still refuses a different tool name", openPin, URL_OK, call({ name: "other-tool", arguments: { anything: 1 } }));
  await refuses("🔴 §5 a non-object arguments value on a grant that freezes NOTHING", openPin, URL_OK, call({ name: TOOL, arguments: "page_id=abc-123" }));
  await refuses("§5 …and an array arguments value on that same grant", openPin, URL_OK, call({ name: TOOL, arguments: [1, 2] }));
  const openArgs = await drive(openPin, URL_OK, call({ name: TOOL, arguments: 5 }));
  ok(
    openArgs.err instanceof Error && openArgs.err.message.includes("arguments are not a JSON object"),
    "🔴 §5 …refusing AS a bad arguments shape",
  );

  const wrongTool = await drive(pin, URL_OK, call({ name: "notion-create-pages", arguments: { ...FROZEN } }));
  ok(
    wrongTool.err instanceof Error && wrongTool.err.message.includes("notion-create-pages"),
    "§5 the wrong-tool refusal names the tool that was asked for",
  );
  const absent = await drive(pin, URL_OK, call({ name: TOOL, arguments: { filter: FROZEN.filter, tags: FROZEN.tags } }));
  ok(
    absent.err instanceof Error && absent.err.message.includes("is absent from the tools/call"),
    "🔴 §5 an absent frozen argument refuses as ABSENT — the presence check ran, not the value compare behind it",
  );
  const mutated = await drive(pin, URL_OK, call({ name: TOOL, arguments: { ...FROZEN, page_id: "def-456" } }));
  ok(mutated.err instanceof Error && mutated.err.message.includes("page_id"), "§5 the frozen-argument refusal names the KEY that mismatched");
  ok(
    mutated.err instanceof Error && !mutated.err.message.includes("def-456"),
    "🔴 §5 …and NOT the value — a refusal renders keys, never model-authored values",
  );
}

{
  ok(deepEqualJson({ a: 1, b: 2 }, { b: 2, a: 1 }), "§6 object key ORDER does not matter");
  ok(!deepEqualJson({ a: 1, b: 2 }, { a: 1 }), "§6 a missing key is not equal");
  ok(!deepEqualJson({ a: 1 }, { a: 1, b: 2 }), "§6 an extra key is not equal");
  ok(!deepEqualJson([1, 2], [2, 1]), "🔴 §6 array ORDER does matter");
  ok(deepEqualJson([1, [2, { x: 1, y: 2 }]], [1, [2, { y: 2, x: 1 }]]), "§6 the compare recurses through arrays and objects");
  ok(!deepEqualJson([1, 2], { 0: 1, 1: 2 }), "§6 an array is not the object with the same indices");
  ok(!deepEqualJson(null, {}), "§6 null is not an empty object");
  ok(deepEqualJson(null, null), "§6 null equals null");
  ok(!deepEqualJson(1, "1"), "§6 a number is not the string of it");
  ok(!deepEqualJson(0, false), "§6 zero is not false");
  ok(deepEqualJson({}, {}), "§6 NEGATIVE CONTROL: two empty objects are equal");
  ok(!deepEqualJson({ a: undefined }, {}), "§6 an explicit undefined value is a key, so it is not equal to no key");
  ok(!deepEqualJson(0, -0), "§6 the leaf compare is Object.is, so -0 is not 0");
  ok(deepEqualJson(-0, -0), "§6 …and -0 equals itself");
  ok(!deepEqualJson([], {}), "§6 an empty array is not an empty object");
  ok(!deepEqualJson("", null), "§6 an empty string is not null");
}

{
  const FROZEN = { page_id: "abc-123" };
  const pin = pinOf(FROZEN);
  const CALL = post(rpc("tools/call", { name: TOOL, arguments: { ...FROZEN, q: "hi" } }));

  const call = await drive(pin, URL_OK, CALL);
  ok(call.err === undefined && call.dialled === 1, "§7 the pinned call reaches the wrapped fetch");
  ok(call.forwarded?.redirect === "error", "🔴 §7 the fence forces `redirect: \"error\"` — a 3xx cannot replay the borrow at an unpinned host");

  const teardown = await drive(pin, URL_OK, { method: "DELETE" });
  ok(teardown.dialled === 1 && teardown.forwarded?.redirect === "error", "🔴 §7 …on the DELETE teardown too");
  const handshake = await drive(pin, URL_OK, post(rpc("initialize", { protocolVersion: "2025-06-18" })));
  ok(handshake.dialled === 1 && handshake.forwarded?.redirect === "error", "🔴 §7 …and on every allowlisted non-tools/call POST");

  const asked = await drive(pin, URL_OK, { ...CALL, redirect: "follow" });
  ok(asked.forwarded?.redirect === "error", "🔴 §7 the fence OVERRIDES a caller-supplied `redirect: \"follow\"`");

  const dup = await drive(pin, URL_OK, post(`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"evil-tool","name":"${TOOL}","arguments":{"page_id":"abc-123"}}}`));
  ok(dup.err === undefined && dup.dialled === 1, "§7 a duplicate-key body whose LAST value is the pinned tool passes the fence");
  ok(
    typeof dup.forwarded?.body === "string" && !dup.forwarded.body.includes("evil-tool"),
    "🔴 §7 …and the bytes the vendor receives no longer carry the shadowed `evil-tool` name",
  );
  const reparsed = JSON.parse(String(dup.forwarded?.body)) as { params: { name: string } };
  ok(reparsed.params.name === TOOL, "§7 the forwarded body names exactly the tool the fence approved");

  ok(
    (call.forwarded?.headers as Record<string, string> | undefined)?.["content-type"] === "application/json",
    "§7 NEGATIVE CONTROL: the caller's headers ride through unchanged",
  );
  ok(call.forwarded?.method === "POST", "§7 …and so does the method");
}

console.log(`mcp-call-fence-test: ${n} assertions passed`);
