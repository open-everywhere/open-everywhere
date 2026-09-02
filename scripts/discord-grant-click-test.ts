import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.OE_SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "oe-discord-grant-")), "ops.sqlite3");
process.env.OE_ORG = "acme";
delete process.env.OE_PLATFORM;
delete process.env.OE_EGRESS_SPOOF;
delete process.env.DISCORD_PUBLIC_KEY;
process.env.DISCORD_BOT_TOKEN = "fixture-bot-token-not-a-secret";

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};
const eq = (a: unknown, b: unknown, label: string): void => {
  assert.deepStrictEqual(a, b, label);
  n++;
};

const { fakeMcpServer } = await import("../packages/core/scripts/_fake-mcp-server.js");
const { withPatchedFetch } = await import("../packages/core/scripts/_fetch-test-utils.js");

const MCP_URL = "https://mcp.notion.com/mcp";
const VENDOR_TOOL = "notion-fetch";
const VENDOR_SCHEMA = { properties: { id: { type: "string" } }, required: ["id"], type: "object" } as const;
const vendor = fakeMcpServer({ tools: [{ inputSchema: VENDOR_SCHEMA, name: VENDOR_TOOL }] });

const dmPosts: { channel: string; body: Record<string, unknown> }[] = [];
const cardEdits: Record<string, unknown>[] = [];

const splitFetch = (async (input: unknown, init?: { method?: string; body?: string }): Promise<unknown> => {
  const url = new URL(typeof input === "string" ? input : String((input as { href?: string }).href ?? input));
  if (url.hostname !== "discord.com") return (vendor.fetch as (u: unknown, i?: unknown) => Promise<unknown>)(input, init);
  const path = url.pathname.replace(/^\/api\/v\d+/, "");
  const method = (init?.method ?? "GET").toUpperCase();
  const res = (status: number, body: unknown): unknown => ({ ok: status >= 200 && status < 300, status, json: async () => body });
  if (path === "/users/@me/channels" && method === "POST") {
    const recipient = String((JSON.parse(init?.body ?? "{}") as { recipient_id?: unknown }).recipient_id ?? "");
    return res(200, { id: `DM_${recipient}` });
  }
  const create = /^\/channels\/([^/]+)\/messages$/.exec(path);
  if (create && method === "POST") {
    dmPosts.push({ channel: create[1] ?? "", body: JSON.parse(init?.body ?? "{}") as Record<string, unknown> });
    return res(200, { id: `msg-${dmPosts.length}` });
  }
  if (/^\/channels\/[^/]+\/messages\/[^/]+$/.test(path) && method === "PATCH") {
    cardEdits.push(JSON.parse(init?.body ?? "{}") as Record<string, unknown>);
    return res(200, {});
  }
  return res(404, {});
}) as unknown as typeof fetch;

