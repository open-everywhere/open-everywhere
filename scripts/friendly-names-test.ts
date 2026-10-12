import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { generateKeyPairSync, sign } from "node:crypto";
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = join(tmpdir(), `oe-friendly-names-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");
process.env.OE_CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString("base64");

const { renderFriendlyText, rawIdLeaks } = await import("@open-everywhere/core/agent/channels/friendly-ids.js");
const { accountLinkLabel, linkMarkup, profileUrl, registerAccountDisplayName } = await import("@open-everywhere/core/agent/identity/account-display-name.js");
const fo = await import("@open-everywhere/core/agent/channels/friendly-outbound.js");
const { registerPostArm, postArm } = await import("@open-everywhere/core/agent/channels/post-arms.js");
const { registerSurfaceMessageOps, surfaceMessageOps } = await import("@open-everywhere/core/agent/channels/surface-message-ops.js");
const { callSlackWebApi } = await import("@open-everywhere/provider-slack/agent/channels/slack-web-api.js");
const { slackFriendlyNameResolver } = await import("@open-everywhere/provider-slack/agent/channels/slack-friendly-names.js");
const { discordFetch } = await import("@open-everywhere/provider-discord/agent/channels/discord-rest.js");
const { buildDiscordFrontHandler } = await import("@open-everywhere/provider-discord/agent/channels/discord-front.js");
const { friendlyLinearInit } = await import("@open-everywhere/provider-linear/agent/channels/linear-graphql.js");
const { friendlyNotionInit } = await import("@open-everywhere/provider-notion/agent/channels/notion-api.js");
const { teamsFriendlyName } = await import("@open-everywhere/provider-teams/agent/channels/teams-directory.js");
const { registerEmailTransport, emailTransport } = await import("@open-everywhere/core/agent/email/transport.js");
const lookUp = (await import("@open-everywhere/core/agent/tools/look_up.js")).default;
const { registerAccountDirectory } = await import("@open-everywhere/core/agent/identity/account-directory.js");
const { discordFriendlyNameResolver } = await import("@open-everywhere/provider-discord/agent/channels/discord-friendly-names.js");
const { teamsConnectorWrite } = await import("@open-everywhere/provider-teams/agent/channels/teams-connector.js");
const { githubWrite } = await import("@open-everywhere/provider-github/agent/channels/github-post-arm.js");
const { readChannelResult } = await import("@open-everywhere/core/agent/channels/channel-read.js");

let n = 0;
function ok(cond: unknown, msg: string): void {
  assert.ok(cond, msg);
  n++;
}
function eq<T>(a: T, b: T, msg: string): void {
  assert.deepEqual(a, b, msg);
  n++;
}
function clean(text: string, what: string, platform?: string): void {
  eq(rawIdLeaks(text, platform), [], `${what} carries no raw id or key (got ${JSON.stringify(text)})`);
}

const RAW =
  "Ask U0EXOWNER about it in C0123ABCD (slack/T0EXAMPLE/C0123ABCD, user:slack/T0EXAMPLE/U0BOB00001). " +
  "The voice channel 123456789012345678 in discord/876543210987654321/123456789012345678 is ready. " +
  "Teams: teams/tenant-1/19:abcDEF_123@thread.tacv2 and 29:1abcDEFghijKLM. " +
  "Run wrun_example79, meeting mtg_0123456789abcdef0123456789, wake-id=\"w-1\".";
ok(rawIdLeaks(RAW).length >= 10, "🔴 the fixture leaks every class of raw id before the guard (the test can fail)");

for (const platform of ["slack", "discord", "teams", "github", "linear", "notion", "email", "plain", "future-chat"]) {
  const out = renderFriendlyText(RAW, { platform });
  clean(out, `the fixture rendered for ${platform}`, platform);
  eq(renderFriendlyText(out, { platform }), out, `rendering is idempotent on ${platform}`);
}
const onSlack = renderFriendlyText(RAW, { platform: "slack" });
ok(onSlack.includes("Ask someone on Slack about it in <#C0123ABCD>"), "🔴 on Slack, an unnamed person renders as plain words, never a NEW ping; a channel renders as the native channel mention");
ok(!/<@/.test(onSlack), "…and the guard writes no `<@…>` mention anywhere: a raw id pinged nobody, and neither does its rendering");
ok(onSlack.includes("Run a session, meeting the meeting, ."), "a run id and a meeting id render as plain words, and a wake id drops out");
const onTeams = renderFriendlyText(RAW, { platform: "teams" });
ok(onTeams.includes("Ask someone on Slack about it in a Slack channel"), "off Slack, a Slack id renders as plain words, never as a mention that would print raw");
ok(onTeams.includes("Teams: a Microsoft Teams conversation and someone on Microsoft Teams."), "a Teams conversation id and a Teams person id render as plain words");
const onDiscord = renderFriendlyText(RAW, { platform: "discord" });
ok(onDiscord.includes("The voice channel something on Discord in <#123456789012345678> is ready"), "on Discord, a bare snowflake renders as words and a channel inside a Discord key as the native channel mention");
ok(onTeams.includes("The voice channel 123456789012345678 in"), "off Discord, an UNNAMED bare number stays: it may be an order number, not a Discord id");
const KEPT = [
  "See https://slack.com/archives/C0123ABCD/p1 ```log U0EXOWNER``` — slack/discord/teams parity, CUSTOMER1, 2026.",
  "See packages/providers/github/agent/channels/github-post-arm.ts and `packages/providers/github/agent/x.ts`.",
  "Edit .github/workflows/ci.yml, then /api/oauth/callback and `/api/oauth/slack/callback`.",
  "Pin github/codeql-action@v3 for the scan.",
  "Run `grep -n slack/T0EXAMPLE/C0123ABCD log.txt` to check.",
  "ASIN B0EXAMPLE86 shipped; git log E0123ABCDE; the hash is 0x12345678901234567890.",
];
const slackMentions = "Ping <@U0EXOWNER> in <#C0123ABCD>, and <!here>.";
eq(renderFriendlyText(slackMentions, { platform: "slack" }), slackMentions, "a Slack mention passes as written on Slack, where it renders as a name");
eq(renderFriendlyText(slackMentions, { platform: "teams" }), "Ping someone on Slack in a Slack channel, and <!here>.", "🔴 a Slack mention posted to TEAMS renders as words: Teams would print the id");
eq(renderFriendlyText(slackMentions, { platform: "discord" }), "Ping someone on Slack in a Slack channel, and <!here>.", "🔴 …and so does one posted to DISCORD");
eq(renderFriendlyText("ask <@123456789012345678>", { platform: "slack" }), "ask someone on Discord", "🔴 a Discord mention posted to Slack renders as words");
eq(renderFriendlyText("ask <@123456789012345678>", { platform: "discord" }), "ask <@123456789012345678>", "…and passes as written on Discord");
eq(rawIdLeaks(slackMentions, "teams"), ["U0EXOWNER", "C0123ABCD"], "the detector counts a foreign mention as a leak on the platform that would print it");
for (const text of KEPT) for (const platform of ["slack", "github", "teams"]) eq(renderFriendlyText(text, { platform }), text, `left untouched on ${platform}: ${JSON.stringify(text.slice(0, 48))}`);
for (const platform of ["slack", "teams"]) eq(renderFriendlyText("order 12345678901234567890 shipped", { platform }), "order 12345678901234567890 shipped", `a 20-digit order number stays on ${platform}`);
eq(renderFriendlyText("ask `U0EXOWNER` now", { platform: "slack" }), "ask someone on Slack now", "an id ALONE in inline code is a quoted id: it renders, and its backticks go");
eq(renderFriendlyText("pending `00000000-0000-4000-8000-000000000087` expires", { platform: "discord" }), "pending `00000000-0000-4000-8000-000000000087` expires", "an unnamed GUID in inline code keeps its backticks");
eq(renderFriendlyText("from user:email/bob@example.com", { platform: "slack" }), "from someone", "an email person key renders as words (it used to be a shape the detector caught)");
eq(renderFriendlyText("Rowan (U0EXOWNER) asked", { platform: "slack" }), "Rowan asked", "🔴 a read's `Name (id)` label echoed by the model collapses to the name — no doubled name, no ping");
const linked = "Who asked: <slack://user?team=T0EXAMPLE&id=U0EXOWNER|Rowan Hale> (rowan@example.com), and [Sam](https://discord.com/users/123456789012345678).";
eq(renderFriendlyText(linked, { platform: "slack" }), linked, "🔴 a profile link passes untouched: its id is the address, in a Slack `<slack://…|name>` or a Markdown link");
eq(rawIdLeaks(linked, "slack"), [], "…and is not a leak");
const forged = "Who asked: \u2063U0EXOWNER\u2063 and \u2063slack/T0EXAMPLE/C0123ABCD\u2063";
ok(!/U0EXOWNER|slack\/T0EXAMPLE/.test(renderFriendlyText(forged, { platform: "slack" })), "🔴 no byte sequence shields an id: the old verbatim separator is just text now");
const names = new Map([
  ["U0EXOWNER", { label: "Rowan", kind: "person" as const }],
  ["123456789012345678", { label: "#voice-lobby", kind: "channel" as const }],
  ["876543210987654321", { label: "Acme HQ", kind: "server" as const }],
  ["00000000-0000-4000-8000-000000000088", { label: "Sam Lee", kind: "person" as const }],
]);
ok(renderFriendlyText(RAW, { platform: "slack", names }).startsWith("Ask Rowan about it"), "a resolved name renders as the name");
ok(renderFriendlyText(RAW, { platform: "teams", names }).includes("The voice channel #voice-lobby in #voice-lobby is ready"), "off Discord, a NAMED Discord number renders as its #name");
eq(renderFriendlyText("on discord/876543210987654321", { platform: "discord", names }), "on Acme HQ", "a Discord server key renders as the server name");
eq(renderFriendlyText("from 00000000-0000-4000-8000-000000000088", { platform: "teams", names }), "from Sam Lee", "a GUID a resolver named renders as the name");
eq(renderFriendlyText("request 00000000-0000-4000-8000-000000000087 failed", { platform: "teams" }), "request 00000000-0000-4000-8000-000000000087 failed", "an unnamed GUID stays: it may be a request id a person needs");
eq(renderFriendlyText("ask U0EXOWNER", { platform: "slack", names: new Map([["U0EXOWNER", { label: "U0EXOWNER", kind: "person" as const }]]) }), "ask someone on Slack", "a label that only repeats the id is not a name");
const hostile = new Map([["U0EXOWNER", { label: "<!here> & *bold*", kind: "person" as const }], ["111111111111111111", { label: "@everyone **x**", kind: "person" as const }]]);
eq(renderFriendlyText("ask U0EXOWNER", { platform: "slack", names: hostile }), "ask &lt;!here&gt; &amp; *bold*", "🔴 on Slack a hostile name is escaped: no `<!here>` broadcast");
eq(renderFriendlyText("ask discord/111111111111111111", { platform: "discord", names: hostile }), "ask @​everyone \\*\\*x\\*\\*", "🔴 on Discord a hostile name cannot ping @everyone or format");

const PLATFORMS = ["slack", "discord", "teams", "github", "linear", "notion", "email", "google-chat", "future-chat"];
for (const platform of PLATFORMS) {
  const seen: string[] = [];
  registerPostArm({
    platform,
    dispatchReply: async (_t: unknown, text: string) => (seen.push(text), "m1"),
    dispatchUnified: async (_o: unknown, text: string) => (seen.push(text), "m2"),
    editMessage: async (_l: unknown, _id: string, text: string) => void seen.push(text),
    deliverDirectMessage: async (input: { text: string }) => (seen.push(input.text), { surfaceId: "d", messageId: "m3" }),
  } as never);
  const arm = postArm(platform)!;
  ok(fo.isFriendlyGuarded(arm), `🔴 the ${platform} post arm is stored guarded`);
  await arm.dispatchReply!({} as never, RAW);
  await arm.dispatchUnified!({} as never, RAW, {} as never);
  await arm.editMessage!({} as never, "m1", RAW);
  await arm.deliverDirectMessage!({ principalId: "U0BOB00001", text: RAW });
  eq(seen.length, 4, `the ${platform} arm received all four texts`);
  seen.forEach((text, i) => clean(text, `${platform} post-arm member ${i}`, platform));

  const opsSeen: string[] = [];
  registerSurfaceMessageOps({
    platform,
    postText: async (_c: string, text: string) => (opsSeen.push(text), "m4"),
    editMessage: async (_c: string, _m: string, text: string) => void opsSeen.push(text),
    postFiles: async (_c: string, files: ReadonlyArray<{ caption?: string }>, comment: string | undefined) => (opsSeen.push(comment ?? "", ...files.map((f) => f.caption ?? "")), "m5"),
  });
  const ops = surfaceMessageOps(platform)!;
  ok(fo.isFriendlyGuarded(ops), `🔴 the ${platform} message-ops arm is stored guarded`);
  await ops.postText("c", RAW);
  await ops.editMessage("c", "m", RAW);
  await ops.postFiles!("c", [{ bytes: new Uint8Array(), filename: "f", contentType: "text/plain", caption: RAW }], RAW);
  eq(opsSeen.length, 4, `the ${platform} message-ops arm received all four texts`);
  opsSeen.forEach((text, i) => clean(text, `${platform} message-ops text ${i}`, platform));
}

{
  let wire = "";
  const fetch = async (_url: string, init: RequestInit) => ((wire = String(init.body)), new Response(JSON.stringify({ ok: true, ts: "1" }), { status: 200 }));
  const blocks = [
    { type: "section", text: { type: "mrkdwn", text: RAW } },
    { type: "header", text: { type: "plain_text", text: "Card for U0EXOWNER" } },
    { type: "actions", elements: [{ type: "button", text: { type: "plain_text", text: "Approve" }, value: "approve:U0EXOWNER", action_id: "oe:C0123ABCD" }] },
  ];
  await callSlackWebApi({ botToken: "xoxb-test", operation: "chat.postMessage", body: { channel: "C0123ABCD", text: RAW, blocks: JSON.stringify(blocks) } }, { fetch });
  const form = new URLSearchParams(wire);
  clean(form.get("text")!, "the Slack message text on the wire", "slack");
  const sent = JSON.parse(form.get("blocks")!) as typeof blocks;
  clean((sent[0] as { text: { text: string } }).text.text, "a Slack mrkdwn block on the wire", "slack");
  eq((sent[1] as { text: { text: string } }).text.text, "Card for someone on Slack", "a Slack plain_text field renders no mention (it would print raw)");
  eq((sent[2] as { elements: Array<{ value: string; action_id: string }> }).elements[0]!.value, "approve:U0EXOWNER", "🔴 a button value is a routing key and is never touched");
  eq(form.get("channel"), "C0123ABCD", "🔴 the channel parameter is an address and is never touched");
  await callSlackWebApi({ botToken: "xoxb-test", operation: "users.info", body: { user: "U0EXOWNER" } }, { fetch });
  eq(new URLSearchParams(wire).get("user"), "U0EXOWNER", "a non-message method's body goes out unchanged");
}
{
  const wire: RequestInit[] = [];
  const fetch = async (_url: string, init: RequestInit) => (wire.push(init), new Response("{}", { status: 200 }));
  const card = {
    content: RAW,
    embeds: [{ title: "Join 123456789012345678?", description: RAW, fields: [{ name: "Requested by", value: "<@111111111111111111> for U0EXOWNER" }], footer: { text: "wrun_example79" } }],
    components: [{ type: 1, components: [{ type: 2, label: "Join 123456789012345678", custom_id: "oe:approve:123456789012345678" }] }],
  };
  await discordFetch("POST /channels/{id}/messages", "https://discord.com/api/v10/channels/1/messages", { method: "POST", body: JSON.stringify(card) }, { fetch });
  const sent = JSON.parse(String(wire[0]!.body)) as typeof card;
  clean(sent.content, "the Discord message content on the wire", "discord");
  clean(sent.embeds[0]!.title + sent.embeds[0]!.description + sent.embeds[0]!.fields[0]!.value + sent.embeds[0]!.footer.text, "the Discord embed on the wire", "discord");
  ok(sent.embeds[0]!.fields[0]!.value.startsWith("<@111111111111111111>"), "a mention the host wrote stays a mention");
  clean(sent.components[0]!.components[0]!.label, "a Discord button label on the wire", "discord");
  eq(sent.components[0]!.components[0]!.custom_id, "oe:approve:123456789012345678", "🔴 a custom id is a routing key and is never touched");
  const form = new FormData();
  form.append("payload_json", JSON.stringify({ content: RAW }));
  form.append("files[0]", new Blob(["x"]), "a.txt");
  await discordFetch("POST /channels/{id}/messages", "https://discord.com/api/v10/channels/1/messages", { method: "POST", body: form }, { fetch });
  const multipart = wire[1]!.body as FormData;
  clean((JSON.parse(String(multipart.get("payload_json"))) as { content: string }).content, "a Discord multipart payload_json on the wire", "discord");
  ok(multipart.get("files[0]") instanceof Blob, "the multipart file part rides along");
  await discordFetch("PATCH /webhooks/{application.id}/{interaction.token}/messages/@original", "https://discord.com/api/v10/webhooks/a/b/messages/@original", { method: "PATCH", body: JSON.stringify({ content: RAW }) }, { fetch });
  clean((JSON.parse(String(wire[2]!.body)) as { content: string }).content, "a Discord interaction follow-up edit on the wire", "discord");
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const keyHex = Buffer.from((publicKey.export({ format: "jwk" }) as { x: string }).x, "base64url").toString("hex");
  let lookups = 0;
  fo.registerFriendlyNameResolver("discord", async () => (lookups++, undefined));
  const front = buildDiscordFrontHandler((async () => new Response("inner", { status: 200 })) as never, {
    publicKey: keyHex,
    handleApprovalInteraction: async () => ({ type: 7, data: { content: RAW, components: [] } }),
  });
  const click = JSON.stringify({ type: 3, channel_id: "C1", application_id: "A", token: "fixture-token", data: { custom_id: "oe-approval:approve:x", component_type: 2 }, user: { id: "1" } });
  const ts = String(Math.floor(Date.now() / 1000));
  const res = await front(new Request("https://oe.example/eve/v1/discord", { method: "POST", headers: new Headers({ "x-signature-ed25519": sign(null, Buffer.from(ts + click), privateKey).toString("hex"), "x-signature-timestamp": ts }), body: click }), {} as never);
  const answered = JSON.parse(await res.text()) as { data: { content: string } };
  clean(answered.data.content, "🔴 the Discord interaction answer the real route returns", "discord");
  eq(lookups, 0, "…rendered with NO name lookup, so a click answer never spends Discord's three-second window on names");
  await discordFetch("PUT /channels/{id}/messages/{id}/reactions/{emoji}/@me", "https://discord.com/api/v10/x", { method: "PUT", body: JSON.stringify({ content: RAW }) }, { fetch });
  eq(JSON.parse(String(wire[3]!.body)), { content: RAW }, "a non-message operation goes out unchanged");
}
{
  const realFetch = globalThis.fetch;
  const prior = { id: process.env.MICROSOFT_APP_ID, pw: process.env.MICROSOFT_APP_PASSWORD };
  process.env.MICROSOFT_APP_ID = `friendly-names-${process.pid}`;
  process.env.MICROSOFT_APP_PASSWORD = "test";
  let wire = "";
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    if (String(input).includes("login.microsoftonline.com")) return new Response(JSON.stringify({ access_token: "t", token_type: "Bearer", expires_in: 3600 }), { status: 200 });
    wire = String(init?.body);
    return new Response(JSON.stringify({ id: "a1" }), { status: 200 });
  }) as typeof fetch;
  try {
    const activity = {
      type: "message",
      text: RAW,
      attachments: [{ contentType: "application/vnd.microsoft.card.adaptive", content: { type: "AdaptiveCard", body: [{ type: "TextBlock", text: RAW }, { type: "FactSet", facts: [{ title: "Room", value: "slack/T0EXAMPLE/C0123ABCD" }] }], actions: [{ type: "Action.Submit", title: "Approve", data: { id: "U0EXOWNER" } }] } }],
    };
    await teamsConnectorWrite({ operation: "conversations.sendToConversation", serviceUrl: "https://smba.example", path: "/v3/conversations/x/activities", body: activity });
    const sent = JSON.parse(wire) as typeof activity;
    clean(sent.text, "the Teams activity text on the wire", "teams");
    clean(sent.attachments[0]!.content.body[0]!.text!, "an Adaptive Card TextBlock on the wire", "teams");
    eq(sent.attachments[0]!.content.body[1]!.facts![0]!.value, "a Slack channel", "an Adaptive Card fact renders its key in words");
    eq(sent.attachments[0]!.content.actions[0]!.data, { id: "U0EXOWNER" }, "🔴 an action's data payload is a routing value and is never touched");
  } finally {
    globalThis.fetch = realFetch;
    if (prior.id === undefined) delete process.env.MICROSOFT_APP_ID;
    else process.env.MICROSOFT_APP_ID = prior.id;
    if (prior.pw === undefined) delete process.env.MICROSOFT_APP_PASSWORD;
    else process.env.MICROSOFT_APP_PASSWORD = prior.pw;
  }
}
{
  let wire = "";
  const fetch = async (_url: string, init: RequestInit) => ((wire = String(init.body)), new Response("{}", { status: 201 }));
  await githubWrite({ operation: "issues.createComment", method: "POST", path: "/repos/a/b/issues/1/comments", token: "t", body: { body: RAW } }, { fetch });
  clean((JSON.parse(wire) as { body: string }).body, "the GitHub comment body on the wire", "github");
  await githubWrite({ operation: "reactions.createForIssueComment", method: "POST", path: "/repos/a/b/issues/comments/1/reactions", token: "t", body: { content: "+1" } }, { fetch });
  eq(JSON.parse(wire), { content: "+1" }, "a body with no comment text goes out unchanged");
}

