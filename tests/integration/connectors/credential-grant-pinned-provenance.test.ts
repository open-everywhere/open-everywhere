import { afterAll, expect, test } from "vitest";

import { deploymentOrg } from "@open-everywhere/core/agent/identity/binding.js";
import { getOperationalStore } from "@open-everywhere/core/agent/operational/provider.js";
import { encryptedKvVault } from "@open-everywhere/core/agent/credentials/kv-vault.js";
import { effectiveUserVaultSubject } from "@open-everywhere/core/agent/connections/connector-auth.js";
import { grantBorrowResourceLabel, type CredentialGrantRow } from "@open-everywhere/core/agent/operational/credential-grant-rows.js";
import { PROVENANCE_FOOTER_PREFIX } from "@open-everywhere/core/agent/channels/reply-provenance.js";

import { bootAgent, DISCORD_LISTED_CHANNEL_ID, DISCORD_USER_ID, discordMentionWake, disposeLater, registerScript, seatReply, SLACK_TEAM_ID, waitFor } from "../harness";
import { installDiscordWebApiStub } from "../discord-web-api";
import { installHostFetchStub } from "../fetch-stub";

const NOTION_OAUTH_PROVIDER_REF = "mcp.notion.com/notion-mcp";
process.env.OE_OAUTH_ENABLED = "1";
process.env.OE_OAUTH_CONFIG = JSON.stringify({ [NOTION_OAUTH_PROVIDER_REF]: { mode: "discovery-dcr-pkce", resource: "https://mcp.notion.com/mcp" } });

const DOMAIN_SCOPE_KEY = "oe-grant-domain::e2e-unified";
const OWNER_NATIVE_ID = "U0OPE2018OWNER";
const OWNER_PRINCIPAL = `slack/${SLACK_TEAM_ID}/${OWNER_NATIVE_ID}`;
const OWNER_SLUG = "ope2018owner";
const REQUESTER_PRINCIPAL = `discord/${DISCORD_USER_ID}`;
const VENDOR_TOOL = "notion-fetch";
const PINNED_PAGE_ID = "6f7ea678-0000-4000-8000-000000002018";
const ASKED_ABOUT_PAGE_ID = "6f7ea678-0000-4000-8000-000000002019";
const PINNED_LABEL = "Launch checklist";
const GRANT_TOOL_NAME = `grant__${OWNER_SLUG}_notion__notion_fetch_launch_checklist`;
const OWNER_ACCESS_TOKEN = "oe-it-ope2018-owner-notion-mcp-token";
const VENDOR_BODY_MARKER = "ope2018-pinned-page-body";
const MISATTRIBUTED_ANSWER = "That page's body says: ope2018-pinned-page-body.";

const discord = installDiscordWebApiStub({ captureMessages: true });

const cleanups: (() => void | Promise<void>)[] = [];
afterAll(async () => {
  for (const c of cleanups.reverse()) await c();
  discord.uninstall();
});