await withPatchedFetch(splitFetch, async () => {

const { registerDiscordProvider } = await import("@open-everywhere/provider-discord/agent/register.js");
const { classifyDiscordInteraction, buildDiscordFrontHandler, PUBLIC_DISCORD_ROUTE } = await import(
  "@open-everywhere/provider-discord/agent/channels/discord-front.js"
);
const { handleDiscordGrantCardInteraction } = await import("@open-everywhere/provider-discord/agent/access/discord-grant-click.js");
const { grantCardActionId, grantCardActions, parseGrantCardActionId, expireGrantCard } = await import("@open-everywhere/core/agent/access/credential-grant-card.js");
const { askForCredentialGrant } = await import("@open-everywhere/core/agent/access/credential-grant-flow.js");
const { GRANT_CARD_CLICK_ACTION } = await import("@open-everywhere/core/agent/access/credential-grant-click.js");
const { setRegisteredConnectorCredentials, vercelConnectorHome } = await import("@open-everywhere/core/agent/access/connector-credentials.js");
const { selectConnectorTransport } = await import("@open-everywhere/core/agent/connections/connector-transport.js");
const { registerUserAuthFlow } = await import("@open-everywhere/core/agent/connections/user-auth-flow.js");
const { getOperationalStore } = await import("@open-everywhere/core/agent/operational/provider.js");
const { readAudit } = await import("@open-everywhere/core/agent/audit/audit.js");
const { deploymentOrg } = await import("@open-everywhere/core/agent/identity/binding.js");

registerDiscordProvider();

const ORG = deploymentOrg();
const OWNER_ID = "700000000000000001";
const OWNER = `discord/${OWNER_ID}`;
const STRANGER_ID = "700000000000000002";
const REQ = "discord/700000000000000009";

setRegisteredConnectorCredentials([
  {
    allows: ["user-oauth"],
    connector: "notion",
    credentials: [{ endpoints: { hosts: ["mcp.notion.com"] }, home: vercelConnectorHome("mcp.notion.com/notion-mcp"), id: "user-oauth", type: "user-oauth" }],
  },
]);
selectConnectorTransport({ connector: "notion", directUrl: MCP_URL, provider: "notion" });
registerUserAuthFlow({
  environmentClaim: async () => "test",
  isUserAuthRequired: () => false,
  mintServiceToken: async () => ({ token: "SERVICE" }),
  mintUserToken: async () => ({ token: "OWNER-TOKEN" }),
  startAuthorization: async () => ({ url: "https://connect.example/consent" }),
});

const store = getOperationalStore();

async function raise(scope: string): Promise<string> {
  const outcome = await askForCredentialGrant({
    connector: "notion",
    domainGrantsConnector: true,
    frozenArgs: { id: `page-${scope}` },
    mcpTool: VENDOR_TOOL,
    nowMs: Date.now(),
    org: ORG,
    ownerHandle: "Rowan Hale",
    ownerNativeId: OWNER_ID,
    ownerPlatform: "discord",
    ownerPrincipalId: OWNER,
    platform: "discord",
    purpose: "draft the Q3 summary",
    requestedMode: "once",
    requesterLabel: "Requesting Person",
    requesterPrincipalId: REQ,
    scopeKey: scope,
    surface: "discord/G1/C1",
    targetLabel: `Launch page ${scope}`,
    workspace: "G1",
  });
  assert.ok(outcome.sent, `the ask for ${scope} was raised`);
  return outcome.askId;
}

function clickEnvelope(customId: string, userId: string, guildId?: string): Record<string, unknown> {
  return {
    type: 3,
    channel_id: "DM_CHANNEL",
    application_id: "APP_ID",
    token: "fixture-interaction-token-not-a-secret",
    data: { custom_id: customId, component_type: 2 },
    ...(guildId === undefined ? { user: { id: userId } } : { guild_id: guildId, member: { user: { id: userId } } }),
  };
}

function ephemeralText(response: Record<string, unknown> | null, label: string): string {
  assert.ok(response !== null, `${label}: the handler claimed the click`);
  eq(response["type"], 4, `${label}: answered as a fresh message, not a card rewrite`);
  const data = response["data"] as Record<string, unknown>;
  eq(data["flags"], 64, `${label}: 🔴 EPHEMERAL — a grant answer is for the clicker alone`);
  return String(data["content"] ?? "");
}

const statusOf = async (askId: string): Promise<string | undefined> => (await store.getCredentialGrantAsk(ORG, askId))?.status;

console.log("1. the front route's classifier:");
{
  const ours = classifyDiscordInteraction(JSON.stringify(clickEnvelope("oe_grant:once:ask-1", OWNER_ID)));
  eq(ours.kind, "grant-click", "🔴 an `oe_grant:` component click is OURS — before OPE-1260 it forwarded to eve and the tap was lost");

  eq(classifyDiscordInteraction(JSON.stringify(clickEnvelope("oe-approval:r1:approve:acme", OWNER_ID))).kind, "approval-click", "…`oe-approval:` still reaches the approvals plane");
  eq(classifyDiscordInteraction(JSON.stringify(clickEnvelope("oe-link:chal-1:confirm", OWNER_ID))).kind, "link-consent-click", "…`oe-link:` still reaches the identity-consent plane");
  eq(classifyDiscordInteraction(JSON.stringify(clickEnvelope("eve_input:whatever", OWNER_ID))).kind, "forward", "🔴 …and eve's own HITL prefix still FORWARDS untouched");
  eq(classifyDiscordInteraction(JSON.stringify({ type: 2, data: { name: "ask" } })).kind, "forward", "…a slash command that is not ours still forwards");
}

console.log("2. the card's own buttons, on the wire:");
{
  dmPosts.length = 0;
  const askId = await raise("sess-buttons");
  const ask = await store.getCredentialGrantAsk(ORG, askId);
  assert.ok(ask !== null, "the ask row was written");

  eq(dmPosts.length, 1, "the card lands in the owner's own DM");
  eq(dmPosts[0]?.channel, `DM_${OWNER_ID}`, "…in the owner's OWN 1:1, never the requesting room");
  const components = dmPosts[0]?.body["components"] as { type: number; components: { custom_id: string }[] }[];
  ok(Array.isArray(components) && components.length === 1 && components[0]?.type === 1, "the buttons ride ONE ACTION_ROW");
  const ids = (components[0]?.components ?? []).map((b) => b.custom_id);
  eq(ids.length, 4, "…all four answers reach the wire");
  ok(
    ids.every((id) => classifyDiscordInteraction(JSON.stringify(clickEnvelope(id, OWNER_ID))).kind === "grant-click"),
    "🔴 …and EVERY one of them classifies as ours — the card and the route cannot drift apart",
  );
  eq(
    ids.map((id) => parseGrantCardActionId(id)?.answer),
    ["once", "session", "standing", "decline"],
    "…each id decodes to the answer its label offers",
  );
  ok(
    ids.every((id) => parseGrantCardActionId(id)?.askId === askId),
    "…and each names THIS ask, so a tap comes back carrying the request it answers",
  );
  eq(ids, grantCardActions(ask).map((a) => a.id), "…and delivery carried the renderer's ids through untouched");
}

console.log("3. the owner declines:");
{
  const askId = await raise("sess-decline");
  eq(await statusOf(askId), "pending", "the ask starts pending — without this the assertion below could pass on a row that was never open");
  const response = await handleDiscordGrantCardInteraction(clickEnvelope(grantCardActionId(askId, "decline"), OWNER_ID));
  const text = ephemeralText(response, "§3");

  eq(await statusOf(askId), "declined", "🔴 the tap really declined the ask — this is the whole ticket");
  ok(text.includes("Declined"), "…and the owner is told what they did");
  ok(!text.includes("draft the Q3 summary"), "…and the answer does not read the model-authored purpose back at them");

  const rows = (await readAudit({ org: ORG, limit: 200 })).filter((r) => r.action === GRANT_CARD_CLICK_ACTION);
  const row = rows.find((r) => (r.detail as Record<string, unknown>).askId === askId);
  assert.ok(row !== undefined, "…and one click row records the tap");
  eq((row.detail as Record<string, unknown>).outcome, "declined", "…naming the outcome");
  eq(row.platform, "discord", "…stamped on the surface it happened on");
}

console.log("4. a stranger taps the same button:");
{
  const askId = await raise("sess-stranger");
  const customId = grantCardActionId(askId, "standing");
  const strangerText = ephemeralText(await handleDiscordGrantCardInteraction(clickEnvelope(customId, STRANGER_ID)), "§4");

  eq(await statusOf(askId), "pending", "🔴 a stranger's tap wrote NOTHING — the ask is still open for its owner");
  eq((await store.credentialGrantsForScope(ORG, "sess-stranger")).length, 0, "…and minted no grant");

  const unknownText = ephemeralText(await handleDiscordGrantCardInteraction(clickEnvelope(grantCardActionId("no-such-ask-id", "once"), STRANGER_ID)), "§4 unknown");
  eq(strangerText, unknownText, "🔴 …and a live ask that is not yours reads EXACTLY like an ask that does not exist — the button is never an oracle");
}

console.log("5. the same button, tapped in a server:");
{
  const askId = await raise("sess-guild");
  const text = ephemeralText(await handleDiscordGrantCardInteraction(clickEnvelope(grantCardActionId(askId, "standing"), OWNER_ID, "G1")), "§5");

  eq(await statusOf(askId), "pending", "🔴 a guild tap wrote nothing — a grant card only ever lands in a DM, so this was never a tap on a real card");
  ok(text.includes("direct messages"), "…and the copy says where to answer instead");
  ok(text.includes("Nothing was granted"), "…and that nothing happened");
}

console.log("6. the owner approves:");
{
  const askId = await raise("sess-approve");
  const text = ephemeralText(await handleDiscordGrantCardInteraction(clickEnvelope(grantCardActionId(askId, "once"), OWNER_ID)), "§6");

  eq(await statusOf(askId), "approved", "🔴 the tap really approved the ask");
  const grants = await store.credentialGrantsForScope(ORG, "sess-approve");
  eq(grants.length, 1, "…and minted exactly one grant row for that conversation");
  eq(grants[0]?.mode, "once", "…in the mode the button named");
  eq(grants[0]?.ownerPrincipalId, OWNER, "…spending THIS owner's credential, keyed `discord/<id>` with no tenant rung");
  ok(text.includes("Approved"), "…and the owner is told what they granted");
  ok(vendor.seen.some((r) => (r.body?.["method"] as string | undefined) === "tools/list"), "…after a REAL catalogue read against the vendor");
}

console.log("7. a signed interaction over the real front route:");
{
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const keyHex = Buffer.from((publicKey.export({ format: "jwk" }) as { x: string }).x, "base64url").toString("hex");
  let forwarded = 0;
  const front = buildDiscordFrontHandler(
    (async () => {
      forwarded++;
      return new Response("inner-ok", { status: 200 });
    }) as never,
    { publicKey: keyHex },
  );
  const routeBackground: Promise<unknown>[] = [];
  const post = async (interaction: unknown, args: Record<string, unknown> = {}): Promise<{ status: number; body: string }> => {
    const body = JSON.stringify(interaction);
    const ts = String(Math.floor(Date.now() / 1000));
    const headers = new Headers({
      "x-signature-ed25519": sign(null, Buffer.from(ts + body), privateKey).toString("hex"),
      "x-signature-timestamp": ts,
    });
    const res = await front(new Request(`https://oe.example${PUBLIC_DISCORD_ROUTE}`, { method: "POST", headers, body }), args as never);
    return { status: res.status, body: await res.text() };
  };

  const askId = await raise("sess-route");
  const res = await post(clickEnvelope(grantCardActionId(askId, "decline"), OWNER_ID));
  eq(res.status, 200, "the route answered the click itself");
  eq(forwarded, 0, "🔴 …and did NOT forward it to eve — the exact leak this ticket was about");
  eq(await statusOf(askId), "declined", "🔴 …and the decision really landed, so the whole route is wired, not just the classifier");
  ok(JSON.parse(res.body).data.flags === 64, "…answered ephemerally");

  const other = await post(clickEnvelope("eve_input:something", OWNER_ID));
  eq(forwarded, 1, "…while eve's own HITL click still forwards to eve untouched");
  eq(other.body, "inner-ok", "…and gets eve's own answer");

  const deferredAsk = await raise("sess-route-defer");
  const deferred = await post(clickEnvelope(grantCardActionId(deferredAsk, "decline"), OWNER_ID), {
    waitUntil: (p: Promise<unknown>) => void routeBackground.push(p),
  });
  eq(JSON.parse(deferred.body).type, 5, "🔴 …and a grant tap over the REAL route is answered with a DEFERRED response — the route really passes its waitUntil to the door");
  eq(routeBackground.length, 1, "…handing exactly one piece of work to the route's own waitUntil");
  await Promise.all(routeBackground);
  eq(await statusOf(deferredAsk), "declined", "…and the work the route kept alive really did land");
}

console.log("8. a rewritten card:");
{
  const askId = await raise("sess-expire");
  const ask = await store.getCredentialGrantAsk(ORG, askId);
  assert.ok(ask?.cardSurfaceId !== undefined && ask.cardMessageId !== undefined, "the ask row pinned its card locus, so there is a card to rewrite");
  cardEdits.length = 0;
  eq(await expireGrantCard(ask, false), true, "the lapsed card was rewritten");

  eq(cardEdits.length, 1, "…exactly once");
  eq(cardEdits[0]?.["components"], [], "🔴 …and the rewrite STRIPS the components, so a closed card offers no button to press");
  ok(typeof cardEdits[0]?.["content"] === "string" && String(cardEdits[0]["content"]).length > 0, "…while still carrying the replacement text — the strip must not cost the reader the outcome");
}

console.log("9. a slow approve answers inside the window (OPE-1282):");
{
  const askId = await raise("sess-deferred");

  const background: Promise<unknown>[] = [];
  const edits: { content: string }[] = [];
  let resolveStarted = false;
  let responded = false;
  let respondedBeforeResolveFinished = false;

  let releaseGate = (): void => {};
  const gate = new Promise<void>((r) => {
    releaseGate = r;
  });

  const response = await handleDiscordGrantCardInteraction(clickEnvelope(grantCardActionId(askId, "once"), OWNER_ID), {
    waitUntil: (p) => {
      background.push(
        (async () => {
          resolveStarted = true;
          await gate;
          await p;
        })(),
      );
    },
    edit: async (followUp, content) => {
      eq(followUp.applicationId, "APP_ID", "§9 the follow-up is addressed to the app from the interaction's own envelope");
      ok(followUp.token.length > 0, "§9 …with the interaction's token, which is what authorises the edit (no bot token needed)");
      respondedBeforeResolveFinished = responded;
      edits.push({ content });
      return true;
    },
  });
  responded = true;

  assert.ok(response !== null, "§9 the handler claimed the click");
  eq(response["type"], 5, "🔴 §9 the interaction is answered with a DEFERRED response (type 5) — this is the whole ticket");
  eq((response["data"] as Record<string, unknown>)["flags"], 64, "🔴 §9 …and the EPHEMERAL flag rides the ACK, because Discord fixes visibility at the FIRST response — without it the eventual answer would be PUBLIC");
  ok((response["data"] as Record<string, unknown>)["content"] === undefined, "§9 …and the ack carries no text of its own; the answer arrives in the edit");
  ok(resolveStarted, "§9 the resolution really was handed to waitUntil, rather than skipped");

  eq(await statusOf(askId), "pending", "🔴 §9 the ask is STILL PENDING at the moment the interaction is answered — the owner is acked before the work runs");
  eq(edits.length, 0, "…and no follow-up has been sent yet");

  releaseGate();
  await Promise.all(background);

  eq(await statusOf(askId), "approved", "🔴 §9 …and the decision really does land afterwards — deferring must not lose the approval");
  eq((await store.credentialGrantsForScope(ORG, "sess-deferred")).length, 1, "…minting exactly one grant, as the synchronous path did");
  eq(edits.length, 1, "🔴 §9 …and the placeholder is replaced with exactly one follow-up edit");
  ok(edits[0]?.content.includes("Approved"), "…carrying core's own decision copy, so the owner is told what they granted");
  ok(respondedBeforeResolveFinished, "🔴 §9 …and that edit happened AFTER the interaction response — the ordering the three-second window requires");

  const noHostAsk = await raise("sess-no-waituntil");
  const sync = await handleDiscordGrantCardInteraction(clickEnvelope(grantCardActionId(noHostAsk, "decline"), OWNER_ID));
  eq(sync?.["type"], 4, "🔴 §9 with NO waitUntil the door answers synchronously (type 4) — never a defer it cannot follow up");
  eq(await statusOf(noHostAsk), "declined", "…and the decision still lands on that path");

  const noAddrAsk = await raise("sess-no-address");
  const envelope = clickEnvelope(grantCardActionId(noAddrAsk, "decline"), OWNER_ID);
  delete envelope["token"];
  const syncNoAddr = await handleDiscordGrantCardInteraction(envelope, { waitUntil: (p) => void background.push(p) });
  eq(syncNoAddr?.["type"], 4, "🔴 §9 …and an envelope with no interaction token answers synchronously too, rather than deferring into silence");
  eq(await statusOf(noAddrAsk), "declined", "…with the decision landing there as well");

  const guildAsk = await raise("sess-guild-defer");
  const guild = await handleDiscordGrantCardInteraction(clickEnvelope(grantCardActionId(guildAsk, "standing"), OWNER_ID, "G1"), {
    waitUntil: (p) => void background.push(p),
    edit: async () => true,
  });
  eq(guild?.["type"], 4, "🔴 §9 a guild tap is refused with an IMMEDIATE answer — an answer already known must not be deferred");
  eq(await statusOf(guildAsk), "pending", "…and still writes nothing");
}

console.log(`\n✓ discord-grant-click: ${n} assertions passed\n`);

});