{
  const comment = await friendlyLinearInit({ method: "POST", body: JSON.stringify({ query: "mutation OeAmbientReply($input: CommentCreateInput!) { commentCreate(input: $input) { success } }", variables: { input: { issueId: "i1", body: RAW } } }) });
  const sent = JSON.parse(String(comment!.body)) as { variables: { input: { issueId: string; body: string } } };
  clean(sent.variables.input.body, "the Linear comment body on the wire", "linear");
  eq(sent.variables.input.issueId, "i1", "🔴 the Linear issue id is an address and is never touched");
  const activity = await friendlyLinearInit({ method: "POST", body: JSON.stringify({ query: "mutation AgentActivityCreate($input: AgentActivityCreateInput!) { agentActivityCreate(input: $input) { success } }", variables: { input: { agentSessionId: "s1", content: { type: "response", body: RAW } } } }) });
  clean((JSON.parse(String(activity!.body)) as { variables: { input: { content: { body: string } } } }).variables.input.content.body, "the Linear Agent Activity body on the wire", "linear");
  const issueRead = JSON.stringify({ query: "query OeIssue($id: String!) { issue(id: $id) { title } }", variables: { id: "U0EXOWNER-body" } });
  eq((await friendlyLinearInit({ method: "POST", body: issueRead }))!.body, issueRead, "a Linear query that is not a message goes out unchanged");
}
{
  const init = await friendlyNotionInit("https://api.notion.com/v1/comments", { method: "POST", body: JSON.stringify({ parent: { page_id: "p1" }, rich_text: [{ text: { content: RAW } }] }) });
  const sent = JSON.parse(String(init.body)) as { parent: { page_id: string }; rich_text: Array<{ text: { content: string } }> };
  clean(sent.rich_text[0]!.text.content, "the Notion comment on the wire", "notion");
  eq(sent.parent.page_id, "p1", "🔴 the Notion parent is an address and is never touched");
  const page = JSON.stringify({ properties: { title: RAW } });
  eq((await friendlyNotionInit("https://api.notion.com/v1/pages/p1", { method: "PATCH", body: page })).body, page, "a Notion write that is not a comment goes out unchanged");
}
{
  let mailed = "";
  registerEmailTransport({ id: "friendly-test", sharedDomains: [], verify: async () => ({ ok: true }), parse: () => null, reply: async (req) => ((mailed = req.text), { messageId: "m1" }) });
  const transport = emailTransport("friendly-test")!;
  ok(fo.isFriendlyGuarded(transport), "🔴 the email transport is stored guarded");
  await transport.reply({ inbox: "a@x.test", inReplyToMessageId: "m0", to: ["b@x.test"], cc: [], text: RAW });
  clean(mailed, "the email body on the wire", "email");
}

