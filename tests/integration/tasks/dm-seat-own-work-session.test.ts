import { afterAll, expect, test } from "vitest";

import { NO_REPLY_SENTINEL } from "@open-everywhere/core/agent/channels/normalized-wake.js";
import { parseWindowToken } from "@open-everywhere/core/agent/channels/window-key.js";
import { effectiveUserVaultSubject } from "@open-everywhere/core/agent/connections/connector-auth.js";
import { encryptedKvVault } from "@open-everywhere/core/agent/credentials/kv-vault.js";
import { deploymentOrg } from "@open-everywhere/core/agent/identity/binding.js";

import {
  afterThisTest,
  armSettlement,
  auditCursor,
  bootAgent,
  consumeSettlement,
  disposeLater,
  installSlackWebApiStub,
  registerScript,
  rowsSinceCursor,
  SLACK_TEAM_ID,
  slackDmWake,
  slackTs,
  waitFor,
  waitForAuditRows,
  workTaskIdOfCall,
  type AuditRow,
  type RecordedRequest,
  type ScriptedHandle,
} from "../harness";
import { installHostFetchStub } from "../fetch-stub";

const OWNER_ID = "U0EXOWNER";
const DM_CHANNEL_ID = "D0OPE2350DMSEAT";
const BOT_USER_ID = "U0OPE2350DMBOT";
const CHILD_HOLD_MS = 120_000;
const TURN_END_CEILING_MS = 60_000;

const BRIEF = "ope2350 dm job: look in my notion for the handbook";

// On eve 1.x a connector op is a deferred entry `<connection>__<op>`, reached through `eve__tool`
// (agent/connections/connector-mount.ts). The mount lists the vendor's ops before each model call.
// With no owner token in the vault it lists them anonymously, so the op stays reachable either way.
// The listing proves nothing about the token. The mint `ok` row and the vendor call's bearer token,
// asserted below, are what prove that the owner's own token served the worker's call.
const NOTION_OAUTH_PROVIDER_REF = "mcp.notion.com/notion-mcp";
const CONNECTION = "notion";
const VENDOR_TOOL = "search";
const ENTRY = `${CONNECTION}__${VENDOR_TOOL}`;
const ACCESS_TOKEN = "it-ope2350-dm-mcp-token";

const cleanups: (() => void)[] = [];
afterAll(() => {
  for (const c of cleanups.splice(0).reverse()) c();
});

let tsCounter = 23500;

function armSlack(): void {
  const slack = installSlackWebApiStub((method, params) => {
    if (method === "auth.test") return { ok: true, user_id: BOT_USER_ID, bot_id: "B0OPE2350DMBOT", team_id: SLACK_TEAM_ID };
    if (method === "users.info") {
      const id = params.get("user") ?? "";
      return {
        ok: true,
        user: { id, name: "ope2350-owner", team_id: SLACK_TEAM_ID, is_bot: false, is_restricted: false, is_ultra_restricted: false, is_stranger: false, profile: { display_name: "ope2350-owner", real_name: "OPE 2350 Owner" } },
      };
    }
    if (method === "conversations.members") return { ok: true, members: [], response_metadata: { next_cursor: "" } };
    if (method === "conversations.info") {
      return {
        ok: true,
        channel: { id: params.get("channel"), name: "ope2350-dm", is_channel: true, is_private: false, is_ext_shared: false, is_org_shared: false, is_shared: false, is_pending_ext_shared: false, num_members: 2 },
      };
    }
    if (method === "conversations.history" || method === "conversations.replies") return { ok: true, messages: [] };
    if (method === "chat.postMessage") return { ok: true, channel: params.get("channel"), ts: slackTs(Date.now(), (tsCounter += 1)) };
    if (method === "reactions.add" || method === "reactions.remove") return { ok: true };
    return undefined;
  });
  cleanups.push(() => slack.uninstall());
}

interface McpRequest {
  readonly id: unknown;
  readonly method: string;
  readonly params: Record<string, unknown>;
  readonly authorization: string | null;
}

function rpcOf(init: RequestInit | undefined): McpRequest | undefined {
  try {
    const parsed = JSON.parse(String(init?.body)) as { id?: unknown; method?: unknown; params?: unknown };
    if (typeof parsed.method !== "string") return undefined;
    const params = typeof parsed.params === "object" && parsed.params !== null ? (parsed.params as Record<string, unknown>) : {};
    return { id: parsed.id, method: parsed.method, params, authorization: new Headers(init?.headers).get("authorization") };
  } catch {
    return undefined;
  }
}

