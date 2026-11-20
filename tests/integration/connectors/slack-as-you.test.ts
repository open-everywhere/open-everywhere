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
  SLACK_NAME_DROP_CHANNEL_ID,
  SLACK_TEAM_ID,
  slackDmWake,
  slackMentionWake,
  slackTs,
  waitFor,
  waitForChildren,
  workTaskIdOfCall,
  type AuditRow,
  type ScriptedHandle,
} from "../harness";
import { installHostFetchStub } from "../fetch-stub";
import { CONNECTOR_GATE_PROBE, installConnectorGateProbe, type ConnectorGateProbe } from "./connector-gate-probe";

const CONNECTION = "slack-as-you";
const OAUTH_HOME_REF = "mcp-server/slack-as-you";

const PERSON_ID = "U0IT2421PERSON";
const PILOT_GROUP = "slack-as-you-pilot";
const DM_CHANNEL_ID = "D0IT2421PERSON";
const BOT_USER_ID = "U0IT2421BOT";
const UNJOINED_CHANNEL_ID = "C0IT2421PRIVATE";

const READ_VENDOR_TOOL = "slack_read_channel";
const WRITE_VENDOR_TOOL = "slack_send_message";
const READ_TOOL = `${CONNECTION}__${READ_VENDOR_TOOL}`;
const WRITE_TOOL = `${CONNECTION}__${WRITE_VENDOR_TOOL}`;

const PERSON_TOKEN = "it-ope2421-person-xoxp-fixture";
const CHANNEL_BODY_MARKER = "it-ope2421-unjoined-channel-says-ship-friday";

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

