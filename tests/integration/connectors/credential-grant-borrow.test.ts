import { afterAll, expect, test } from "vitest";

import { deploymentOrg } from "@open-everywhere/core/agent/identity/binding.js";
import { getOperationalStore } from "@open-everywhere/core/agent/operational/provider.js";
import { encryptedKvVault } from "@open-everywhere/core/agent/credentials/kv-vault.js";
import { effectiveUserVaultSubject } from "@open-everywhere/core/agent/connections/connector-auth.js";
import { grantCardActionId } from "@open-everywhere/core/agent/access/credential-grant-card.js";
import { grantOwnerNoticeText } from "@open-everywhere/core/agent/access/credential-grant-notice.js";
import { isGrantToolName, type CredentialGrantRow } from "@open-everywhere/core/agent/operational/credential-grant-rows.js";

import {
  auditCursor,
  bootAgent,
  DISCORD_LISTED_CHANNEL_ID,
  discordMentionWake,
  disposeLater,
  installSlackWebApiStub,
  registerScript,
  rowsSinceCursor,
  setEnvForRunningAgent,
  SLACK_TEAM_ID,
  slackInteractivityPost,
  waitFor,
  type ScriptedStep,
} from "../harness";
import { installHostFetchStub } from "../fetch-stub";

const NOTION_OAUTH_PROVIDER_REF = "mcp.notion.com/notion-mcp";
process.env.OE_OAUTH_ENABLED = "1";
process.env.OE_OAUTH_CONFIG = JSON.stringify({
  [NOTION_OAUTH_PROVIDER_REF]: { mode: "discovery-dcr-pkce", resource: "https://mcp.notion.com/mcp" },
});
process.env.VERCEL_DEPLOYMENT_ID = "it-ope1136-dep-a";

const NOTION_MCP_URL = "https://mcp.notion.com/mcp";

const OWNER_NATIVE_ID = "U0BFOPE1136OWNER";
const OWNER_PRINCIPAL = `slack/${SLACK_TEAM_ID}/${OWNER_NATIVE_ID}`;
const REQUESTER_PRINCIPAL = "discord/9000000000000000042";
const VENDOR_TOOL = "notion-fetch";
const GRANTED_PAGE_ID = "6f7ea678-0000-4000-8000-000000001136";
const OTHER_PAGE_ID = "6f7ea678-0000-4000-8000-000000009999";
const OWNER_ACCESS_TOKEN = "oe-it-ope1136-owner-notion-mcp-token";
const VENDOR_BODY_MARKER = "ope1136-vendor-answered";
const OWNER_DM_CHANNEL = "D0BFOPE1136DM";

const cleanups: (() => void | Promise<void>)[] = [];
afterAll(async () => {
  for (const c of cleanups.reverse()) await c();
});

interface McpRequest {
  readonly method: string;
  readonly params: Record<string, unknown>;
}

