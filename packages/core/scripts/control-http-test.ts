import assert from "node:assert/strict";
import { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createAdminHttpServer } from "../agent/control/http.js";
import { CONTROL_TOOL_NAMES } from "../agent/control/server.js";

import { pinSuiteStore } from "./_suite-store.js";
pinSuiteStore("control-http");

let n = 0;
const ok = (label: string, cond: boolean) => {
  assert.ok(cond, label);
  n++;
};

async function listen(server: import("node:http").Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}/`;
}

{
  const server = createAdminHttpServer();
  const url = await listen(server);
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
  ok("unauthenticated remote request is refused with 401", res.status === 401);
  const json = (await res.json()) as { error?: { message?: string } };
  ok("401 body explains the OAuth requirement", /oauth|authoriz/i.test(json.error?.message ?? ""));
  server.close();
}

{
  const server = createAdminHttpServer({ allowUnauthenticated: true });
  const url = await listen(server);
  const client = new Client({ name: "http-smoke", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));

  const tools = await client.listTools();
  const names = tools.tools.map((t) => t.name).sort();
  ok("HTTP transport lists exactly the admin tools", JSON.stringify(names) === JSON.stringify([...CONTROL_TOOL_NAMES].sort()));

  const res = await client.callTool({ name: "spend_report", arguments: {} });
  const text = (res.content as { type: string; text: string }[])[0].text;
  ok(
    `spend_report succeeded over HTTP (the view did not throw) — got: ${text.slice(0, 300)}`,
    res.isError !== true,
  );
  const parsed = JSON.parse(text);
  ok("spend_report returns a period over HTTP", /^\d{4}-\d{2}$/.test(parsed.period));

  await client.close();
  server.close();
}

{
  const unconfigured = createAdminHttpServer({ allowUnauthenticated: true });
  const url = await listen(unconfigured);
  const client = new Client({ name: "http-transcript", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  const res = (await client.callTool({ name: "session_transcript", arguments: { sessionId: "wrun_abc" } })) as unknown as {
    isError?: boolean;
    content: { text: string }[];
  };
  ok("session_transcript over HTTP: an unconfigured mount names the env to set", res.isError === true && /OE_DEPLOY_CONTROL_TOKEN/.test(res.content[0].text));
  await client.close();
  unconfigured.close();
}
{
  let asked = "";
  const configured = createAdminHttpServer({
    allowUnauthenticated: true,
    readTranscript: async (req) => {
      asked = req.sessionId;
      return { sessionId: req.sessionId, startIndex: 0, nextIndex: 1, complete: true, eventCount: 1, text: "03:00:01 [said] hello" };
    },
  });
  const url = await listen(configured);
  const client = new Client({ name: "http-transcript", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  const res = (await client.callTool({ name: "session_transcript", arguments: { sessionId: "wrun_abc" } })) as unknown as {
    isError?: boolean;
    content: { text: string }[];
  };
  ok(`session_transcript over HTTP: a configured mount answers with the render — got: ${res.content[0].text.slice(0, 200)}`, res.isError !== true && res.content[0].text.includes("[said] hello"));
  ok("session_transcript over HTTP: the mount's reader is the one called, with the caller's session id", asked === "wrun_abc");
  await client.close();
  configured.close();
}

console.log(`\n✓ control HTTP transport: ${n} assertions passed (fail-closed + e2e round-trip)\n`);
