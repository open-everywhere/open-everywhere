import { afterAll, expect, test } from "vitest";

import { deploymentOrg } from "@open-everywhere/core/agent/identity/binding.js";
import { encryptedKvVault } from "@open-everywhere/core/agent/credentials/kv-vault.js";
import { effectiveUserVaultSubject } from "@open-everywhere/core/agent/connections/connector-auth.js";

import {
  bootAgent,
  disposeLater,
  installSlackWebApiStub,
  readAuditRows,
  registerScript,
  slackDmWake,
  slackTs,
  SLACK_TEAM_ID,
  waitFor,
  waitForChildren,
  type AuditRow,
  type ScriptedHandle,
} from "../harness";
import { installHostFetchStub } from "../fetch-stub";

const NOTION_OAUTH_PROVIDER_REF = "mcp.notion.com/notion-mcp";
process.env.OE_OAUTH_ENABLED = "1";
process.env.OE_OAUTH_CONFIG = JSON.stringify({
  [NOTION_OAUTH_PROVIDER_REF]: { mode: "discovery-dcr-pkce", resource: "https://mcp.notion.com/mcp" },
});

const OPERATOR_ID = "U0EXOWNER";
const DM_CHANNEL_ID = "D0IT1232OPERATOR";
const BOT_USER_ID = "U0IT1232BOT";

const READ_VENDOR_TOOL = "search_pages";
const READ_TOOL = `notion__${READ_VENDOR_TOOL}`;
const WRITE_VENDOR_TOOL = "create_page";
const WRITE_TOOL = `notion__${WRITE_VENDOR_TOOL}`;

const OPERATOR_ACCESS_TOKEN = "it-ope1232-operator-mcp-token";
const VENDOR_BODY_MARKER = "it-ope1232-vendor-body";

const cleanups: (() => void)[] = [];
afterAll(() => {
  for (const c of cleanups.reverse()) c();
});

let tsCounter = 0;

interface McpRequest {
  readonly method: string;
  readonly params: Record<string, unknown>;
}

function rpcOf(init: RequestInit | undefined): McpRequest | undefined {
  try {
    const parsed = JSON.parse(String(init?.body)) as { method?: unknown; params?: unknown };
    if (typeof parsed.method !== "string") return undefined;
    const params = typeof parsed.params === "object" && parsed.params !== null ? (parsed.params as Record<string, unknown>) : {};
    return { method: parsed.method, params };
  } catch {
    return undefined;
  }
}