function installVendorMcpStub(): { uninstall(): void } {
  return installHostFetchStub("https://mcp.notion.com", (_url, init) => {
    const httpMethod = (init?.method ?? "GET").toUpperCase();
    if (httpMethod === "GET") return new Response(null, { status: 405 });
    if (httpMethod === "DELETE") return new Response(null, { status: 200 });
    const body = typeof init?.body === "string" ? init.body : undefined;
    if (body === undefined) return undefined;
    let rpc: { method?: unknown; params?: unknown; id?: unknown };
    try {
      rpc = JSON.parse(body) as typeof rpc;
    } catch {
      return undefined;
    }
    const json = (result: unknown, extra: Record<string, string> = {}): Response =>
      new Response(JSON.stringify({ id: rpc.id, jsonrpc: "2.0", result }), { status: 200, headers: { "content-type": "application/json", ...extra } });
    if (rpc.method === "initialize") {
      const params = (rpc.params ?? {}) as Record<string, unknown>;
      const protocolVersion = typeof params["protocolVersion"] === "string" ? params["protocolVersion"] : "2025-06-18";
      return json({ capabilities: { tools: {} }, protocolVersion, serverInfo: { name: "it-ope2018-notion-mcp", version: "1.0.0" } }, { "mcp-session-id": "it-ope2018-sess" });
    }
    if (rpc.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (rpc.method === "tools/list") {
      return json({ tools: [{ description: "Fetch one Notion page by id.", inputSchema: { properties: { id: { type: "string" } }, required: ["id"], type: "object" }, name: VENDOR_TOOL }] });
    }
    if (rpc.method === "tools/call") return json({ content: [{ text: VENDOR_BODY_MARKER, type: "text" }] });
    return undefined;
  });
}

function pinnedGrantRow(nowMs: number): CredentialGrantRow {
  return {
    askId: "ask-ope2018",
    connector: "notion",
    createdAt: new Date(nowMs - 60_000).toISOString(),
    expiresAt: new Date(nowMs + 30 * 24 * 60 * 60 * 1000).toISOString(),
    frozenArgs: { id: PINNED_PAGE_ID },
    id: "g-ope2018-pinned",
    inputSchema: { properties: { id: { const: PINNED_PAGE_ID, type: "string" } }, required: ["id"], type: "object" },
    mcpTool: VENDOR_TOOL,
    mode: "standing",
    ownerPrincipalId: OWNER_PRINCIPAL,
    ownerSlug: OWNER_SLUG,
    purpose: "read the launch checklist before the release call",
    requesterPrincipalId: REQUESTER_PRINCIPAL,
    resource: grantBorrowResourceLabel(PINNED_LABEL, VENDOR_TOOL, { id: PINNED_PAGE_ID }),
    scopeKey: DOMAIN_SCOPE_KEY,
    status: "active",
    tier: "read",
    toolName: GRANT_TOOL_NAME,
    verb: "notion_fetch",
  };
}

test("a pinned lent tool states its pin to the model, and the reply names the page it actually fetched", async () => {
  await bootAgent({ sharedSqlite: true, stubbedProviderTransport: true });
  const org = deploymentOrg();
  const store = getOperationalStore();

  const vendor = installVendorMcpStub();
  cleanups.push(() => vendor.uninstall());

  const vaultSubject = await effectiveUserVaultSubject("notion", org, "slack", SLACK_TEAM_ID, OWNER_NATIVE_ID);
  await encryptedKvVault().write(`oe-oauth:tok:${NOTION_OAUTH_PROVIDER_REF}:user:${vaultSubject}`, JSON.stringify({ accessToken: OWNER_ACCESS_TOKEN, obtainedAt: Date.now() }));

  await store.addCredentialGrant(org, pinnedGrantRow(Date.now()));
  const live = await store.liveStandingCredentialGrantsForScope(org, DOMAIN_SCOPE_KEY, new Date().toISOString());
  expect(live.map((g) => g.id), `the seeded standing grant is not live for ${DOMAIN_SCOPE_KEY} — the fixture, not the claim, is broken`).toContain("g-ope2018-pinned");

  const script = disposeLater(
    registerScript({
      parent: [
        { calls: [{ tool: GRANT_TOOL_NAME, input: { id: PINNED_PAGE_ID }, id: "ope2018-granted-call" }] },
        seatReply(MISATTRIBUTED_ANSWER, "ope2018-reply"),
        { say: "done" },
      ],
    }),
  );
  await discordMentionWake({ channelId: DISCORD_LISTED_CHANNEL_ID, text: `<@9000000000000000001> quote one full sentence from page ${ASKED_ABOUT_PAGE_ID}`, messageId: "ope2018-ask" });
  const first = await waitFor(() => script.requests.find((r) => r.role === "parent" && r.stepIndex === 0), "the standing seat's model call");
  await waitFor(() => script.requests.find((r) => r.role === "parent" && r.stepIndex === 2), "the seat's last scripted step");
  expect(script.requests.filter((r) => r.fault !== undefined), "the seat's script degraded").toEqual([]);

  const definition = first.toolDefinitions.find((d) => d.name === GRANT_TOOL_NAME);
  expect(definition, `the standing seat was never offered ${GRANT_TOOL_NAME}, so nothing here is about a lent tool`).toBeDefined();
  expect(
    definition?.description,
    "the lent tool's description does not name the page it is pinned to — the model reads a general Notion reader and calls it for whatever it is asked about",
  ).toContain(`reads exactly the Notion page "${PINNED_LABEL}"`);
  expect(
    definition?.description,
    "the lent tool's description names no other road, so a model asked about a different page has nowhere to go but this tool",
  ).toContain("Use this organisation's own Notion connector for any other Notion page");
  const offeredProps = ((definition?.inputSchema as { properties?: unknown } | undefined)?.properties ?? {}) as Record<string, { const?: unknown }>;
  expect(offeredProps["id"]?.const, "the frozen page is no longer visible and `const`-pinned in the offered schema").toBe(PINNED_PAGE_ID);

  const result = await waitFor(() => script.requests.flatMap((r) => r.toolResults).find((t) => t.id === "ope2018-granted-call"), "the granted call's result to reach the model");
  const rendered = JSON.stringify(result.output);
  expect(result.isError, `the granted call failed instead of sending: ${rendered}`).toBeFalsy();
  expect(rendered, `the granted call did not return the vendor's body: ${rendered}`).toContain(VENDOR_BODY_MARKER);

  const reply = await waitFor(
    () => discord.messages.find((m) => m.channelId === DISCORD_LISTED_CHANNEL_ID && m.content.includes(VENDOR_BODY_MARKER)),
    "the seat's answer to reach the room",
  );
  expect(
    reply.content,
    `the posted reply carries no fetched-source footer, so a misattribution in the prose is contradicted by nothing a reader can see (saw: ${JSON.stringify(reply.content.slice(0, 400))})`,
  ).toContain(`${PROVENANCE_FOOTER_PREFIX} notion (${PINNED_LABEL})`);
  expect(reply.content, "the host rewrote the model's answer instead of adding to it").toContain(MISATTRIBUTED_ANSWER);
  script.dispose();
});