{
  const { exportPKCS8, generateKeyPair } = await import("jose");
  const { createGoogleChatMessage } = await import("@open-everywhere/provider-google-chat/agent/channels/google-chat-rest.js");
  const { resetGoogleChatTokenCache } = await import("@open-everywhere/provider-google-chat/agent/channels/google-chat-auth.js");
  const pair = await generateKeyPair("RS256", { extractable: true });
  const key = JSON.stringify({ type: "service_account", client_email: "oe-bot@proj.iam.gserviceaccount.com", private_key: await exportPKCS8(pair.privateKey as CryptoKey) });
  const sent: string[] = [];
  const fetch = (async (url: string | URL, init?: RequestInit) => {
    if (String(url).includes("oauth2.googleapis.com")) return new Response(JSON.stringify({ access_token: "ya29.test", expires_in: 3600 }), { status: 200 });
    sent.push(String(init?.body));
    return new Response(JSON.stringify({ name: "spaces/AAA/messages/m1", thread: { name: "spaces/AAA/threads/t1" } }), { status: 200 });
  }) as typeof globalThis.fetch;
  resetGoogleChatTokenCache();
  await createGoogleChatMessage({ space: "spaces/AAA", text: RAW }, { fetch, serviceAccountKey: async () => key });
  clean((JSON.parse(sent[0]!) as { text: string }).text, "the Google Chat message on the wire", "google-chat");
}

