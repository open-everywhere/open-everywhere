import assert from "node:assert/strict";
import { createHmac, generateKeyPairSync, sign as cryptoSign, type KeyObject } from "node:crypto";
import { convertHtmlToMarkdown } from "../agent/channels/teams-html-markdown.js";
import { isTeamsAnswerActivity, parseTeamsActivity, TEAMS_HITL_DATA_KEY, teamsThreadRootActivityId } from "../agent/channels/teams-inbound.js";
import { splitTeamsMessageText, TEAMS_MESSAGE_TEXT_MAX_LENGTH } from "../agent/channels/teams-message-text.js";
import { resolveTeamsAppId, resolveTeamsAppPassword, resolveTeamsTenantId } from "../agent/channels/teams-credentials.js";
import { verifyTeamsInbound, verifyTeamsRequest, type TeamsVerifyFetch } from "../agent/channels/teams-verify.js";

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};
const eq = (a: unknown, b: unknown, label: string): void => {
  assert.deepStrictEqual(a, b, label);
  n++;
};
async function rejects(p: Promise<unknown>, label: string, expect?: (err: unknown) => boolean): Promise<void> {
  let caught: { err: unknown } | undefined;
  try {
    await p;
  } catch (err) {
    caught = { err };
  }
  ok(caught !== undefined && (expect === undefined || expect(caught.err)), `${label}${caught ? ` (threw: ${String(caught.err)})` : " (did not throw)"}`);
}
const algNotAllowed = (err: unknown): boolean => (err as { code?: unknown }).code === "ERR_JOSE_ALG_NOT_ALLOWED";

console.log("teams OE-owned eve 1.0 helpers (OPE-2700):");

const SERVICE_URL = "https://smba.trafficmanager.net/amer/";
const BOT = "28:bot-app";

function activity(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "message",
    id: "1700000000002",
    serviceUrl: SERVICE_URL,
    from: { id: "29:user", name: "Sample User", aadObjectId: "aad-user" },
    recipient: { id: BOT, name: "Helper" },
    conversation: { id: "19:chan@thread.tacv2;messageid=1700000000001", conversationType: "channel", tenantId: "tenant-a" },
    channelData: { tenant: { id: "tenant-a" }, team: { id: "19:team@thread.tacv2" }, channel: { id: "19:chan@thread.tacv2" } },
    replyToId: "1700000000001",
    text: "<p><at>Helper</at> please <b>check</b> the build</p>",
    entities: [{ type: "mention", text: "<at>Helper</at>", mentioned: { id: BOT, name: "Helper" } }],
    ...over,
  };
}

// ── parseTeamsActivity ──
{
  const parsed = parseTeamsActivity(activity());
  ok(parsed?.type === "message", "a message activity parses as a message");
  if (parsed?.type !== "message") throw new Error("unreachable");
  eq(parsed.text, "please **check** the build", "the bot mention is stripped and the HTML body becomes Markdown");
  ok(parsed.isBotMentioned, "a mention of the recipient marks the bot as mentioned");
  eq(parsed.scope, "channel", "the conversation type gives the scope");
  eq([parsed.tenantId, parsed.teamId, parsed.teamsChannelId], ["tenant-a", "19:team@thread.tacv2", "19:chan@thread.tacv2"], "tenant, team and channel come from channelData");
  eq(teamsThreadRootActivityId(parsed), "1700000000001", "a channel reply anchors on its reply root");

  const plain = parseTeamsActivity(activity({ text: "fish &amp; chips &lt;3", entities: [] }));
  eq(plain?.type === "message" ? plain.text : null, "fish & chips <3", "a plain-text body only has its entities decoded");

  const personal = parseTeamsActivity(activity({ conversation: { id: "a:1", isGroup: false }, replyToId: undefined }));
  ok(personal?.type === "message" && personal.scope === "personal", "isGroup:false with no conversation type is a personal chat");
  ok(personal?.type === "message" && teamsThreadRootActivityId(personal) === null, "a personal chat has no thread root");
  const group = parseTeamsActivity(activity({ conversation: { id: "19:g@thread.v2", isGroup: true } }));
  ok(group?.type === "message" && group.scope === "groupChat", "isGroup:true with no conversation type is a group chat");
  const unknown = parseTeamsActivity(activity({ conversation: { id: "x" } }));
  ok(unknown?.type === "message" && unknown.scope === "unknown", "no type and no isGroup is the unknown scope");

  ok(parseTeamsActivity(activity({ serviceUrl: "" })) === null, "an activity with no serviceUrl does not parse");
  ok(parseTeamsActivity(activity({ from: {} })) === null, "an activity with no sender id does not parse");
  ok(parseTeamsActivity(activity({ type: "typing" })) === null, "an unsupported activity type does not parse");
  ok(parseTeamsActivity([activity()]) === null, "an array is not an activity");
  ok(parseTeamsActivity(activity({ type: "invoke", name: "" })) === null, "an invoke with no name does not parse");
  const invoke = parseTeamsActivity(activity({ type: "invoke", name: "adaptiveCard/action", value: { action: { data: {} } } }));
  ok(invoke?.type === "invoke" && invoke.name === "adaptiveCard/action", "an invoke parses with its name");
  ok(parseTeamsActivity(activity({ type: "conversationUpdate" }))?.type === "conversationUpdate", "a conversation update parses");
}

