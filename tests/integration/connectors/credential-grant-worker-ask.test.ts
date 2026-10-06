import { afterAll, expect, test } from "vitest";

import { deploymentOrg } from "@open-everywhere/core/agent/identity/binding.js";
import { getOperationalStore } from "@open-everywhere/core/agent/operational/provider.js";
import { encryptedKvVault } from "@open-everywhere/core/agent/credentials/kv-vault.js";
import { effectiveUserVaultSubject } from "@open-everywhere/core/agent/connections/connector-auth.js";
import { grantCardActionId } from "@open-everywhere/core/agent/access/credential-grant-card.js";
import type { CredentialGrantRow } from "@open-everywhere/core/agent/operational/credential-grant-rows.js";

import {
  armSettlement,
  awaitWorkResult,
  workTaskIdOfCall,
  auditCursor,
  awaitWindowQuiet,
  bootAgent,
  DISCORD_LISTED_CHANNEL_ID,
  discordMentionWake,
  disposeLater,
  installSlackWebApiStub,
  registerScript,
  rowsSinceCursor,
  SLACK_TEAM_ID,
  slackInteractivityPost,
  waitFor,
  waitForChildren,
} from "../harness";
import { installHostFetchStub } from "../fetch-stub";

const NOTION_OAUTH_PROVIDER_REF = "mcp.notion.com/notion-mcp";
process.env.OE_OAUTH_ENABLED = "1";
process.env.OE_OAUTH_CONFIG = JSON.stringify({
  [NOTION_OAUTH_PROVIDER_REF]: { mode: "discovery-dcr-pkce", resource: "https://mcp.notion.com/mcp" },
});
process.env.VERCEL_DEPLOYMENT_ID = "it-ope1343-dep-a";

const OWNER_NATIVE_ID = "U0BFOPE1343OWNER";
const OWNER_PRINCIPAL = `slack/${SLACK_TEAM_ID}/${OWNER_NATIVE_ID}`;
const REQUESTER_PRINCIPAL = "discord/9000000000000000042";
const VENDOR_TOOL = "notion-fetch";
const GRANTED_PAGE_ID = "6f7ea678-0000-4000-8000-000000001343";
const OWNER_ACCESS_TOKEN = "oe-it-ope1343-owner-notion-mcp-token";
const OWNER_DM_CHANNEL = "D0BFOPE1343DM";
const PURPOSE = "read the launch checklist the delegation was told to summarise";

const cleanups: (() => void | Promise<void>)[] = [];
afterAll(async () => {
  for (const c of cleanups.reverse()) await c();
});

function installVendorMcpStub(): { readonly calls: readonly { url: string; init: RequestInit | undefined }[]; uninstall(): void } {
  return installHostFetchStub("https://mcp.notion.com", (_url, init) => {
    const httpMethod = (init?.method ?? "GET").toUpperCase();
    if (httpMethod === "GET") return new Response(null, { status: 405 });
    if (httpMethod === "DELETE") return new Response(null, { status: 200 });
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as { method?: unknown; id?: unknown }) : undefined;
    if (typeof body?.method !== "string") return undefined;
    const json = (result: unknown, extra: Record<string, string> = {}): Response =>
      new Response(JSON.stringify({ id: body.id, jsonrpc: "2.0", result }), { status: 200, headers: { "content-type": "application/json", ...extra } });
    if (body.method === "initialize") {
      return json({ capabilities: { tools: {} }, protocolVersion: "2025-06-18", serverInfo: { name: "it-ope1343-notion-mcp", version: "1.0.0" } }, { "mcp-session-id": "it-ope1343-sess" });
    }
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (body.method === "tools/list") {
      return json({
        tools: [
          { description: "Fetch one Notion page by id.", inputSchema: { properties: { id: { type: "string" }, page_size: { type: "number" } }, required: ["id"], type: "object" }, name: VENDOR_TOOL },
        ],
      });
    }
    return undefined;
  });
}