{
  const slack = slackFriendlyNameResolver({ userName: async (id) => (id === "U0EXOWNER" ? "Rowan" : undefined), channelName: async () => "launch", teamName: async () => "Acme" });
  eq(await slack("U0EXOWNER"), { label: "Rowan", kind: "person" }, "the Slack resolver names a member");
  eq(await slack("C0123ABCD"), { label: "#launch", kind: "channel" }, "the Slack resolver names a channel with its #");
  eq(await slack("T0EXAMPLE"), { label: "Acme", kind: "server" }, "the Slack resolver names the workspace");
  const asked: string[] = [];
  const discord = discordFriendlyNameResolver(async (kind, id) => {
    asked.push(`${kind}:${id}`);
    if (kind === "channels" && id === "123456789012345678") return { name: "voice-lobby", isThread: false };
    if (kind === "guilds" && id === "876543210987654321") return { name: "Acme HQ", isThread: false };
    if (kind === "users" && id === "111111111111111111") return { name: "Sam", isThread: false };
    return undefined;
  });
  eq(await discord("123456789012345678"), { label: "#voice-lobby", kind: "channel" }, "the Discord resolver names a channel");
  eq(await discord("876543210987654321"), { label: "Acme HQ", kind: "server" }, "the Discord resolver names a server");
  eq(await discord("111111111111111111"), { label: "Sam", kind: "person" }, "the Discord resolver names a person");
  eq(asked.slice(-3), ["channels:111111111111111111", "guilds:111111111111111111", "users:111111111111111111"], "it asks channel, then server, then person");

  fo.registerFriendlyNameResolver("slack", slack);
  fo.registerFriendlyNameResolver("discord", discord);
  const named = await fo.friendlyOutboundText("Ask U0EXOWNER in C0123ABCD; the call is in discord/876543210987654321/123456789012345678 on discord/876543210987654321.", "teams");
  eq(named, "Ask Rowan in #launch; the call is in #voice-lobby on Acme HQ.", "🔴 the guard says the NAMES its resolvers find (the meeting-card case: channel and server names)");
  const onDiscordNamed = await fo.friendlyOutboundText("Joined 123456789012345678 on discord/876543210987654321.", "discord");
  eq(onDiscordNamed, "Joined <#123456789012345678> on Acme HQ.", "on Discord, a named channel still renders as the native channel mention");

  fo.registerFriendlyNameResolver("slack", () => new Promise(() => {}));
  const started = Date.now();
  const hung = await fo.friendlyOutboundText("Ask U0EXOWNER.", "teams");
  const waited = Date.now() - started;
  eq(hung, "Ask someone on Slack.", "a hanging resolver costs the name, never the post");
  ok(waited < fo.NAME_BUDGET_MS + 1000, `…and holds the post no longer than the name budget (waited ${waited} ms)`);
  fo.registerFriendlyNameResolver("slack", async () => {
    throw new Error("boom");
  });
  eq(await fo.friendlyOutboundText("Ask U0EXOWNER.", "slack"), "Ask someone on Slack.", "a throwing resolver costs the name, never the post");
  fo.registerFriendlyNameResolver("slack", slack);
}