function installSlackMcpStub(): { readonly calls: readonly { url: string; init: RequestInit | undefined }[]; uninstall(): void } {
  return installHostFetchStub("https://mcp.slack.com", (_url, init) => {
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
      return json({ capabilities: { tools: {} }, protocolVersion, serverInfo: { name: "it-ope2421-slack-mcp", version: "1.0.0" } }, { "mcp-session-id": "it-ope2421-sess" });
    }
    if (rpc.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (rpc.method === "tools/list") {
      return json({
        tools: [
          {
            description: "Read the recent messages of a channel the user can see.",
            inputSchema: { properties: { channel_id: { type: "string" } }, required: ["channel_id"], type: "object" },
            name: READ_VENDOR_TOOL,
          },
          {
            description: "Send a message as the user.",
            inputSchema: { properties: { channel_id: { type: "string" }, text: { type: "string" } }, required: ["channel_id", "text"], type: "object" },
            name: WRITE_VENDOR_TOOL,
          },
        ],
      });
    }
    if (rpc.method === "tools/call") return json({ content: [{ text: CHANNEL_BODY_MARKER, type: "text" }] });
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

function armSlackWebApi(): { readonly calls: readonly { method: string; params: URLSearchParams }[]; uninstall(): void } {
  const calls: { method: string; params: URLSearchParams }[] = [];
  const stub = installSlackWebApiStub((method, params) => {
    calls.push({ method, params });
    switch (method) {
      case "auth.test":
        return { ok: true, user_id: BOT_USER_ID, bot_id: "B0IT2421BOT", team_id: SLACK_TEAM_ID };
      case "users.info": {
        const id = params.get("user") ?? "";
        return {
          ok: true,
          user: {
            id,
            name: "it2421-person",
            team_id: SLACK_TEAM_ID,
            is_bot: false,
            is_restricted: false,
            is_ultra_restricted: false,
            is_stranger: false,
            profile: { display_name: "it2421-person", real_name: "IT 2421 Person" },
          },
        };
      }
      case "conversations.members":
        return { ok: true, members: [], response_metadata: { next_cursor: "" } };
      case "conversations.info": {
        const channel = params.get("channel");
        if (channel === DM_CHANNEL_ID) return { ok: true, channel: { id: channel, name: "it2421-dm", is_im: true, is_channel: false, is_private: true, num_members: 2 } };
        return {
          ok: true,
          channel: { id: channel, name: "it2421-control", is_channel: true, is_private: false, is_ext_shared: false, is_org_shared: false, is_shared: false, is_pending_ext_shared: false, num_members: 6 },
        };
      }
      case "conversations.open":
        return { ok: true, channel: { id: DM_CHANNEL_ID } };
      case "conversations.history":
      case "conversations.replies":
        return params.get("channel") === UNJOINED_CHANNEL_ID ? { ok: false, error: "not_in_channel" } : { ok: true, messages: [] };
      case "chat.postMessage":
        return { ok: true, channel: params.get("channel"), ts: slackTs(Date.now(), (tsCounter += 1)) };
      case "chat.update":
      case "chat.postEphemeral":
        return { ok: true };
      default:
        return undefined;
    }
  });
  return { calls, uninstall: () => stub.uninstall() };
}

async function pinShippedFixture(): Promise<void> {
  const { MCP_SERVERS } = await import("../../../agent/access/mcp-servers");
  const declared = MCP_SERVERS.find((s) => s.name === CONNECTION);
  expect(declared, "agent/access/mcp-servers.ts no longer declares slackAsYou — this file drives the shipped declaration").toBeDefined();
  expect(declared?.personalSurface?.platform, "the declared slack-as-you is not a Slack personal surface").toBe("slack");
  const { loadGroups } = await import("../../../agent/identity/groups");
  expect(
    loadGroups().find((g) => g.name === PILOT_GROUP)?.members,
    `the ${PILOT_GROUP} group no longer holds the fixture person — the DM drive would resolve no slack-as-you grant`,
  ).toContain(`slack/${SLACK_TEAM_ID}/${PERSON_ID}`);
  await import("../../../agent/tools/slack-as-you");
  const { connectorTransportSpec } = await import("@open-everywhere/core/agent/connections/connector-transport.js");
  expect(connectorTransportSpec(CONNECTION)?.directUrl ?? "", "the slack-as-you connector mount no longer dials mcp.slack.com — the stub would not be what it reaches").toBe("https://mcp.slack.com/mcp");

  const { getSettings } = await import("@open-everywhere/core/agent/settings/settings.js");
  expect(getSettings().connectors.userPrincipal, "connectors.userPrincipal resolves OFF, so no personal mint can run").toBe(true);
  expect(getSettings().connectors.opTiering, "connectors.opTiering resolves OFF, so the read/write contrast is gone").toBe(true);
  const { effectiveConnectorOpTier } = await import("@open-everywhere/core/agent/access/connector-op-gating.js");
  expect(effectiveConnectorOpTier(READ_TOOL), `${READ_TOOL} is no longer an open-tier read`).toBe("read");
  expect(effectiveConnectorOpTier(WRITE_TOOL), `${WRITE_TOOL} is no longer a gated write`).toBe("write");
}

let probe: ConnectorGateProbe | undefined;
/**
 * The gate probe: it captures the agent's own WRITE op where the DM's mount offers it (①), for the
 * channel arm (③). The write is card tier, so a call in a channel meets the approval policy: the DM
 * fence must refuse it before any card exists.
 */
function gateProbe(): ConnectorGateProbe {
  if (probe === undefined) {
    probe = installConnectorGateProbe(CONNECTION, WRITE_VENDOR_TOOL);
    const armed = probe;
    cleanups.push(() => armed.restore());
  }
  return probe;
}

function textOf(output: unknown): string {
  return typeof output === "string" ? output : JSON.stringify(output);
}

function resultOf(handle: ScriptedHandle, callId: string) {
  for (const r of handle.requests) for (const t of r.toolResults) if (t.id === callId) return t;
  return undefined;
}

function promptText(handle: ScriptedHandle): string {
  return handle.requests.flatMap((r) => r.messages.map((m) => m.text)).join("\n");
}

test("① ② a Slack DM answers about a channel the bot is not in through the person's own tool, and a write as the person raises a card", async () => {
  await bootAgent({ sharedSqlite: true });
  await pinShippedFixture();
  gateProbe();

  const slack = armSlackWebApi();
  cleanups.push(() => slack.uninstall());
  const vendor = installSlackMcpStub();
  cleanups.push(() => vendor.uninstall());

  const vaultSubject = await effectiveUserVaultSubject(CONNECTION, deploymentOrg(), "slack", SLACK_TEAM_ID, PERSON_ID);
  await encryptedKvVault().write(`oe-oauth:tok:${OAUTH_HOME_REF}:user:${vaultSubject}`, JSON.stringify({ accessToken: PERSON_TOKEN, obtainedAt: Date.now() }));

  const cursor = await auditCursor();
  const handle = disposeLater(
    registerScript({
      parent: [{ calls: [{ tool: "work", input: { message: "what does the unjoined channel say" }, id: "it2421-delegate" }] }, { say: NO_REPLY_SENTINEL }],
      child: [
        { delayMs: 120_000, calls: [{ tool: "eve__search", input: { query: `${CONNECTION}__` }, id: "it2421-search" }] },
        { calls: [{ tool: "eve__tool", input: { name: READ_TOOL, input: { channel_id: UNJOINED_CHANNEL_ID } }, id: "it2421-read" }] },
        { calls: [{ tool: "eve__tool", input: { name: WRITE_TOOL, input: { channel_id: UNJOINED_CHANNEL_ID, text: "on it" } }, id: "it2421-write" }] },
        { say: "reported" },
      ],
    }),
  );

  const ts = slackTs(Date.now(), (tsCounter += 1));
  const res = await slackDmWake({ channelId: DM_CHANNEL_ID, userId: PERSON_ID, text: "it2421 what does the planning channel say?", ts, eventId: `EvIT2421dm${ts.replace(".", "")}` });
  expect(res.status, `the DM wake POST was refused: ${res.body.slice(0, 200)}`).toBe(200);

  await waitFor(() => handle.requests.find((r) => r.role === "parent" && r.stepIndex === 1), "it2421: the DM seat's receipt step");
  await waitForChildren(handle, { count: 1, lastStepIndex: 0, label: "it2421: the worker to enter its hold" });
  const taskId = await workTaskIdOfCall(cursor, handle, "it2421-delegate", "it2421: the DM forward");
  const settlement = disposeLater(armSettlement(handle, { parent: [{ say: NO_REPLY_SENTINEL }, { say: NO_REPLY_SENTINEL }] }));
  handle.releaseHolds();
  await waitForChildren(handle, { count: 1, lastStepIndex: 3, label: "it2421: the worker's report step, after the denied write" });
  expect(handle.requests.filter((r) => r.fault !== undefined), "a scripted request degraded — the arms below would read a different run").toEqual([]);

  expect(promptText(handle), "the DM's prompt does not carry slack-as-you's bot-first copy").toContain("I can only see channels I am in. Want me to see what you see?");

  const listed = vendorRequests(vendor, "tools/list");
  expect(listed.length, "the connector mount never listed Slack's MCP ops").toBeGreaterThan(0);
  expect(authorizationOf(listed[0]!.init), "Slack's MCP server was dialled under something other than the person's own token").toContain(PERSON_TOKEN);
  const dmSearch = textOf(resultOf(handle, "it2421-search")?.output ?? "");
  for (const qualified of [READ_TOOL, WRITE_TOOL]) {
    expect(dmSearch, `control: the DM's eve__search does not offer ${qualified}: ${dmSearch.slice(0, 400)}`).toContain(qualified);
  }
  const read = resultOf(handle, "it2421-read");
  expect(read, "the personal read never returned").toBeDefined();
  expect(read!.isError, `the personal read errored: ${textOf(read!.output).slice(0, 400)}`).toBe(false);
  expect(textOf(read!.output), "the read did not carry what the unjoined channel says").toContain(CHANNEL_BODY_MARKER);
  const readCalls = vendorRequests(vendor, "tools/call").filter((c) => c.rpc.params["name"] === READ_VENDOR_TOOL);
  expect(readCalls.length, "the read did not leave the host as exactly one MCP tools/call").toBe(1);
  expect(authorizationOf(readCalls[0]!.init), "🔴 the read left under something other than the person's own token").toContain(PERSON_TOKEN);
  expect((readCalls[0]!.rpc.params["arguments"] as Record<string, unknown> | undefined)?.["channel_id"], "the read asked about some other channel").toBe(UNJOINED_CHANNEL_ID);
  expect(
    slack.calls.filter((c) => (c.method === "conversations.history" || c.method === "conversations.replies") && c.params.get("channel") === UNJOINED_CHANNEL_ID),
    "the bot's own Web API read the unjoined channel — the answer did not come through the personal tool",
  ).toEqual([]);

  const isConnectorCard = (r: AuditRow): boolean => r.detail?.kind === "op.connector";
  const outcome = await waitFor(async () => {
    const card = (await rowsSinceCursor(cursor, ["approval.requested"], { limit: 50 })).find(isConnectorCard);
    if (card !== undefined) return { card };
    const wrote = vendorRequests(vendor, "tools/call").find((c) => c.rpc.params["name"] === WRITE_VENDOR_TOOL);
    if (wrote !== undefined) return { wrote };
    return undefined;
  }, "it2421: the write's outcome — a card, or a post that reached Slack");
  expect(outcome.wrote, "🔴 a post AS THE PERSON reached Slack with no card").toBeUndefined();
  const pendingId = String(outcome.card!.detail?.id ?? "");
  const provider = await import("@open-everywhere/core/agent/operational/provider.js");
  const row = await provider.getOperationalStore().getPendingAction(deploymentOrg(), pendingId);
  expect(row?.kind, "the card's pending row is not an op.connector card").toBe("op.connector");
  expect(row?.status, "the card is not pending").toBe("pending");
  expect((JSON.parse(row!.argsJson) as { tool?: unknown }).tool, `the card does not freeze ${WRITE_TOOL}`).toBe(WRITE_TOOL);
  expect(
    (await rowsSinceCursor(cursor, ["approval.requested"], { limit: 50 })).filter(isConnectorCard).length,
    "🔴 the read was carded too — the tiering does not tell the two apart",
  ).toBe(1);
  expect(vendorRequests(vendor, "tools/call").map((c) => c.rpc.params["name"]), "🔴 the post reached Slack after its card was raised").toEqual([READ_VENDOR_TOOL]);
  const denied = resultOf(handle, "it2421-write");
  expect(JSON.stringify(denied?.output ?? ""), "the worker was not told a card is posted").toContain(`pending ${pendingId}`);

  const resultStep = await awaitWorkResult({ handle: settlement, taskId, label: "it2421: the DM seat's result-wake step" });
  expect(resultStep.fault).toBeUndefined();
}, 600_000);

test("③ a Slack CHANNEL seat never mounts slack-as-you: no grant, the DM fence refuses before any card or mint, and Slack's MCP server is never dialled", async () => {
  await bootAgent({ sharedSqlite: true });

  const { resolveAccess } = await import("@open-everywhere/core/agent/access/resolver.js");
  const { loadBundles, loadBindings } = await import("../../../agent/access/bundles");
  const { loadConnectorCredentials } = await import("../../../agent/access/connector-credentials");
  const at = (mode: "dm" | "channel" | "mpim", platform: string, channel: string, principalId = PERSON_ID, groups = [PILOT_GROUP]) =>
    resolveAccess({ mode, platform, workspace: SLACK_TEAM_ID, channel, principalId, groups }, loadBundles(), loadBindings(), {}, loadConnectorCredentials()).connectors;
  expect(at("dm", "slack", DM_CHANNEL_ID), "the shipped plane does not grant slack-as-you in a pilot member's Slack DM").toContain(CONNECTION);
  expect(at("dm", "slack", "D0IT2421OTHER", "U0IT2421OTHER", []), "🔴 the test bed grants its placeholder app to a person outside the pilot").not.toContain(CONNECTION);
  expect(at("channel", "slack", SLACK_NAME_DROP_CHANNEL_ID), "🔴 the shipped plane grants slack-as-you in a Slack CHANNEL").not.toContain(CONNECTION);
  expect(at("mpim", "slack", "G0IT2421MPIM"), "🔴 the shipped plane grants slack-as-you in a Slack group DM").not.toContain(CONNECTION);
  expect(at("dm", "discord", "D0IT2421DISCORD"), "🔴 the shipped plane grants slack-as-you in a DM on another platform").not.toContain(CONNECTION);

  const slack = armSlackWebApi();
  cleanups.push(() => slack.uninstall());
  const vendor = installSlackMcpStub();
  cleanups.push(() => vendor.uninstall());
  const vaultSubject = await effectiveUserVaultSubject(CONNECTION, deploymentOrg(), "slack", SLACK_TEAM_ID, PERSON_ID);
  await encryptedKvVault().write(`oe-oauth:tok:${OAUTH_HOME_REF}:user:${vaultSubject}`, JSON.stringify({ accessToken: PERSON_TOKEN, obtainedAt: Date.now() }));
  const dialledBefore = vendor.calls.length;
  expect(gateProbe().captured(), "the gate probe holds no slack-as-you write op: ③ needs ①'s DM step to run first in this file").toBe(true);

  const cursor = await auditCursor();
  const handle = disposeLater(
    registerScript({
      parent: [{ calls: [{ tool: "work", input: { message: "read the planning channel as me" }, id: "it2421c-delegate" }] }, { say: NO_REPLY_SENTINEL }],
      child: [
        { delayMs: 120_000, calls: [{ tool: "eve__search", input: { query: `${CONNECTION}__` }, id: "it2421c-search" }] },
        { calls: [{ tool: "eve__tool", input: { name: WRITE_TOOL, input: { channel_id: UNJOINED_CHANNEL_ID, text: "on it" } }, id: "it2421c-write" }] },
        { calls: [{ tool: CONNECTOR_GATE_PROBE, input: { channel_id: UNJOINED_CHANNEL_ID, text: "on it" }, id: "it2421c-probe" }] },
        { say: "reported" },
      ],
    }),
  );
  const ts = slackTs(Date.now(), (tsCounter += 1));
  const res = await slackMentionWake({
    channelId: SLACK_NAME_DROP_CHANNEL_ID,
    userId: PERSON_ID,
    text: `<@${BOT_USER_ID}> it2421 read the planning channel as me`,
    ts,
    eventId: `EvIT2421ch${ts.replace(".", "")}`,
  });
  expect(res.status, `the Slack front refused the channel wake: ${res.body.slice(0, 200)}`).toBe(200);

  await waitFor(() => handle.requests.find((r) => r.role === "parent" && r.stepIndex === 1), "it2421c: the channel seat's receipt step");
  await waitForChildren(handle, { count: 1, lastStepIndex: 0, label: "it2421c: the worker to enter its hold" });
  const taskId = await workTaskIdOfCall(cursor, handle, "it2421c-delegate", "it2421c: the channel forward");
  const settlement = disposeLater(armSettlement(handle, { parent: [{ say: NO_REPLY_SENTINEL }, { say: NO_REPLY_SENTINEL }] }));
  handle.releaseHolds();
  await waitForChildren(handle, { count: 1, lastStepIndex: 3, label: "it2421c: the worker's report step" });
  expect(handle.requests.filter((r) => r.fault !== undefined), "a scripted request degraded").toEqual([]);

  // On eve 1.x the DM fence refuses the mount's LISTING: a channel's catalogue holds no
  // slack-as-you op, so the model has nothing to call, and a call by name reaches no op.
  // eve offers eve__search only while the catalogue holds a deferred tool. So either the search ran
  // and shows no slack-as-you op, or the step held no eve__search: the catalogue was empty.
  const searchResult = resultOf(handle, "it2421c-search");
  expect(searchResult, "the channel's eve__search returned nothing").toBeDefined();
  const searchStep = handle.requests.find((r) => r.role === "child" && r.stepIndex === 0);
  expect(searchStep, "control: the channel worker never made its search step").toBeDefined();
  const search = textOf(searchResult!.output);
  if (searchStep!.tools.includes("eve__search")) {
    expect(searchResult!.isError, `control: the channel's eve__search failed, so the absence below reads nothing: ${search.slice(0, 400)}`).toBe(false);
  } else {
    expect(search, "control: the channel's search failed for a reason other than an empty catalogue").toContain("eve__search");
  }
  expect(searchStep!.tools.filter((t) => t.startsWith(`${CONNECTION}__`)), "🔴 the channel worker holds a slack-as-you op by name").toEqual([]);
  expect(searchStep!.tools.includes("eve__search") ? search : "", `🔴 the channel's catalogue offers a slack-as-you op: ${search.slice(0, 400)}`).not.toContain(`${CONNECTION}__`);
  const writeResult = resultOf(handle, "it2421c-write");
  expect(writeResult, "the channel write's call returned nothing").toBeDefined();
  const write = textOf(writeResult!.output);
  expect(writeResult!.isError, `🔴 the channel's call by name reached a slack-as-you op: ${write.slice(0, 400)}`).toBe(true);
  // The agent's own WRITE op, called through the probe on the channel's session: its call-time
  // checks (the approval policy, then the connector token) refuse at the DM fence before any card,
  // and write the connector.refused row below.
  const probed = resultOf(handle, "it2421c-probe");
  expect(probed, "the gate probe returned nothing").toBeDefined();
  expect(probed!.isError, `🔴 the channel's call-time checks let the write run: ${textOf(probed!.output).slice(0, 400)}`).toBe(true);
  expect(textOf(probed!.output), `the channel's call-time gate was not refused by the DM fence: ${textOf(probed!.output).slice(0, 400)}`).toContain(
    `connection "${CONNECTION}" acts as one person's own slack account, so it answers only in that person's 1:1 DM on slack`,
  );
  expect(
    (await rowsSinceCursor(cursor, ["approval.requested"], { limit: 50 })).filter((r) => r.detail?.kind === "op.connector"),
    "🔴 a channel raised an approval card for a call that can never run there",
  ).toEqual([]);
  const refusals = (await rowsSinceCursor(cursor, ["connector.refused"], { limit: 50 })).filter((r) => r.detail?.connection === CONNECTION);
  expect(refusals.some((r) => r.detail?.reason === "personal_surface" && r.detail?.mode === "channel"), "the fence's refusal left no connector.refused row").toBe(true);
  expect(
    (await rowsSinceCursor(cursor, ["connector.mint", "connector.use"], { limit: 50 })).filter((r) => r.detail?.connector === CONNECTION || r.detail?.connection === CONNECTION),
    "🔴 the channel reached slack-as-you's credential gate or mint",
  ).toEqual([]);
  expect(vendor.calls.length, "🔴 a channel turn dialled Slack's MCP server").toBe(dialledBefore);
  expect(promptText(handle), "🔴 the channel's prompt carries slack-as-you's copy").not.toContain("Want me to see what you see?");

  const resultStep = await awaitWorkResult({ handle: settlement, taskId, label: "it2421c: the channel seat's result-wake step" });
  expect(resultStep.fault).toBeUndefined();
}, 600_000);