test("a delegated worker raises the grant ask, the ask is scoped to the SEAT's chat, and the owner's tap mounts the grant on that chat's WORKERS", async () => {
  await bootAgent({ sharedSqlite: true });
  const org = deploymentOrg();
  const store = getOperationalStore();
  const cursor = await auditCursor();

  const slack = installSlackWebApiStub((method, params) => {
    switch (method) {
      case "conversations.open":
        return params.get("users") === OWNER_NATIVE_ID ? { ok: true, channel: { id: OWNER_DM_CHANNEL } } : undefined;
      case "chat.postMessage":
        return { ok: true, ts: "1757290080.000100", channel: params.get("channel") };
      case "chat.update":
      case "chat.postEphemeral":
        return { ok: true };
      default:
        return undefined;
    }
  });
  cleanups.push(() => slack.uninstall());

  const vendor = installVendorMcpStub();
  cleanups.push(() => vendor.uninstall());

  const vaultSubject = await effectiveUserVaultSubject("notion", org, "slack", SLACK_TEAM_ID, OWNER_NATIVE_ID);
  await encryptedKvVault().write(
    `oe-oauth:tok:${NOTION_OAUTH_PROVIDER_REF}:user:${vaultSubject}`,
    JSON.stringify({ accessToken: OWNER_ACCESS_TOKEN, obtainedAt: Date.now() }),
  );

  const dispatched = disposeLater(
    registerScript({
      parent: [
        { calls: [{ tool: "work", input: { message: "summarise the launch checklist" }, id: "ope1343-delegate" }] },
        { say: "NO_REPLY" },
      ],
      child: [
        {
          delayMs: 120_000,
          calls: [
            {
              tool: "request_credential_grant",
              input: {
                connector: "notion",
                frozen_args: { id: GRANTED_PAGE_ID },
                owner: OWNER_PRINCIPAL,
                purpose: PURPOSE,
                requested_mode: "session",
                target_label: "Launch checklist",
                tool: VENDOR_TOOL,
              },
              id: "ope1343-worker-ask",
            },
          ],
        },
        { say: "the ask went out; nothing is granted yet" },
      ],
    }),
  );

  await discordMentionWake({ channelId: DISCORD_LISTED_CHANNEL_ID, text: "<@9000000000000000001> summarise the launch checklist", messageId: "ope1343-t1" });

  const seatCall = await waitFor(() => dispatched.requests.find((r) => r.role === "parent" && r.stepIndex === 0), "the seat's own first model call");
  const seatSessionId = String(seatCall.sessionId);
  const taskId = await workTaskIdOfCall(cursor, dispatched, "ope1343-delegate", "the turn-1 forward receipt");
  await waitFor(() => dispatched.requests.find((r) => r.role === "parent" && r.stepIndex === 1), "the turn-1 dispatch turn's last step");
  const settled1 = disposeLater(armSettlement(dispatched, { parent: [{ say: "NO_REPLY" }] }));
  dispatched.releaseHolds();
  await waitForChildren(dispatched, { count: 1, lastStepIndex: 1, label: "the delegated worker to finish its own arm" });

  const workerCall = await waitFor(() => dispatched.requests.find((r) => r.role === "child" && r.stepIndex === 0), "the worker's own first model call");
  expect(workerCall.tools, "the delegated worker was never offered request_credential_grant, so a delegation-first seat can raise no ask at all").toContain(
    "request_credential_grant",
  );
  expect(dispatched.requests.filter((r) => r.fault !== undefined), "the turn-1 script degraded").toEqual([]);
  expect(String(workerCall.sessionId), "the worker ran on the SEAT's own session, so nothing here measures a delegation").not.toBe(seatSessionId);

  const resultStep = await awaitWorkResult({ handle: settled1, taskId, label: "the seat's step that read the worker's result" });
  expect(seatCall.turnId, "the seat's request carries no eve turn id, so the turn check below is vacuous").toBeDefined();
  expect(resultStep.turnId, "the worker's result arrived in the dispatch turn — the forwarding seat's turn was held").not.toBe(seatCall.turnId);
  expect(dispatched.requests.filter((r) => r.fault !== undefined), "the turn-1 script degraded").toEqual([]);
  expect(settled1.requests.filter((r) => r.fault !== undefined), "the turn-1 result-wake script degraded").toEqual([]);
  dispatched.dispose();
  settled1.dispose();

  const asked = await waitFor(async () => {
    const rows = await rowsSinceCursor(cursor, ["grant.asked"]);
    return rows.length > 0 ? rows : undefined;
  }, "a grant.asked audit row — the worker's ask reaching the store");
  const askId = String((asked[0]!.detail as { askId?: unknown }).askId ?? "");
  const ask = await store.getCredentialGrantAsk(org, askId);
  expect(ask?.status, "the worker's ask did not land pending").toBe("pending");
  expect(ask?.scopeKey, "🔴 the worker's ask was scoped to the WORKER's own one-shot session — it ends before the owner taps, so the grant would mount into nothing").toBe(
    seatSessionId,
  );
  expect(ask?.scopeKey, "the scope key is the worker's session id — stated as its own assertion so a refactor cannot satisfy the line above by accident").not.toBe(
    String(workerCall.sessionId),
  );

  expect(ask?.requesterPrincipalId, "the worker's ask recorded no verified requester — the OPE-673 carriage did not survive the delegation hop").toBe(
    REQUESTER_PRINCIPAL,
  );
  expect(ask?.requesterTarget, "the worker's ask pinned no reply target, so the owner's answer could never be reported back to the room").toBeDefined();
  expect(String(ask?.requesterTarget), "the pinned reply target does not name the room the seat was woken in").toContain(DISCORD_LISTED_CHANNEL_ID);

  const cardPost = slack.calls.find((c) => c.method === "chat.postMessage" && c.params.get("channel") === OWNER_DM_CHANNEL);
  expect(cardPost, "the owner was never sent a card").toBeDefined();
  const cardText = String(cardPost?.params.get("text") ?? "");
  const opener = /^\*(.+?)\* asks to use your Notion account, for /.exec(cardText);
  expect(opener, `the card's first line is not the ask opener: ${cardText.slice(0, 160)}`).not.toBeNull();
  const asker = opener?.[1] ?? "";
  expect(cardText, "the card does not say who the ask is for — the worker context is missing").toContain("• Who it is for: ");
  const forLine = /• Who it is for: (.+?), in their conversation with (.+?)\.$/m.exec(cardText);
  expect(forLine, `the card carries no worker attribution block: ${cardText.slice(0, 400)}`).not.toBeNull();
  expect(forLine?.[2], "the card's opener and its attribution line name two different askers").toBe(asker);
  expect(forLine?.[1], "the attribution line names the agent as the person the ask is for").not.toBe(asker);
  expect(cardText, "the card does not state HOW the ask was raised").toContain("gave the work to a background task, and the task raised this ask");
  expect(cardText, "the card does not say what a grant actually reaches").toContain("• What a grant reaches: that conversation, never the background task.");
  expect(cardText, "the card lost the worker's stated purpose").toContain(PURPOSE);
  expect(cardText).toContain("Tap one button to answer:");

  expect(await store.credentialGrantsForScope(org, seatSessionId), "a pending ask minted a grant row").toHaveLength(0);
  const grantTool = ask?.toolName ?? "";
  expect(grantTool.length, "the ask pinned no mounted tool name, so turn 2 has nothing to look for").toBeGreaterThan(0);

  const tap = await slackInteractivityPost({
    actions: [{ action_id: grantCardActionId(askId, "session"), type: "button" }],
    channel: { id: OWNER_DM_CHANNEL },
    team: { id: SLACK_TEAM_ID },
    type: "block_actions",
    user: { id: OWNER_NATIVE_ID },
  });
  expect(tap.status, `the owner's tap was refused at the ingress: ${tap.body}`).toBe(200);

  await waitFor(async () => {
    const rows = (await rowsSinceCursor(cursor, ["grant.granted"])).filter((r) => (r.detail as { askId?: unknown }).askId === askId);
    return rows.length > 0 ? rows : undefined;
  }, `a grant.granted audit row for ask ${askId}`);
  const grants = await store.credentialGrantsForScope(org, seatSessionId);
  expect(grants, "🔴 the owner's tap minted no grant for the SEAT's chat — the worker's ask was scoped somewhere the seat cannot read").toHaveLength(1);
  const grant = grants[0] as CredentialGrantRow;
  expect(grant.toolName, "the grant mounted under a different name than the card showed the owner").toBe(grantTool);

  await awaitWindowQuiet();
  const followUp = disposeLater(
    registerScript({
      parent: [
        { calls: [{ tool: "work", input: { message: "read the launch checklist" }, id: "ope2023-delegate" }] },
        { say: "NO_REPLY" },
      ],
      child: [{ delayMs: 120_000, say: "read it" }],
    }),
  );
  await discordMentionWake({ channelId: DISCORD_LISTED_CHANNEL_ID, text: "<@9000000000000000001> anything back yet", messageId: "ope1343-t2" });
  const seatTurn2 = await waitFor(() => followUp.requests.find((r) => r.role === "parent" && r.stepIndex === 0), "the seat's follow-up model call");
  expect(seatTurn2.sessionId, "turn 2 landed on a different session, so the mount proves nothing about the approved scope").toBe(seatSessionId);
  expect(seatTurn2.tools, `🔴 the SEAT was offered ${grantTool} — a lent tool belongs on the conversation's workers, and the seat is meant to delegate to reach it`).not.toContain(
    grantTool,
  );
  expect(seatTurn2.tools, "the seat's turn-2 offer carries no `work` verb — the assertion above would then be vacuous").toContain("work");

  await waitFor(() => followUp.requests.find((r) => r.role === "parent" && r.stepIndex === 1), "the turn-2 dispatch turn's last step");
  const settled2 = disposeLater(armSettlement(followUp, { parent: [{ say: "NO_REPLY" }] }));
  followUp.releaseHolds();
  await waitForChildren(followUp, { count: 1, lastStepIndex: 0, label: "the second delegated worker to finish its own arm" });
  const workerTurn2 = await waitFor(() => followUp.requests.find((r) => r.role === "child" && r.stepIndex === 0), "the second worker's own first model call");
  expect(String(workerTurn2.sessionId), "the second worker ran on the SEAT's session, so nothing here measures a worker mount").not.toBe(seatSessionId);
  expect(workerTurn2.tools, `🔴 the conversation's own WORKER was never offered ${grantTool} — the owner approved a grant nothing in the deployment can now spend`).toContain(
    grantTool,
  );
  const taskId2 = await workTaskIdOfCall(cursor, followUp, "ope2023-delegate", "the turn-2 forward receipt");
  expect(taskId2, "turn 2's receipt names turn 1's task, so the wait below would measure turn 1").not.toBe(taskId);
  await awaitWorkResult({ handle: settled2, taskId: taskId2, label: "the turn-2 seat's step that read the worker's result" });
  expect(followUp.requests.filter((r) => r.fault !== undefined), "the turn-2 script degraded").toEqual([]);
  expect(settled2.requests.filter((r) => r.fault !== undefined), "the turn-2 result-wake script degraded").toEqual([]);
}, 360_000);