{
  const calls: string[] = [];
  const deps = {
    teams: async () => [{ serviceUrl: "https://smba.example", conversationId: "19:team@thread.tacv2", tenantId: "t1" }],
    call: async (input: { path: string }) => {
      calls.push(input.path);
      if (input.path.includes("/members/")) return { ok: true, body: { name: "Sam Lee" } };
      return { ok: true, body: { conversations: [{ id: "19:team@thread.tacv2" }, { id: "19:eng@thread.tacv2", name: "eng" }] } };
    },
  };
  eq(await teamsFriendlyName("29:1abcDEFghijKLM", deps), { label: "Sam Lee", kind: "person" }, "the Teams resolver names a person");
  eq(await teamsFriendlyName("19:eng@thread.tacv2", deps), { label: "#eng", kind: "channel" }, "the Teams resolver names a channel");
  eq(await teamsFriendlyName("19:team@thread.tacv2", deps), { label: "#General", kind: "channel" }, "…and the team's own conversation as #General");
  ok(calls.every((c) => !/POST/.test(c)), "the Teams lookups are reads");
}

{
  (await import("@open-everywhere/provider-slack/agent/register.js")).registerSlackProvider();
  fo._clearFriendlyNameCacheForTest();
  fo.registerFriendlyNameResolver("slack", slackFriendlyNameResolver({
    userName: async (id) => (id === "U0EXOWNER" ? "Rowan" : undefined),
    channelName: async (id) => (id === "C0123ABCD" ? "launch" : id === "C0SECRET01" ? "acquisition-x" : undefined),
    teamName: async () => undefined,
  }));
  const dirAsked: string[] = [];
  registerAccountDirectory("slack", async (query: string, tenant?: string) => (dirAsked.push(`${query}@${tenant}`), /bob/i.test(query) && tenant === "T0EXAMPLE" ? [{ nativeId: "U0BOB00001", name: "Bob Stone" }] : []));
  const ctx = { channel: { kind: "slack" }, session: { auth: { current: { attributes: { team_id: "T0EXAMPLE", channel_id: "C0123ABCD", trust_checked: "true" }, principalId: "U0EXOWNER", principalType: "slack-user" } } } };
  const byId = (await lookUp.execute!({ ids: ["U0EXOWNER", "slack/T0EXAMPLE/C0123ABCD", "U0NOBODY01"] }, ctx as never)) as { results: Array<Record<string, unknown>> };
  ok(byId.results[0]!.found === true && byId.results[0]!.id === "U0EXOWNER" && byId.results[0]!.mention === "<@U0EXOWNER>", "look_up names a member id, with the mention to tag them on its own platform");
  ok(String(byId.results[0]!.name).includes("Rowan") && /untrusted/i.test(String(byId.results[0]!.name)), "🔴 …and the self-set name comes back FENCED as untrusted, never bare");
  ok(String(byId.results[1]!.name).includes("#launch"), "…and a channel key");
  eq(byId.results[2]!.found, false, "…and says plainly when nothing names an id");
  const byName = (await lookUp.execute!({ name: "bob", kind: "person" }, ctx as never)) as { results: Array<Record<string, unknown>> };
  eq(byName.results[0]!.id, "U0BOB00001", "look_up finds a person's id by name through the account directory");
  eq(dirAsked.at(-1), "bob@T0EXAMPLE", "…asking with the person's words and the conversation's own workspace");
  const nobody = (await lookUp.execute!({ name: "zzz", kind: "person" }, ctx as never)) as { results: Array<Record<string, unknown>> };
  eq(nobody.results, [{ query: "zzz", found: false }], "…and finds nobody for a name the directory does not hold");
  const place = (await lookUp.execute!({ name: "launch", kind: "place" }, ctx as never)) as { results: Array<Record<string, unknown>> };
  eq(place.results[0]!.id, "C0123ABCD", "look_up finds this conversation's own room by name from the SAME cache the guard filled");
  await fo.friendlyOutboundText("Moved to C0SECRET01.", "teams");
  ok(fo.searchKnownNames("acq").some((h) => h.id === "C0SECRET01"), "control: the shared cache DOES hold the other domain's room, so the next assertion can fail");
  const leak = (await lookUp.execute!({ name: "acq", kind: "place" }, ctx as never)) as { results: Array<Record<string, unknown>> };
  eq(leak.results, [{ query: "acq", found: false }], "🔴 look_up NEVER returns a room outside this conversation's scope, though the shared cache holds it");
}