function installVendorMcpStub(): {
  readonly calls: readonly { url: string; init: RequestInit | undefined }[];
  uninstall(): void;
} {
  return installHostFetchStub("https://mcp.notion.com", (_url, init) => {
    const httpMethod = (init?.method ?? "GET").toUpperCase();
    if (httpMethod === "GET") return new Response(null, { status: 405 });
    if (httpMethod === "DELETE") return new Response(null, { status: 200 });
    const rpc = rpcOf(init);
    if (rpc === undefined) return undefined;
    const id = (JSON.parse(String(init?.body)) as { id?: unknown }).id;
    const json = (result: unknown, extra: Record<string, string> = {}): Response =>
      new Response(JSON.stringify({ id, jsonrpc: "2.0", result }), { status: 200, headers: { "content-type": "application/json", ...extra } });
    if (rpc.method === "initialize") {
      const protocolVersion = typeof rpc.params["protocolVersion"] === "string" ? (rpc.params["protocolVersion"] as string) : "2025-06-18";
      return json({ capabilities: { tools: {} }, protocolVersion, serverInfo: { name: "it-ope1232-notion-mcp", version: "1.0.0" } }, { "mcp-session-id": "it-ope1232-sess" });
    }
    if (rpc.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (rpc.method === "tools/list") {
      return json({
        tools: [
          {
            description: "Search pages in the workspace by keyword.",
            inputSchema: { properties: { query: { type: "string" } }, required: ["query"], type: "object" },
            name: READ_VENDOR_TOOL,
          },
          {
            description: "Create one page.",
            inputSchema: { properties: { title: { type: "string" } }, required: ["title"], type: "object" },
            name: WRITE_VENDOR_TOOL,
          },
        ],
      });
    }
    if (rpc.method === "tools/call") return json({ content: [{ text: VENDOR_BODY_MARKER, type: "text" }] });
    return undefined;
  });
}

function vendorRequests(
  stub: { readonly calls: readonly { url: string; init: RequestInit | undefined }[] },
  method: string,
): { url: string; init: RequestInit | undefined; rpc: McpRequest }[] {
  return stub.calls
    .map((c) => ({ ...c, rpc: rpcOf(c.init) }))
    .filter((c): c is { url: string; init: RequestInit | undefined; rpc: McpRequest } => c.rpc?.method === method);
}

function authorizationOf(init: RequestInit | undefined): string {
  const h = init?.headers;
  if (h === undefined) return "";
  if (h instanceof Headers) return h.get("authorization") ?? "";
  if (Array.isArray(h)) return h.find(([k]) => k.toLowerCase() === "authorization")?.[1] ?? "";
  const rec = h as Record<string, string>;
  return rec["authorization"] ?? rec["Authorization"] ?? "";
}

function armSlackStub(): { uninstall(): void } {
  return installSlackWebApiStub((method, params) => {
    switch (method) {
      case "auth.test":
        return { ok: true, user_id: BOT_USER_ID, bot_id: "B0IT1232BOT", team_id: SLACK_TEAM_ID };
      case "users.info": {
        const id = params.get("user") ?? "";
        return {
          ok: true,
          user: {
            id,
            name: "it1232-operator",
            team_id: SLACK_TEAM_ID,
            is_bot: false,
            is_restricted: false,
            is_ultra_restricted: false,
            is_stranger: false,
            profile: { display_name: "it1232-operator", real_name: "IT 1232 Operator" },
          },
        };
      }
      case "conversations.info":
        return { ok: true, channel: { id: params.get("channel"), name: "it1232-dm", is_im: true, is_channel: false, is_private: true, num_members: 2 } };
      case "conversations.open":
        return { ok: true, channel: { id: DM_CHANNEL_ID } };
      case "conversations.history":
        return { ok: true, messages: [] };
      case "chat.postMessage":
        return { ok: true, channel: params.get("channel"), ts: slackTs(Date.now(), (tsCounter += 1)) };
      case "chat.update":
      case "chat.postEphemeral":
        return { ok: true };
      default:
        return undefined;
    }
  });
}

async function pinShippedFixture(): Promise<void> {
  const { loadBundles, loadBindings } = await import("../../../agent/access/bundles");
  const bundle = loadBundles().find((b) => b.name === "notion-personal");
  expect(bundle, "the `notion-personal` bundle is gone from agent/access/bundles.ts — this drive can bind no user-oauth credential").toBeDefined();
  const notionGrant = (bundle?.connectors ?? []).find((c) => (typeof c === "string" ? c : c.name) === "notion");
  expect(
    typeof notionGrant === "string" ? undefined : notionGrant?.credential,
    "`notion-personal` no longer grants notion at the `user-oauth` credential",
  ).toBe("user-oauth");
  expect(
    loadBindings().some(
      (b) => b.bundle === "notion-personal" && b.scope.level === "principal" && b.scope.principal === `slack/${SLACK_TEAM_ID}/${OPERATOR_ID}`,
    ),
    `no principal binding of \`notion-personal\` to slack/${SLACK_TEAM_ID}/${OPERATOR_ID} — the drive below would resolve no connector at all`,
  ).toBe(true);

  const notionConnection = (await import("@open-everywhere/core/agent/connections/notion.js")).default as { readonly url?: unknown };
  expect(
    String(notionConnection.url ?? ""),
    "the notion connection no longer dials mcp.notion.com — the vendor stub below would not be the thing it reaches",
  ).toContain("mcp.notion.com");
}

async function pinConnectorFlagsAndTiers(): Promise<void> {
  const { getSettings } = await import("@open-everywhere/core/agent/settings/settings.js");
  const connectors = getSettings().connectors;
  expect(
    connectors.userPrincipal,
    "this deployment no longer ships connectors.userPrincipal ON — the app-principal path refuses the user-oauth credential and no arm below can run",
  ).toBe(true);
  expect(
    connectors.opTiering,
    "this deployment no longer ships connectors.opTiering ON — the blanket once() policy cards BOTH arms and the read/write contrast below is gone",
  ).toBe(true);

  const { effectiveConnectorOpTier } = await import("@open-everywhere/core/agent/access/connector-op-gating.js");
  expect(effectiveConnectorOpTier(READ_TOOL), `${READ_TOOL} is no longer an open-tier read — arm ③ would be asserting the wrong outcome`).toBe("read");
  expect(
    effectiveConnectorOpTier(WRITE_TOOL),
    `${WRITE_TOOL} is no longer a gated write — arm ④ would be asserting a card that the plane is right not to raise`,
  ).toBe("write");
}

async function inputRequestRows(sinceIso: string): Promise<readonly AuditRow[]> {
  return readAuditRows({ actions: ["turn.question_bridged", "turn.native_input_requested"], sinceIso, limit: 50 });
}

function connectionSearchOutputs(handle: ScriptedHandle): readonly string[] {
  const out: string[] = [];
  for (const r of handle.requests) for (const t of r.toolResults) if (t.name === "connection_search") out.push(String(t.output));
  return out;
}

test("a DM-delegated worker mounts a DISCOVERED connector op from a real connection_search, and calling it raises the approval BEFORE the vendor is dialled", async () => {
  await bootAgent({ sharedSqlite: true });
  await pinShippedFixture();
  await pinConnectorFlagsAndTiers();

  const slack = armSlackStub();
  cleanups.push(() => slack.uninstall());
  const vendor = installVendorMcpStub();
  cleanups.push(() => vendor.uninstall());

  const vaultSubject = await effectiveUserVaultSubject("notion", deploymentOrg(), "slack", SLACK_TEAM_ID, OPERATOR_ID);
  await encryptedKvVault().write(
    `oe-oauth:tok:${NOTION_OAUTH_PROVIDER_REF}:user:${vaultSubject}`,
    JSON.stringify({ accessToken: OPERATOR_ACCESS_TOKEN, obtainedAt: Date.now() }),
  );

  const sinceIso = new Date(Date.now() - 5_000).toISOString();

  const handle = disposeLater(
    registerScript({
      parent: [{ calls: [{ tool: "agent", input: { message: "look in notion" }, id: "it1232-delegate" }] }, { say: "handed off" }],
      child: [
        { calls: [{ tool: "connection_search", input: { keywords: "pages" }, id: "it1232-search" }] },
        { calls: [{ tool: READ_TOOL, input: { query: "handbook" }, id: "it1232-read" }] },
        { calls: [{ tool: WRITE_TOOL, input: { title: "handbook notes" }, id: "it1232-write" }] },
        { say: "reported" },
      ],
    }),
  );

  const ts = slackTs(Date.now(), (tsCounter += 1));
  const res = await slackDmWake({
    channelId: DM_CHANNEL_ID,
    userId: OPERATOR_ID,
    text: "it1232 find the handbook",
    ts,
    eventId: `EvIT1232${ts.replace(".", "")}`,
  });
  expect(res.status, `the DM wake POST was not accepted at all — a signature or route failure: ${res.body.slice(0, 200)}`).toBe(200);

  await waitForChildren(handle, { count: 1, lastStepIndex: 2, label: "it1232: the worker's write-calling step" });

  expect(
    handle.requests.filter((r) => r.fault !== undefined),
    "a scripted request degraded instead of answering the script — the arms below would be reading a different run",
  ).toEqual([]);

  const listed = vendorRequests(vendor, "tools/list");
  expect(
    listed.length,
    `the real connection_search never reached the vendor's MCP server — it stopped earlier. connection_search said: ${connectionSearchOutputs(handle).join(" | ").slice(0, 400)}`,
  ).toBeGreaterThan(0);
  expect(
    authorizationOf(listed[0]!.init),
    "the vendor was dialled under something other than the operator's seeded per-user token — the mint took a different credential path",
  ).toContain(OPERATOR_ACCESS_TOKEN);

  const secondStep = handle.requests.find((r) => r.role === "child" && r.stepIndex === 1);
  expect(secondStep, "the worker never reached a second step — the search step faulted").toBeDefined();
  for (const mounted of [READ_TOOL, WRITE_TOOL]) {
    expect(
      secondStep!.tools,
      `🔴 the discovered op ${mounted} did NOT mount after a real connection_search. The worker was offered [${secondStep!.tools.slice().sort().join(", ")}]`,
    ).toContain(mounted);
  }
  const firstStep = handle.requests.find((r) => r.role === "child" && r.stepIndex === 0)!;
  expect(firstStep.tools, "the worker's first step was not recorded at all — the absence assertion below would be vacuous").toContain("connection_search");
  for (const mounted of [READ_TOOL, WRITE_TOOL]) {
    expect(
      firstStep.tools,
      `🔴 ${mounted} was already mounted BEFORE the search ran, so the mount proves nothing about the context cache`,
    ).not.toContain(mounted);
  }

  const readResult = (() => {
    for (const r of handle.requests) for (const t of r.toolResults) if (t.name === READ_TOOL) return t;
    return undefined;
  })();
  expect(readResult, `the READ op ${READ_TOOL} never returned a result — the open tier did not execute`).toBeDefined();
  expect(readResult!.isError, `the READ op ${READ_TOOL} errored: ${String(readResult!.output).slice(0, 400)}`).toBe(false);
  expect(
    String(readResult!.output),
    `the READ op's result did not carry the vendor's own body — it was answered by something other than the stubbed MCP server`,
  ).toContain(VENDOR_BODY_MARKER);
  const readCalls = vendorRequests(vendor, "tools/call").filter((c) => c.rpc.params["name"] === READ_VENDOR_TOOL);
  expect(readCalls.length, `the READ op returned a body but did not leave the host as exactly one MCP tools/call for ${READ_VENDOR_TOOL}`).toBe(1);
  expect(
    authorizationOf(readCalls[0]!.init),
    "the READ op's call left under something other than the operator's seeded per-user token",
  ).toContain(OPERATOR_ACCESS_TOKEN);

  const outcome = await waitFor(async () => {
    const card = (await inputRequestRows(sinceIso)).find((r) => r.detail?.toolName === WRITE_TOOL);
    if (card !== undefined) return { card };
    const wrote = vendorRequests(vendor, "tools/call").find((c) => c.rpc.params["name"] === WRITE_VENDOR_TOOL);
    if (wrote !== undefined) return { wrote };
    return undefined;
  }, `the WRITE op's outcome — an approval card for ${WRITE_TOOL}, or a call that reached the vendor`);
  expect(
    outcome.wrote,
    `🔴 the WRITE op REACHED THE VENDOR with no approval raised — the connection's approval policy is not gating a discovered op (the OPE-1218 drop)`,
  ).toBeUndefined();
  const raised = outcome.card!;
  expect(
    raised.detail?.kind,
    `the request raised for ${WRITE_TOOL} was not eve's tool-approval — the connector op was gated as something else`,
  ).toBe("tool-approval");
  expect(
    (await inputRequestRows(sinceIso)).filter((r) => r.detail?.toolName === READ_TOOL),
    `🔴 the READ op ${READ_TOOL} also raised an input request — the tiering is not distinguishing the two arms`,
  ).toEqual([]);

  expect(
    vendorRequests(vendor, "tools/call").map((c) => c.rpc.params["name"]),
    `🔴 the WRITE op reached the vendor AFTER its card was raised — the card is being shown but not awaited`,
  ).toEqual([READ_VENDOR_TOOL]);
  expect(
    handle.requests.flatMap((r) => r.toolResults).filter((t) => t.name === WRITE_TOOL),
    "the worker received a result for the gated write — the turn was not suspended at its card",
  ).toEqual([]);
  expect(
    handle.requests.find((r) => r.role === "child" && r.stepIndex === 3),
    "the worker ran past the gated write — the turn was not suspended at all",
  ).toBeUndefined();
}, 600_000);
