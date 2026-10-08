import { afterAll, expect, test } from "vitest";

import { NO_REPLY_SENTINEL } from "@open-everywhere/core/agent/channels/normalized-wake.js";
import { deploymentOrg } from "@open-everywhere/core/agent/identity/binding.js";
import { encryptedKvVault } from "@open-everywhere/core/agent/credentials/kv-vault.js";
import { effectiveUserVaultSubject } from "@open-everywhere/core/agent/connections/connector-auth.js";

import {
  armSettlement,
  auditCursor,
  awaitWorkResult,
  bootAgent,
  disposeLater,
  installSlackWebApiStub,
  registerScript,
  rowsSinceCursor,
  SLACK_TEAM_ID,
  slackDmWake,
  slackInteractivityPost,
  slackTs,
  waitFor,
  waitForChildren,
  workTaskIdOfCall,
  type AuditRow,
} from "../harness";
import { installHostFetchStub } from "../fetch-stub";

const NOTION_OAUTH_PROVIDER_REF = "mcp.notion.com/notion-mcp";
process.env.OE_OAUTH_ENABLED = "1";
process.env.OE_OAUTH_CONFIG = JSON.stringify({
  [NOTION_OAUTH_PROVIDER_REF]: { mode: "discovery-dcr-pkce", resource: "https://mcp.notion.com/mcp" },
});

const OPERATOR_ID = "U0EXOWNER";
const DM_CHANNEL_ID = "D0IT2388OPERATOR";
const BOT_USER_ID = "U0IT2388BOT";
const CONNECTION = "notion";
const WRITE_VENDOR_TOOL = "create_page";
const WRITE_TOOL = `${CONNECTION}__${WRITE_VENDOR_TOOL}`;
const WRITE_CALL_ID = "it2388-write";
const REPLAY_CALL_ID = "it2388-replay";
const OPERATOR_ACCESS_TOKEN = "it-ope2388-operator-mcp-token";
const VENDOR_BODY_MARKER = "it-ope2388-vendor-body";
const REPLAY_KEY = "oe_approved_card";

const APPROVED_INPUT = { title: "it2388 handbook notes", body: "b".repeat(900), allow_async: false };

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

function installVendorMcpStub(): { readonly calls: readonly { url: string; init: RequestInit | undefined }[]; uninstall(): void } {
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
      return json({ capabilities: { tools: {} }, protocolVersion, serverInfo: { name: "it-ope2388-notion-mcp", version: "1.0.0" } }, { "mcp-session-id": "it-ope2388-sess" });
    }
    if (rpc.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (rpc.method === "tools/list") {
      return json({
        tools: [
          {
            description: "Create one page.",
            inputSchema: {
              properties: { title: { type: "string" }, body: { type: "string" }, allow_async: { type: "boolean" } },
              required: ["title"],
              type: "object",
            },
            name: WRITE_VENDOR_TOOL,
          },
        ],
      });
    }
    if (rpc.method === "tools/call") return json({ content: [{ text: VENDOR_BODY_MARKER, type: "text" }] });
    return undefined;
  });
}

function writeCalls(stub: { readonly calls: readonly { url: string; init: RequestInit | undefined }[] }): McpRequest[] {
  return stub.calls.map((c) => rpcOf(c.init)).filter((r): r is McpRequest => r?.method === "tools/call" && r.params["name"] === WRITE_VENDOR_TOOL);
}