{
  const adapter = {
    platform: "slack",
    readChannel: async () => [
      { author: "U0EXOWNER", authorId: "U0EXOWNER", ts: "1.0", text: "hello" },
      { author: "U0NONAME01", authorId: "U0NONAME01", ts: "2.0", text: "hi" },
      { author: "B0BOT00001", bot: true, ts: "3.0", text: "beep" },
    ],
    readThread: async () => [],
  };
  const out = await readChannelResult({} as never, "slack", adapter as never, "C0123ABCD", 50);
  eq(out.messages.map((m: { author: string }) => m.author), ["Rowan (U0EXOWNER)", "U0NONAME01", "B0BOT00001"], "🔴 a read shows the author's name beside the id; an unnamed author and a machine line keep the id");
  fo._clearFriendlyNameCacheForTest();
  fo.registerFriendlyNameResolver("slack", async () => ({ label: "Rowan (U0ROWAN001)", kind: "person" }));
  const spoof = await readChannelResult({} as never, "slack", adapter as never, "C0123ABCD", 50);
  eq(spoof.messages[0]!.author, "U0EXOWNER", "🔴 a display name that carries an id-shaped string is dropped: nobody can name themselves into someone else's id");
}

for (const provider of readdirSync(join(ROOT, "packages/providers"))) {
  const register = join(ROOT, "packages/providers", provider, "agent/register.ts");
  let source = "";
  try {
    source = readFileSync(register, "utf8");
  } catch {
  }
  ok(/registerPostArm\(/.test(source), `the ${provider} provider registers its post arm through registerPostArm, which stores it guarded`);
}
const postArmsSource = readFileSync(join(ROOT, "packages/core/agent/channels/post-arms.ts"), "utf8");
ok(/POST_ARMS\.set\(arm\.platform, guardPostArm\(arm\)\)/.test(postArmsSource), "🔴 registerPostArm is the ONE writer of the registry, and it stores the guarded arm");
ok((postArmsSource.match(/POST_ARMS\.set\(/g) ?? []).length === 1, "…and nothing else writes the registry around the guard");

{
  const hits: string[] = [];
  const walk = (rel: string): void => {
    for (const e of readdirSync(join(ROOT, rel), { withFileTypes: true })) {
      const child = `${rel}/${e.name}`;
      if (e.isDirectory()) {
        if (e.name !== "node_modules" && e.name !== "dist" && e.name !== "generated") walk(child);
      } else if (e.name.endsWith(".ts") && /verbatimId|\\u2063/.test(readFileSync(join(ROOT, child), "utf8"))) hits.push(child);
    }
  };
  walk("packages/core/agent");
  for (const provider of readdirSync(join(ROOT, "packages/providers"))) walk(`packages/providers/${provider}/agent`);
  eq(hits, [], "🔴 no source keeps an id visible on purpose: there is no verbatim exception left");
}

{
  eq(profileUrl("discord", "123456789012345678", undefined, undefined), "https://discord.com/users/123456789012345678", "Discord: the user route");
  eq(profileUrl("slack", "U0EXOWNER", "T0EXAMPLE", undefined), "slack://user?team=T0EXAMPLE&id=U0EXOWNER", "Slack: the documented user deep link (Slack documents no web profile URL)");
  eq(profileUrl("github", "octocat", undefined, undefined), "https://github.com/octocat", "GitHub: the login's page");
  eq(profileUrl("github", "12345", undefined, undefined), undefined, "GitHub: a numeric id with no login builds no URL");
  eq(profileUrl("teams", "29:1abc", undefined, { email: "sam@contoso.com" }), "https://teams.microsoft.com/l/chat/0/0?users=sam%40contoso.com", "Teams: the chat deep link keyed by the UPN");
  eq(profileUrl("notion", "p1", undefined, { name: "Sam" }), undefined, "Notion: no profile URL, so the name stays plain");
  eq(linkMarkup("https://x.test/u", "Sam | <b>", "slack"), "<https://x.test/u|Sam b>", "Slack link syntax, with the text unable to break it");
  eq(linkMarkup("https://x.test/u", "Sam [x](y)", "discord"), "[Sam x y](https://x.test/u)", "Markdown link syntax, with the text unable to break it");
  eq(linkMarkup("https://x.test/u", "Sam", "email"), "Sam", "a surface with no link syntax shows the name");
  registerAccountDisplayName("slack", async (id: string) => (id === "U0EXOWNER" ? { name: "Rowan Hale", email: "rowan@example.com" } : undefined));
  registerAccountDisplayName("discord", async () => ({ name: "Sam", handle: "sam_s" }));
  const onSlackLabel = await accountLinkLabel({ platform: "slack", tenant: "T0EXAMPLE", nativeId: "U0EXOWNER" }, "slack");
  eq(onSlackLabel, "<slack://user?team=T0EXAMPLE&id=U0EXOWNER|Rowan Hale> (rowan@example.com)", "🔴 the name links to the account and the verified email sits beside it");
  const onDiscordLabel = await accountLinkLabel({ platform: "slack", tenant: "T0EXAMPLE", nativeId: "U0EXOWNER" }, "discord");
  eq(onDiscordLabel, "Rowan Hale (rowan@example.com)", "🔴 a `slack://` deep link is NOT emitted off Slack: Discord would print it, ids and all");
  eq(await accountLinkLabel({ platform: "discord", tenant: "", nativeId: "123456789012345678" }, "slack"), "<https://discord.com/users/123456789012345678|Sam> (@sam_s)", "a Discord account: its name, linked, and the username Discord keeps unique");
  eq(await accountLinkLabel({ platform: "linear", tenant: "", nativeId: "u1" }, "slack"), "a Linear account", "no name and no profile URL: plain words for the platform, never the id");
  eq(rawIdLeaks(onSlackLabel, "slack"), [], "an account label read on Slack carries no visible raw id");
  eq(rawIdLeaks(onDiscordLabel, "discord"), [], "🔴 …and one read on Discord carries none either (checked against the READING surface)");
  ok(!/T0EXAMPLE|U0EXOWNER/.test(onDiscordLabel), "…not even inside a link Discord cannot render");
}

rmSync(dir, { recursive: true, force: true });
console.log(`✓ friendly-names: ${n} assertions passed`);