function armNotionMcp(): { readonly calls: readonly { url: string; init: RequestInit | undefined }[] } {
  const vendor = installHostFetchStub("https://mcp.notion.com", (_url, init) => {
    const httpMethod = (init?.method ?? "GET").toUpperCase();
    if (httpMethod === "GET") return new Response(null, { status: 405 });
    if (httpMethod === "DELETE") return new Response(null, { status: 200 });
    const rpc = rpcOf(init);
    if (rpc === undefined) return undefined;
    const json = (result: unknown, extra: Record<string, string> = {}): Response =>
      new Response(JSON.stringify({ id: rpc.id, jsonrpc: "2.0", result }), { status: 200, headers: { "content-type": "application/json", ...extra } });
    if (rpc.method === "initialize") {
      const protocolVersion = typeof rpc.params["protocolVersion"] === "string" ? (rpc.params["protocolVersion"] as string) : "2025-06-18";
      return json({ capabilities: { tools: {} }, protocolVersion, serverInfo: { name: "it-ope2350-notion-mcp", version: "1.0.0" } }, { "mcp-session-id": "it-ope2350-sess" });
    }
    if (rpc.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (rpc.method === "tools/list") {
      return json({
        tools: [
          {
            name: VENDOR_TOOL,
            description: "Search the workspace.",
            inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
            annotations: { readOnlyHint: true },
          },
        ],
      });
    }
    if (rpc.method === "tools/call") return json({ content: [{ type: "text", text: JSON.stringify({ results: [{ title: "Handbook" }] }) }] });
    return undefined;
  });
  cleanups.push(() => vendor.uninstall());
  return vendor;
}

async function seedOwnerNotionToken(): Promise<void> {
  const subject = await effectiveUserVaultSubject(CONNECTION, deploymentOrg(), "slack", SLACK_TEAM_ID, OWNER_ID);
  await encryptedKvVault().write(`oe-oauth:tok:${NOTION_OAUTH_PROVIDER_REF}:user:${subject}`, JSON.stringify({ accessToken: ACCESS_TOKEN, obtainedAt: Date.now() }));
}

function detailOf(row: AuditRow | undefined): Record<string, unknown> {
  return (row?.detail ?? {}) as Record<string, unknown>;
}

function promptOf(request: RecordedRequest): string {
  return request.messages.map((message) => message.text).join("\n");
}

function assertNoFault(handle: ScriptedHandle, label: string): void {
  expect(
    handle.requests.filter((r) => r.fault !== undefined).map((r) => `${r.role}#${r.stepIndex}: ${String(r.fault)}`),
    `${label}: a scripted request degraded instead of answering the script`,
  ).toEqual([]);
}

test("🔴 a DM seat forwards its job to the DM's OWN work session, whose worker holds the owner's own-account plane, and the seat's turn never waits", async () => {
  armSlack();
  const vendor = armNotionMcp();
  // The vault seed below must land in the store the server reads. Under the default PGlite boot
  // the test process writes a store of its own, so the worker's mint finds no token.
  await bootAgent({ sharedSqlite: true });
  const settings = await import("@open-everywhere/core/agent/settings/settings.js");
  settings.overrideSettingsForTest({ connectors: { userPrincipal: true } });
  expect(settings.getSettings().connectors.userPrincipal, "the per-user plane is not armed").toBe(true);
  await seedOwnerNotionToken();
  const cursor = await auditCursor();

  const dm = disposeLater(
    registerScript({
      parent: [{ calls: [{ tool: "work", input: { message: BRIEF }, id: "ope2350-dm-work" }] }, { say: NO_REPLY_SENTINEL }],
      child: [{ delayMs: CHILD_HOLD_MS, calls: [{ tool: "eve__tool", input: { name: ENTRY, input: { query: "handbook" } }, id: "ope2350-dm-search" }] }, { say: "ope2350 dm job result" }],
    }),
  );
  afterThisTest(() => dm.releaseHolds());

  const ts = slackTs(Date.now(), (tsCounter += 1));
  const res = await slackDmWake({ channelId: DM_CHANNEL_ID, userId: OWNER_ID, text: "ope2350 look in my notion", ts, eventId: `EvOPE2350Dm${ts.replace(".", "")}` });
  expect(res.status, `the Slack front refused the DM wake: ${res.body.slice(0, 200)}`).toBe(200);

  const seatFirst = await waitFor(() => dm.requests.find((r) => r.role === "parent" && r.stepIndex === 0), "the DM seat's turn");
  expect(seatFirst.tools, "🔴 the DM seat holds the forward verb").toContain("work");
  expect(seatFirst.tools, "🔴 the DM seat holds no native `agent`: a child inside its own turn is the hold").not.toContain("agent");
  await waitFor(() => dm.requests.find((r) => r.role === "parent" && r.stepIndex === 1), "the DM seat's turn to serve its last step (it forwarded and ended)", TURN_END_CEILING_MS);
  const child = await waitFor(() => dm.requests.find((r) => r.role === "child" && promptOf(r).includes(BRIEF)), "the DM job's worker's first (held) model call");
  expect(await rowsSinceCursor(cursor, ["delegation.task_settled", "delegation.task_failed"], { limit: 50 }), "the job settled before the seat's turn ended — this run measured no hold").toEqual([]);
  const taskId = await workTaskIdOfCall(cursor, dm, "ope2350-dm-work", "the DM job");
  assertNoFault(dm, "the DM seat's turn");

  const forwarded = await waitFor(async () => {
    const rows = await rowsSinceCursor(cursor, ["work.forwarded"], { limit: 50 });
    return rows.length > 0 ? rows : undefined;
  }, "the DM seat's work.forwarded row");
  expect(forwarded, "one forward, from the DM seat").toHaveLength(1);
  const w = parseWindowToken(String(detailOf(forwarded[0]).workToken ?? ""));
  expect(w?.domain.startsWith("oe-dm/"), "🔴 the DM's job left the DM's own anchor").toBe(true);
  expect(w?.windowId, "🔴 the DM's job did not run in the DM's own work session").toBe(`w/${w?.domain}`);
  expect(detailOf(forwarded[0]).seatSessionId, "the forward did not come from the DM seat's own session").toBe(seatFirst.sessionId);

  const started = (await rowsSinceCursor(cursor, ["delegation.task_started"], { limit: 50 })).find((r) => detailOf(r).task === taskId);
  expect(started, "the DM job's task_started row").toBeDefined();
  const startedSession = detailOf(started).session;
  expect(startedSession, "the task_started row names no session — the checks below would compare nothing").toEqual(expect.stringMatching(/.+/));
  expect(detailOf(started).request, "🔴 the task started for a request other than this seat's forward").toBe(detailOf(forwarded[0]).requestId);
  expect(startedSession, "🔴 the DM job's task started in the DM seat's own session — the seat held the job").not.toBe(seatFirst.sessionId);
  expect(child.sessionId, "the worker ran in the DM seat's own session").not.toBe(seatFirst.sessionId);

  const closing = disposeLater(armSettlement(dm, { parent: [{ say: NO_REPLY_SENTINEL }, { say: NO_REPLY_SENTINEL }] }));
  dm.releaseHolds();

  const use = await waitForAuditRows({
    probe: async () => (await rowsSinceCursor(cursor, ["connector.use"])).find((r) => detailOf(r).connection === "notion"),
    label: "the DM job's worker's notion connector.use row",
    actions: ["connector.use"],
    cursor,
  });
  expect(detailOf(use).mode, "🔴 the DM's work-session worker did not bind the DM").toBe("dm");
  const mints = await waitForAuditRows({
    probe: async () => {
      const rows = (await rowsSinceCursor(cursor, ["connector.mint"])).filter((r) => detailOf(r).connector === "notion");
      return rows.length > 0 ? rows : undefined;
    },
    label: "the DM job's worker's notion connector.mint row",
    actions: ["connector.mint"],
    cursor,
  });
  expect(mints.map((r) => detailOf(r).subject), "🔴 the DM's work-session worker minted for something other than the DM owner").toEqual(mints.map(() => "user"));
  expect(mints.map((r) => detailOf(r).outcome), "🔴 the DM owner's own notion token did not mint for the DM's worker").toContain("ok");
  const vendorCalls = vendor.calls.map((c) => rpcOf(c.init)).filter((r): r is McpRequest => r?.method === "tools/call");
  expect(vendorCalls.map((r) => r.params["name"]), "🔴 the worker's notion op did not reach the vendor exactly once").toEqual([VENDOR_TOOL]);
  expect(vendorCalls[0]?.authorization, "🔴 the worker's notion op reached the vendor without the DM owner's own token").toBe(`Bearer ${ACCESS_TOKEN}`);
  expect((await rowsSinceCursor(cursor, ["connector.refused"])).filter((r) => detailOf(r).connection === "notion"), "the owner's own notion was refused to the DM's worker").toEqual([]);

  const read = await consumeSettlement({ armed: closing, dispatched: dm, taskId, label: "the DM seat's result wake" });
  expect(read.sessionId, "🔴 the result woke a seat other than the DM seat").toBe(seatFirst.sessionId);
  expect(read.turnId, "the result was read in the forwarding turn").not.toBe(seatFirst.turnId);
  const wake = await waitFor(async () => {
    const rows = (await rowsSinceCursor(cursor, ["work.result_wake"], { limit: 50 })).filter((r) => detailOf(r).outcome === "delivered");
    return rows.length > 0 ? rows : undefined;
  }, "the delivered work.result_wake row");
  expect(wake.map((r) => detailOf(r).taskId), "one delivered result wake, for the DM job").toEqual([taskId]);
  assertNoFault(closing, "the DM seat's result turn");
});