function armSlackStub(): { readonly calls: readonly { method: string; params: URLSearchParams }[]; uninstall(): void } {
  return installSlackWebApiStub((method, params) => {
    switch (method) {
      case "auth.test":
        return { ok: true, user_id: BOT_USER_ID, bot_id: "B0IT2388BOT", team_id: SLACK_TEAM_ID };
      case "users.info": {
        const id = params.get("user") ?? "";
        return {
          ok: true,
          user: {
            id,
            name: "it2388-operator",
            team_id: SLACK_TEAM_ID,
            is_bot: false,
            is_restricted: false,
            is_ultra_restricted: false,
            is_stranger: false,
            profile: { display_name: "it2388-operator", real_name: "IT 2388 Operator" },
          },
        };
      }
      case "conversations.members":
        return { ok: true, members: [], response_metadata: { next_cursor: "" } };
      case "conversations.info":
        return { ok: true, channel: { id: params.get("channel"), name: "it2388-dm", is_im: true, is_channel: false, is_private: true, num_members: 2 } };
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

const isConnectorCard = (r: AuditRow): boolean => r.detail?.kind === "op.connector";

test("an approved op.connector card is replayed BY ITS ID from a new job, and the vendor gets the card's stored input once", async () => {
  await bootAgent({ sharedSqlite: true });
  const { getSettings } = await import("@open-everywhere/core/agent/settings/settings.js");
  expect(getSettings().connectors.opTiering, "this deployment no longer ships connectors.opTiering ON — the write would not card").toBe(true);

  const slack = armSlackStub();
  cleanups.push(() => slack.uninstall());
  const vendor = installVendorMcpStub();
  cleanups.push(() => vendor.uninstall());
  const org = deploymentOrg();
  const vaultSubject = await effectiveUserVaultSubject("notion", org, "slack", SLACK_TEAM_ID, OPERATOR_ID);
  await encryptedKvVault().write(`oe-oauth:tok:${NOTION_OAUTH_PROVIDER_REF}:user:${vaultSubject}`, JSON.stringify({ accessToken: OPERATOR_ACCESS_TOKEN, obtainedAt: Date.now() }));
  const provider = await import("@open-everywhere/core/agent/operational/provider.js");
  const store = provider.getOperationalStore();

  const cursor = await auditCursor();

  const first = disposeLater(
    registerScript({
      parent: [{ calls: [{ tool: "work", input: { message: "create the handbook page in notion" }, id: "it2388-delegate" }] }, { say: NO_REPLY_SENTINEL }],
      child: [
        { delayMs: 120_000, calls: [{ tool: "connection_search", input: { query: "page" }, id: "it2388-search" }] },
        { calls: [{ tool: "connection_execute", input: { connection: CONNECTION, tool: WRITE_VENDOR_TOOL, input: APPROVED_INPUT }, id: WRITE_CALL_ID }] },
        { say: "reported: the page waits for approval" },
      ],
    }),
  );
  const ts = slackTs(Date.now(), (tsCounter += 1));
  const res = await slackDmWake({ channelId: DM_CHANNEL_ID, userId: OPERATOR_ID, text: "it2388 create the handbook page", ts, eventId: `EvIT2388${ts.replace(".", "")}` });
  expect(res.status, `the DM wake POST was refused: ${res.body.slice(0, 200)}`).toBe(200);
  await waitFor(() => first.requests.find((r) => r.role === "parent" && r.stepIndex === 1), "it2388: the DM seat's receipt step");
  await waitForChildren(first, { count: 1, lastStepIndex: 0, label: "it2388: the first child to enter its hold" });
  const firstTask = await workTaskIdOfCall(cursor, first, "it2388-delegate", "it2388: the first forward");
  const seatSession = first.requests.find((r) => r.role === "parent" && typeof r.sessionId === "string")?.sessionId;
  expect(seatSession, "the DM seat served no step").toBeDefined();
  const firstSettlement = disposeLater(armSettlement(first, { parent: [{ say: NO_REPLY_SENTINEL }, { say: NO_REPLY_SENTINEL }] }));
  first.releaseHolds();
  await waitForChildren(first, { count: 1, lastStepIndex: 2, label: "it2388: the first child's report step" });
  await awaitWorkResult({ handle: firstSettlement, taskId: firstTask, label: "it2388: the DM seat reads the first job's result" });
  expect(first.requests.filter((r) => r.fault !== undefined), "a scripted request of the first job degraded").toEqual([]);

  const card = await waitFor(async () => (await rowsSinceCursor(cursor, ["approval.requested"], { limit: 50 })).find(isConnectorCard), `the op.connector card for ${WRITE_TOOL}`);
  const pendingId = String(card.detail?.id ?? "");
  const row = await store.getPendingAction(org, pendingId);
  expect(row?.status, "the card is not pending").toBe("pending");
  const frozen = JSON.parse(row!.argsJson) as { tool?: unknown; input?: unknown; inputPreview?: unknown; memoKind?: unknown };
  expect(frozen.tool).toBe(WRITE_TOOL);
  expect(frozen.input, "the card does not store the whole approved input").toEqual(APPROVED_INPUT);
  expect(String(frozen.inputPreview).endsWith("…"), "control: the card's preview is truncated").toBe(true);
  expect(writeCalls(vendor), "🔴 the write reached the vendor before any approval").toEqual([]);
  const denied = first.requests.flatMap((r) => r.toolResults).find((t) => t.id === WRITE_CALL_ID);
  expect(JSON.stringify(denied?.output), "the deny does not name the replay by card id").toContain(REPLAY_KEY);
  first.dispose();
  firstSettlement.dispose();

  const replayForward = `Replay approved card ${pendingId}: call connection_execute with connection ${CONNECTION}, tool ${WRITE_VENDOR_TOOL}, input {"${REPLAY_KEY}":"${pendingId}"}.`;
  const seatLeg = disposeLater(
    registerScript(
      { parent: [{ calls: [{ tool: "work", input: { message: replayForward }, id: "it2388-replay-forward" }] }, { say: NO_REPLY_SENTINEL }, { say: NO_REPLY_SENTINEL }, { say: NO_REPLY_SENTINEL }] },
      seatSession!,
    ),
  );
  const childLeg = disposeLater(
    registerScript({
      parent: [],
      child: [
        { calls: [{ tool: "connection_execute", input: { connection: CONNECTION, tool: WRITE_VENDOR_TOOL, input: { [REPLAY_KEY]: pendingId } }, id: REPLAY_CALL_ID }] },
        { say: "replayed" },
      ],
    }),
  );

  const clickCursor = await auditCursor();
  const { buildApprovalClickPayload } = await import("../../../packages/core/scripts/e2e/synthetic");
  const tap = await slackInteractivityPost(
    buildApprovalClickPayload({ pendingId, decision: "approve", userId: OPERATOR_ID, channelId: DM_CHANNEL_ID, messageTs: row!.messageTs ?? "", org, teamId: SLACK_TEAM_ID }),
  );
  expect(tap.status, `the Approve tap was refused at the ingress: ${tap.body}`).toBe(200);
  const wake = await waitFor(
    async () => (await rowsSinceCursor(clickCursor, ["approval.decision_wake"], { limit: 20 })).find((r) => r.detail?.id === pendingId),
    "it2388: the approval.decision_wake row for the card",
  );
  expect(wake.detail?.delivered, "the decision wake did not reach the DM seat").toBe(true);
  expect((await store.getPendingAction(org, pendingId))?.status).toBe("approved");

  const wakeStep = await waitFor(() => seatLeg.requests.find((r) => r.role === "parent" && r.stepIndex === 0), "it2388: the seat's decision-wake step");
  const wakeText = wakeStep.messages.map((m) => m.text).join("\n");
  expect(wakeText, "the decision wake does not say the write has not run").toContain("HAS NOT RUN");
  expect(wakeText, "the decision wake does not name the replay key").toContain(REPLAY_KEY);
  expect(wakeText, "the decision wake does not name the card id").toContain(pendingId);

  await waitForChildren(childLeg, { count: 1, lastStepIndex: 1, label: "it2388: the replay child's last step" });
  const replayResult = childLeg.requests.flatMap((r) => r.toolResults).find((t) => t.id === REPLAY_CALL_ID);
  expect(replayResult, "the replay call returned no result").toBeDefined();
  expect(replayResult!.isError, `the replay call errored: ${JSON.stringify(replayResult!.output).slice(0, 400)}`).toBe(false);
  expect(JSON.stringify(replayResult!.output), "the replay's result did not come from the vendor").toContain(VENDOR_BODY_MARKER);
  const sent = writeCalls(vendor);
  expect(sent.length, "🔴 the approved write did not reach the vendor exactly once").toBe(1);
  expect(sent[0]!.params["arguments"], "🔴 the vendor did not receive the card's stored input").toEqual(APPROVED_INPUT);
  expect(
    (await rowsSinceCursor(cursor, ["approval.requested"], { limit: 50 })).filter(isConnectorCard).length,
    "🔴 the replay posted a SECOND card — the S-EVE-CARD drift",
  ).toBe(1);
  expect(childLeg.requests.filter((r) => r.fault !== undefined), "a scripted request of the replay leg degraded").toEqual([]);
  expect(seatLeg.requests.filter((r) => r.fault !== undefined), "a scripted seat request of the replay leg degraded").toEqual([]);

  const spent = await store.getPendingAction(org, pendingId);
  const spentArgs = JSON.parse(spent?.argsJson ?? "{}") as Record<string, unknown>;
  expect(spent?.status, "the spent card's decision changed").toBe("approved");
  expect("input" in spentArgs, "🔴 the spent card still stores the whole input").toBe(false);
  expect(spentArgs["inputCleared"], "the spent card does not say its input was cleared").toBe(true);
  expect(spentArgs["inputPreview"], "the spent card lost its preview").toBe(frozen.inputPreview);
  expect(spentArgs["memoKind"], "the spent card lost its memo kind").toBe(frozen.memoKind);
}, 600_000);