function rpcOf(init: RequestInit | undefined): McpRequest | undefined {
  const body = init?.body;
  if (typeof body !== "string") return undefined;
  try {
    const parsed = JSON.parse(body) as { method?: unknown; params?: unknown };
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
  refuseNextCalls(n: number, retryAfter: string): void;
} {
  let refusalsLeft = 0;
  let refusalRetryAfter = "1";
  const stub = installHostFetchStub("https://mcp.notion.com", (_url, init) => {
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
      return json({ capabilities: { tools: {} }, protocolVersion, serverInfo: { name: "it-ope1136-notion-mcp", version: "1.0.0" } }, { "mcp-session-id": "it-ope1136-sess" });
    }
    if (rpc.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (rpc.method === "tools/list") {
      return json({
        tools: [
          {
            description: "Fetch one Notion page by id.",
            inputSchema: {
              properties: { id: { type: "string" }, page_size: { type: "number" } },
              required: ["id"],
              type: "object",
            },
            name: VENDOR_TOOL,
          },
          { description: "A tool this grant does not lend.", inputSchema: { type: "object" }, name: "notion-create-pages" },
        ],
      });
    }
    if (rpc.method === "tools/call") {
      if (refusalsLeft > 0) {
        refusalsLeft -= 1;
        return new Response(JSON.stringify({ message: "You have exceeded a rate limit." }), {
          status: 429,
          headers: { "content-type": "application/json", "retry-after": refusalRetryAfter },
        });
      }
      return json({ content: [{ text: VENDOR_BODY_MARKER, type: "text" }] });
    }
    return undefined;
  });
  return {
    ...stub,
    refuseNextCalls: (n: number, retryAfter: string) => {
      refusalsLeft = n;
      refusalRetryAfter = retryAfter;
    },
  };
}

function vendorRequests(
  stub: { readonly calls: readonly { url: string; init: RequestInit | undefined }[] },
  method: string,
): { url: string; init: RequestInit | undefined; rpc: McpRequest }[] {
  return stub.calls
    .map((c) => ({ ...c, rpc: rpcOf(c.init) }))
    .filter((c): c is { url: string; init: RequestInit | undefined; rpc: McpRequest } => c.rpc?.method === method);
}

async function driveTurn(input: { readonly text: string; readonly messageId: string; readonly steps: readonly ScriptedStep[] }) {
  const handle = disposeLater(registerScript({ parent: [...input.steps] }));
  await discordMentionWake({ channelId: DISCORD_LISTED_CHANNEL_ID, text: `<@9000000000000000001> ${input.text}`, messageId: input.messageId });
  const first = await waitFor(() => handle.requests.find((r) => r.role === "parent" && r.stepIndex === 0), `the "${input.text}" turn's model call`);
  if (input.steps.length > 1) {
    await waitFor(() => handle.requests.find((r) => r.role === "parent" && r.stepIndex === input.steps.length - 1), `the "${input.text}" turn's last scripted step`);
  }
  expect(handle.requests.filter((r) => r.fault !== undefined), `the "${input.text}" turn's script degraded`).toEqual([]);
  const requests = [...handle.requests];
  handle.dispose();
  return { first, requests };
}

test("a conversational seat reaches the grant ask, an owner's tap mints the borrow, and the next turn spends the OWNER's MCP token", async () => {
  await bootAgent({ sharedSqlite: true });
  const org = deploymentOrg();
  const store = getOperationalStore();
  const cursor = await auditCursor();

  const slack = installSlackWebApiStub((method, params) => {
    switch (method) {
      case "conversations.open":
        return params.get("users") === OWNER_NATIVE_ID ? { ok: true, channel: { id: OWNER_DM_CHANNEL } } : undefined;
      case "chat.postMessage":
        return { ok: true, ts: "1756779020.000100", channel: params.get("channel") };
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

  const turn1 = await driveTurn({
    text: "ope1136 turn one",
    messageId: "ope1136-t1",
    steps: [
      {
        calls: [
          {
            tool: "request_credential_grant",
            input: {
              connector: "notion",
              frozen_args: { id: GRANTED_PAGE_ID },
              owner: OWNER_PRINCIPAL,
              purpose: "read the launch checklist before the release call",
              requested_mode: "session",
              target_label: "Launch checklist",
              tool: VENDOR_TOOL,
            },
            id: "ope1136-ask",
          },
        ],
      },
      { say: "the ask went out" },
    ],
  });
  const scopeKey = turn1.first.sessionId;
  expect(typeof scopeKey, "the seat's model call reported no session id, so the grant scope cannot be named").toBe("string");
  expect(turn1.first.tools, "the conversational seat was never offered request_credential_grant, so no room can raise an ask at all").toContain(
    "request_credential_grant",
  );

  const asked = await waitFor(async () => {
    const rows = await rowsSinceCursor(cursor, ["grant.asked"]);
    return rows.length > 0 ? rows : undefined;
  }, "a grant.asked audit row");
  const askId = String((asked[0]!.detail as { askId?: unknown }).askId ?? "");
  const ask = await store.getCredentialGrantAsk(org, askId);
  expect(ask?.status, "the ask did not land pending").toBe("pending");
  expect(ask?.mcpTool, "the ask row did not record the vendor tool in the vendor's own bytes").toBe(VENDOR_TOOL);
  expect(ask?.frozenArgs, "the ask row did not freeze the page the requester named").toEqual({ id: GRANTED_PAGE_ID });
  expect(ask?.scopeKey, "the ask was scoped to a different chat than the seat that raised it").toBe(scopeKey);
  expect(ask?.ownerPrincipalId).toBe(OWNER_PRINCIPAL);
  expect(ask?.requesterPrincipalId, "the ask recorded no verified requester, or recorded a bare native id").toBe(REQUESTER_PRINCIPAL);
  const grantTool = ask?.toolName ?? "";
  expect(isGrantToolName(grantTool), `the pinned mounted name "${grantTool}" is not a legal three-segment grant name`).toBe(true);
  expect(grantTool, "the pinned name does not carry the connector in its middle segment").toContain("_notion__");

  const cardPost = slack.calls.find((c) => c.method === "chat.postMessage" && c.params.get("channel") === OWNER_DM_CHANNEL);
  expect(cardPost, "the owner was never sent a card").toBeDefined();
  expect(await store.credentialGrantsForScope(org, scopeKey!), "a pending ask minted a grant row").toHaveLength(0);

  const tap = await slackInteractivityPost({
    actions: [{ action_id: grantCardActionId(askId, "session"), type: "button" }],
    channel: { id: OWNER_DM_CHANNEL },
    team: { id: SLACK_TEAM_ID },
    type: "block_actions",
    user: { id: OWNER_NATIVE_ID },
  });
  expect(tap.status, `the owner's tap was refused at the ingress: ${tap.body}`).toBe(200);

  const granted = await waitFor(async () => {
    const rows = (await rowsSinceCursor(cursor, ["grant.granted"])).filter((r) => (r.detail as { askId?: unknown }).askId === askId);
    return rows.length > 0 ? rows : undefined;
  }, `a grant.granted audit row for ask ${askId}`);
  const grants = await store.credentialGrantsForScope(org, scopeKey!);
  expect(grants, "the owner's tap minted no grant for this chat").toHaveLength(1);
  const grant = grants[0] as CredentialGrantRow;
  expect(granted[0]!.detail?.["grantId"]).toBe(grant.id);
  expect(grant.mcpTool, "the grant row does not lend the tool the ask named").toBe(VENDOR_TOOL);
  expect(grant.toolName, "the grant mounted under a different name than the card showed the owner").toBe(grantTool);
  expect(grant.tier, "a read tool did not classify read at mint").toBe("read");
  const snapshotProps = (grant.inputSchema?.["properties"] ?? {}) as Record<string, { const?: unknown }>;
  expect(snapshotProps["page_size"], "the row pinned no vendor schema, so the approve-time catalogue read never happened").toBeDefined();
  expect(snapshotProps["id"]?.const, "the frozen page is not `const`-pinned in the snapshot the mount will offer").toBe(GRANTED_PAGE_ID);
  expect(grant.inputSchema?.["required"], "the frozen page is pinned but optional, so the model could omit it").toContain("id");
  const ownerNoticeFirstLine = grantOwnerNoticeText(grant, undefined, Date.now()).split("\n", 1)[0]!;
  const ownerNoticePosts = () =>
    slack.calls.filter(
      (call) =>
        call.method === "chat.postMessage" &&
        call.params.get("channel") === OWNER_DM_CHANNEL &&
        call.params.get("text")?.startsWith(ownerNoticeFirstLine) === true,
    );
  expect(ownerNoticePosts(), "a first-use owner notice was sent before the grant was used").toHaveLength(0);
  const listed = vendorRequests(vendor, "tools/list");
  expect(listed, "the approve path never read the owner's live catalogue").toHaveLength(1);
  expect(new Headers(listed[0]!.init?.headers ?? {}).get("authorization"), "the catalogue was read under something other than the OWNER's minted token").toBe(
    `Bearer ${OWNER_ACCESS_TOKEN}`,
  );

  expect(process.env.VERCEL_DEPLOYMENT_ID, "the runtime revision moved, so turn 2 measures the deploy path rather than the mid-session path").toBe(
    "it-ope1136-dep-a",
  );
  const beforeSpend = vendorRequests(vendor, "tools/call").length;
  const turn2 = await driveTurn({
    text: "ope1136 turn two",
    messageId: "ope1136-t2",
    steps: [
      { calls: [{ tool: grantTool, input: { id: GRANTED_PAGE_ID, page_size: 7 }, id: "ope1136-granted-call" }] },
      { say: "read the page that was lent" },
    ],
  });
  expect(turn2.first.sessionId, "turn 2 landed on a DIFFERENT session, so the mount proves nothing about the approved scope").toBe(scopeKey);

  expect(turn2.first.tools, `the seat was never offered ${grantTool} on the turn after the owner approved`).toContain(grantTool);
  const definition = turn2.first.toolDefinitions.find((d) => d.name === grantTool);
  expect(definition?.description, "the mounted description does not name the owner whose credential pays").toContain(grant.ownerSlug);
  const offeredProps = ((definition?.inputSchema as { properties?: unknown } | undefined)?.properties ?? {}) as Record<string, { const?: unknown }>;
  expect(offeredProps["id"]?.const, "the frozen page is not visible and `const`-pinned in the schema the model was offered").toBe(GRANTED_PAGE_ID);
  expect(offeredProps["page_size"], "the vendor's own free argument is missing from the offered schema").toBeDefined();

  const result = await waitFor(
    () => turn2.requests.flatMap((r) => r.toolResults).find((t) => t.id === "ope1136-granted-call"),
    "the granted call's result to reach the model",
  );
  const rendered = JSON.stringify(result.output);
  expect(result.isError, `the granted call failed instead of sending: ${rendered}`).toBeFalsy();
  expect(rendered, `the granted call did not return the vendor's body: ${rendered}`).toContain(VENDOR_BODY_MARKER);
  expect(rendered, "the granted call's result carried no owner disclosure").toContain(`acting as ${grant.ownerSlug}`);

  const spent = vendorRequests(vendor, "tools/call");
  expect(spent, "the granted call never reached the vendor").toHaveLength(beforeSpend + 1);
  const sentCall = spent[spent.length - 1]!;
  expect(sentCall.rpc.params["name"], "the vendor was asked for a different tool than the row lends").toBe(VENDOR_TOOL);
  const sentArgs = sentCall.rpc.params["arguments"] as Record<string, unknown>;
  expect(sentArgs["id"], "the frozen page did not reach the vendor").toBe(GRANTED_PAGE_ID);
  expect(sentArgs["page_size"], "the model's page_size never reached the vendor").toBe(7);
  expect(sentCall.url, "the granted call was dialled at a different path than the connection declares").toBe(NOTION_MCP_URL);
  const authHeader = new Headers(sentCall.init?.headers ?? {}).get("authorization");
  expect(authHeader, "the granted call did not carry the OWNER's minted token").toBe(`Bearer ${OWNER_ACCESS_TOKEN}`);
  expect(rendered, "the owner's token leaked into the tool result the model reads").not.toContain(OWNER_ACCESS_TOKEN);

  const used = await waitFor(async () => {
    const rows = (await rowsSinceCursor(cursor, ["grant.used"])).filter((r) => (r.detail as { grantId?: unknown }).grantId === grant.id);
    return rows.length > 0 ? rows : undefined;
  }, `a grant.used audit row for ${grant.id}`);
  const detail = used[0]!.detail ?? {};
  expect(detail["owner"]).toBe(OWNER_PRINCIPAL);
  expect(detail["requester"]).toBe(REQUESTER_PRINCIPAL);
  expect(detail["mode"]).toBe("session");
  expect(JSON.stringify(used[0]), "a credential value reached the audit chain").not.toContain(OWNER_ACCESS_TOKEN);
  const firstUseNotice = await waitFor(async () => {
    const rows = (await rowsSinceCursor(cursor, ["grant.notified"])).filter(
      (r) => (r.detail as { grantId?: unknown }).grantId === grant.id,
    );
    const posts = ownerNoticePosts();
    return rows.length > 0 && posts.length > 0 ? { posts, rows } : undefined;
  }, `the first-use owner notice and grant.notified row for ${grant.id}`);
  expect(firstUseNotice.posts, "the first grant use sent more than one owner notice").toHaveLength(1);
  expect(firstUseNotice.rows, "the first grant use wrote more than one grant.notified row").toHaveLength(1);
  const notifiedDetail = firstUseNotice.rows[0]!.detail ?? {};
  expect(notifiedDetail["outcome"]).toBe("sent");
  expect(notifiedDetail["ownerPlatform"]).toBe("slack");
  expect(notifiedDetail["owner"]).toBe(OWNER_PRINCIPAL);
  expect(notifiedDetail["requester"]).toBe(REQUESTER_PRINCIPAL);
  expect(JSON.stringify(firstUseNotice.rows[0]), "a credential value reached the owner-notice audit row").not.toContain(OWNER_ACCESS_TOKEN);
  expect((await rowsSinceCursor(cursor, ["grant.refused"])).filter((r) => (r.detail as { grantId?: unknown }).grantId === grant.id)).toEqual([]);

  expect(vendorRequests(vendor, "notifications/initialized").length, "the SDK never sent `notifications/initialized`, so it never tried to open the SSE stream").toBeGreaterThan(0);
  const vendorGets = vendor.calls.filter((c) => (c.init?.method ?? "GET").toUpperCase() === "GET");
  expect(vendorGets, "the borrow's standalone SSE stream reached the vendor — the fence is not in the SDK's request path").toEqual([]);

  const beforeFenced = vendorRequests(vendor, "tools/call").length;
  const turn3 = await driveTurn({
    text: "ope1136 turn three",
    messageId: "ope1136-t3",
    steps: [{ calls: [{ tool: grantTool, input: { id: OTHER_PAGE_ID }, id: "ope1136-off-grant-call" }] }, { say: "that was refused" }],
  });
  const offGrant = await waitFor(
    () => turn3.requests.flatMap((r) => r.toolResults).find((t) => t.id === "ope1136-off-grant-call"),
    "the off-grant call's result to reach the model",
  );
  const offRendered = JSON.stringify(offGrant.output);
  expect(offGrant.isError, `the off-grant call was not reported to the model as an error: ${offRendered}`).toBeTruthy();
  expect(offRendered, "the off-grant call was answered with the vendor's body, so nothing refused it").not.toContain(VENDOR_BODY_MARKER);
  const afterFenced = vendorRequests(vendor, "tools/call");
  expect(afterFenced, "a call for a page the grant does not lend reached the vendor").toHaveLength(beforeFenced);
  expect(
    afterFenced.some((c) => JSON.stringify(c.rpc.params["arguments"] ?? {}).includes(OTHER_PAGE_ID)),
    "the un-granted page id was sent to the vendor",
  ).toBe(false);

  setEnvForRunningAgent("VERCEL_DEPLOYMENT_ID", "it-ope1136-dep-b");
  const beforeRedeploy = vendorRequests(vendor, "tools/call").length;
  const turn4 = await driveTurn({
    text: "ope1136 turn four",
    messageId: "ope1136-t4",
    steps: [{ calls: [{ tool: grantTool, input: { id: GRANTED_PAGE_ID }, id: "ope1136-post-deploy-call" }] }, { say: "a deploy landed and the grant still works" }],
  });
  expect(turn4.first.sessionId, "turn 4 landed on a DIFFERENT session, so it says nothing about this seat's roster").toBe(scopeKey);
  expect(turn4.first.tools, `${grantTool} vanished when the runtime revision changed — a deploy must not unmount a live grant`).toContain(grantTool);
  const postDeploy = await waitFor(
    () => turn4.requests.flatMap((r) => r.toolResults).find((t) => t.id === "ope1136-post-deploy-call"),
    "the post-deploy granted call's result to reach the model",
  );
  expect(JSON.stringify(postDeploy.output), "the grant stopped working after turn 3's refusal, so that refusal spent it").toContain(VENDOR_BODY_MARKER);
  expect(vendorRequests(vendor, "tools/call"), "the post-deploy granted call never reached the vendor").toHaveLength(beforeRedeploy + 1);
  const usedTwice = await waitFor(async () => {
    const rows = (await rowsSinceCursor(cursor, ["grant.used"])).filter(
      (r) => (r.detail as { grantId?: unknown }).grantId === grant.id,
    );
    return rows.length >= 2 ? rows : undefined;
  }, `the second grant.used audit row for ${grant.id}`);
  expect(usedTwice, "the session grant was used more than twice before the retry leg").toHaveLength(2);
  expect(ownerNoticePosts(), "the second successful use sent the owner another first-use notice").toHaveLength(1);
  expect(
    (await rowsSinceCursor(cursor, ["grant.notified"])).filter(
      (r) => (r.detail as { grantId?: unknown }).grantId === grant.id,
    ),
    "the second successful use wrote another grant.notified row",
  ).toHaveLength(1);

  const beforeRateLimited = vendorRequests(vendor, "tools/call").length;
  vendor.refuseNextCalls(1, "1");
  const turn5 = await driveTurn({
    text: "ope1136 turn five",
    messageId: "ope1136-t5",
    steps: [{ calls: [{ tool: grantTool, input: { id: GRANTED_PAGE_ID }, id: "ope1338-rate-limited-call" }] }, { say: "the rate limit was waited out" }],
  });
  const rateLimited = await waitFor(
    () => turn5.requests.flatMap((r) => r.toolResults).find((t) => t.id === "ope1338-rate-limited-call"),
    "the rate-limited granted call's result to reach the model",
  );
  expect(
    rateLimited.isError,
    `a 429 the backoff should have waited out was reported to the model as an error: ${JSON.stringify(rateLimited.output)}`,
  ).toBeFalsy();
  expect(
    JSON.stringify(rateLimited.output),
    "🔴 the borrow did not survive the vendor's 429 — it still fails on the first refusal, which is what burns a once-mode grant",
  ).toContain(VENDOR_BODY_MARKER);
  expect(
    vendorRequests(vendor, "tools/call"),
    "the rate-limited call did not reach the vendor twice, so no retry was sent",
  ).toHaveLength(beforeRateLimited + 2);
});