// ── isTeamsAnswerActivity ──
{
  const answer = (value: unknown, type: "message" | "invoke" = "message") =>
    parseTeamsActivity(activity({ type, name: "adaptiveCard/action", value }))!;
  eq(TEAMS_HITL_DATA_KEY, "eve_input", "the answer key is eve's card data key");
  ok(isTeamsAnswerActivity(answer({ eve_input: { requestId: "r1" } })), "a message whose value carries eve_input.requestId is an answer");
  ok(isTeamsAnswerActivity(answer({ action: { data: { eve_input: { requestId: "r1" } } } }, "invoke")), "an invoke whose action data carries eve_input.requestId is an answer");
  ok(isTeamsAnswerActivity(answer({ action: { data: { eve_input: { requestId: "r1" } } } })), "a message whose value nests eve_input under action.data is an answer");
  ok(!isTeamsAnswerActivity(answer({ eve_input: { requestId: "" } })), "an empty requestId is not an answer");
  ok(!isTeamsAnswerActivity(answer({ eve_input: {} })), "eve_input with no requestId is not an answer");
  ok(!isTeamsAnswerActivity(answer({ oe_approval: { id: "x" } }, "invoke")), "an OE approval tap is not an eve answer");
  ok(!isTeamsAnswerActivity(parseTeamsActivity(activity())!), "an ordinary message is not an answer");
}

// ── convertHtmlToMarkdown ──
{
  eq(convertHtmlToMarkdown("<p>one</p><p>two</p>"), "one\n\ntwo", "paragraphs become blocks");
  eq(convertHtmlToMarkdown("<ul><li>a</li><li>b</li></ul>"), "- a\n- b", "an unordered list becomes dashes");
  eq(convertHtmlToMarkdown('<ol start="3"><li>a</li><li>b</li></ol>'), "3. a\n4. b", "an ordered list keeps its start");
  eq(convertHtmlToMarkdown('<a href="https://example.test/x y">link</a>'), "[link](https://example.test/x%20y)", "a link keeps its href, escaped");
  eq(convertHtmlToMarkdown('<pre><code class="language-ts">let a = 1;</code></pre>'), "```ts\nlet a = 1;\n```", "a code block keeps its language");
  eq(convertHtmlToMarkdown("<table><tr><th>h</th></tr><tr><td>a|b</td></tr></table>"), "| h |\n| --- |\n| a\\|b |", "a table becomes a pipe table, with pipes escaped");
  eq(convertHtmlToMarkdown("<p>x&nbsp;&mdash;&#169;&#x41;</p>"), "x —©A", "named and numeric entities decode");
  eq(convertHtmlToMarkdown("<p>a<script>alert(1)</script>b</p>"), "ab", "script content is dropped");
  eq(convertHtmlToMarkdown("<blockquote><p>q</p></blockquote>"), "> q", "a blockquote is prefixed");
}

// ── splitTeamsMessageText ──
{
  eq(TEAMS_MESSAGE_TEXT_MAX_LENGTH, 81920, "the cap is eve's 80 KiB");
  eq(splitTeamsMessageText("short"), ["short"], "text that fits is one part");
  const para = "a".repeat(TEAMS_MESSAGE_TEXT_MAX_LENGTH - 10);
  const parts = splitTeamsMessageText(`${para}\n\n${"b".repeat(100)}`);
  eq(parts, [para, "b".repeat(100)], "a long text cuts on the paragraph break");
  const noBreaks = splitTeamsMessageText("c".repeat(TEAMS_MESSAGE_TEXT_MAX_LENGTH * 2 + 5));
  ok(noBreaks.length === 3 && noBreaks.every((p) => p.length <= TEAMS_MESSAGE_TEXT_MAX_LENGTH), "text with no break cuts hard at the cap");
}

// ── credentials ──
{
  const prior = { id: process.env.MICROSOFT_APP_ID, pw: process.env.MICROSOFT_APP_PASSWORD, pw2: process.env.TEAMS_APP_PASSWORD, t: process.env.MICROSOFT_TENANT_ID, t2: process.env.TEAMS_TENANT_ID };
  process.env.MICROSOFT_APP_ID = "env-app-id";
  await rejects(resolveTeamsAppId(undefined), "the app id has NO environment fallback: unset teams.appId throws even with MICROSOFT_APP_ID set");
  eq(await resolveTeamsAppId(() => "from-setting"), "from-setting", "the app id comes from the function it is given");
  delete process.env.MICROSOFT_APP_PASSWORD;
  delete process.env.TEAMS_APP_PASSWORD;
  await rejects(resolveTeamsAppPassword(), "no app password throws");
  process.env.TEAMS_APP_PASSWORD = "pw-b";
  eq(await resolveTeamsAppPassword(), "pw-b", "TEAMS_APP_PASSWORD is the fallback");
  process.env.MICROSOFT_APP_PASSWORD = "pw-a";
  eq(await resolveTeamsAppPassword(), "pw-a", "MICROSOFT_APP_PASSWORD wins");
  delete process.env.MICROSOFT_TENANT_ID;
  delete process.env.TEAMS_TENANT_ID;
  eq(await resolveTeamsTenantId(), undefined, "no tenant id is undefined (a multi-tenant bot)");
  process.env.TEAMS_TENANT_ID = "tenant-b";
  eq(await resolveTeamsTenantId(), "tenant-b", "TEAMS_TENANT_ID is the fallback");
  process.env.MICROSOFT_TENANT_ID = "tenant-a";
  eq(await resolveTeamsTenantId(), "tenant-a", "MICROSOFT_TENANT_ID wins");
  for (const [k, v] of Object.entries({ MICROSOFT_APP_ID: prior.id, MICROSOFT_APP_PASSWORD: prior.pw, TEAMS_APP_PASSWORD: prior.pw2, MICROSOFT_TENANT_ID: prior.t, TEAMS_TENANT_ID: prior.t2 })) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

// ── verifyTeamsRequest / verifyTeamsInbound ──
{
  const APP_ID = "00000000-aaaa-bbbb-cccc-000000000002";
  const b64url = (input: Buffer | string): string => Buffer.from(input).toString("base64url");
  const mint = (key: KeyObject, claims: Record<string, unknown>, kid = "k1", alg = "RS256"): string => {
    const header = b64url(JSON.stringify({ alg, typ: "JWT", kid }));
    const payload = b64url(JSON.stringify(claims));
    const hash = alg === "RS512" ? "RSA-SHA512" : "RSA-SHA256";
    return `${header}.${payload}.${b64url(cryptoSign(hash, Buffer.from(`${header}.${payload}`), key))}`;
  };
  const trusted = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const rogue = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...(trusted.publicKey.export({ format: "jwk" }) as Record<string, unknown>), kid: "k1", use: "sig" };
  const fetch: TeamsVerifyFetch = async (url) => {
    if (url.includes("openidconfiguration")) return new Response(JSON.stringify({ jwks_uri: "https://login.botframework.test/keys" }));
    if (url.endsWith("/keys")) return new Response(JSON.stringify({ keys: [jwk] }));
    return new Response("nf", { status: 404 });
  };
  const now = Math.floor(Date.now() / 1000);
  const claims = { iss: "https://api.botframework.com", aud: APP_ID, serviceurl: SERVICE_URL, iat: now, nbf: now - 10, exp: now + 600 };
  const body = JSON.stringify(activity());
  const req = (auth: string | undefined, b = body): Request =>
    new Request("https://oe.test/eve/v1/teams", { method: "POST", headers: auth === undefined ? {} : { authorization: auth }, body: b });
  const opts = { appId: APP_ID, fetch };

  const verified = await verifyTeamsRequest(req(`Bearer ${mint(trusted.privateKey, claims)}`), opts);
  eq(verified, { body, serviceUrl: SERVICE_URL }, "a good token yields the body and the token's service URL");
  eq(await verifyTeamsInbound(req(`Bearer ${mint(trusted.privateKey, claims)}`), opts), body, "the front verifier passes a bound activity through");

  const good = mint(trusted.privateKey, claims);
  const [h, p, sig] = good.split(".");
  const flipped = `${h}.${p}.${sig!.slice(0, -2)}${sig!.endsWith("AA") ? "BB" : "AA"}`;
  await rejects(verifyTeamsRequest(req(`Bearer ${flipped}`), opts), "🔴 a token with a tampered signature is refused");
  await rejects(verifyTeamsRequest(req(`Bearer ${mint(rogue.privateKey, claims)}`), opts), "🔴 a token signed by a key outside the JWKS is refused");
  const hs = (() => {
    const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT", kid: "k1" }));
    const payload = b64url(JSON.stringify(claims));
    const secret = trusted.publicKey.export({ format: "pem", type: "spki" }).toString();
    return `${header}.${payload}.${b64url(createHmac("sha256", secret).update(`${header}.${payload}`).digest())}`;
  })();
  await rejects(verifyTeamsRequest(req(`Bearer ${hs}`), opts), "🔴 an HS256 token is refused BY THE ALGORITHM PIN: the verifier admits RS256 only", algNotAllowed);
  await rejects(
    verifyTeamsRequest(req(`Bearer ${mint(trusted.privateKey, claims, "k1", "RS512")}`), opts),
    "🔴 an RS512 token signed by the TRUSTED key is refused by the algorithm pin (RS256 only)",
    algNotAllowed,
  );
  const none = `${b64url(JSON.stringify({ alg: "none", typ: "JWT" }))}.${b64url(JSON.stringify(claims))}.`;
  await rejects(verifyTeamsRequest(req(`Bearer ${none}`), opts), "🔴 an unsigned (alg none) token is refused by the algorithm pin", algNotAllowed);
  await rejects(verifyTeamsRequest(req(undefined), opts), "a request with no bearer token is refused");
  await rejects(verifyTeamsRequest(req(`Basic ${good}`), opts), "a non-Bearer scheme is refused");
  await rejects(verifyTeamsRequest(req(`Bearer ${mint(trusted.privateKey, { ...claims, aud: "other-app" })}`), opts), "a token for another app is refused");
  await rejects(verifyTeamsRequest(req(`Bearer ${mint(trusted.privateKey, { ...claims, iss: "https://evil.test" })}`), opts), "a token from another issuer is refused");
  await rejects(verifyTeamsRequest(req(`Bearer ${mint(trusted.privateKey, { ...claims, exp: now - 3600, nbf: now - 7200, iat: now - 7200 })}`), opts), "an expired token is refused");
  await rejects(verifyTeamsRequest(req(`Bearer ${mint(trusted.privateKey, { ...claims, serviceurl: undefined })}`), opts), "a token with no serviceurl claim is refused");
  await rejects(verifyTeamsRequest(req(`Bearer ${good}`), { appId: undefined, fetch }), "no app id refuses every request (fail closed)");
  await rejects(
    verifyTeamsRequest(req(`Bearer ${mint(trusted.privateKey, { ...claims, aud: "any-other-bot" })}`), { appId: () => "", fetch }),
    "🔴 an app id that resolves to an empty string refuses every request (jose would skip the audience check)",
  );
  await rejects(verifyTeamsRequest(req(`Bearer ${good}`), { ...opts, fetch: async () => new Response("down", { status: 503 }) }), "an unreachable key set refuses the request (fail closed)");
  await rejects(
    verifyTeamsInbound(req(`Bearer ${good}`, JSON.stringify(activity({ serviceUrl: "https://smba.trafficmanager.net/emea/" }))), opts),
    "🔴 the front verifier refuses an activity whose serviceUrl differs from the token's claim",
  );
  eq(await verifyTeamsInbound(req(`Bearer ${good}`, "not json"), opts), "not json", "a verified body that is not JSON passes through unread");
}

console.log(`  ${n} assertions passed`);

// proves: ENV-159, ENV-160, ENV-161, ENV-162
