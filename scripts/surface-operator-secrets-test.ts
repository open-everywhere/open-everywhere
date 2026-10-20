import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const tmp = mkdtempSync(join(tmpdir(), "open-everywhere-surface-secrets-"));
process.env.OE_SQLITE_PATH = join(tmp, "ops.sqlite3");
process.env.OE_OPERATIONAL_PROVIDER = "sqlite";
delete process.env.DATABASE_URL;
process.env.OE_CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString("base64");

const NAMES = [
  "SLACK_BOT_TOKEN",
  "SLACK_SIGNING_SECRET",
  "DISCORD_BOT_TOKEN",
  "OE_RELAY_SECRET",
  "GITHUB_APP_PRIVATE_KEY",
  "OE_GITHUB_APP_PRIVATE_KEY",
  "GITHUB_WEBHOOK_SECRET",
  "GITHUB_TOKEN",
  "LINEAR_AGENT_ACCESS_TOKEN",
  "LINEAR_ACCESS_TOKEN",
  "LINEAR_API_KEY",
  "LINEAR_API_TOKEN",
  "LINEAR_CLIENT_SECRET",
  "LINEAR_WEBHOOK_SECRET",
  "AI_GATEWAY_API_KEY",
  "OE_AWS_WEB_IDENTITY_TOKEN",
] as const;
for (const name of NAMES) delete process.env[name];
delete process.env.AWS_WEB_IDENTITY_TOKEN_FILE;
delete process.env.LINEAR_ORGANIZATION_ID;

const { SELECTED_PROVIDERS, SELECTED_PROVIDER_IDS } = await import("../agent/lib/providers.generated.js");
const { declareProviderSelection, operatorSecretConfigured } = await import("@open-everywhere/core/agent/adapter-api.js");
const { registerConfig } = await import("@open-everywhere/core/agent/access/config.js");
const secrets = await import("@open-everywhere/core/agent/credentials/operator-secrets.js");
const { removeTempDir } = await import("../packages/core/scripts/_temp-dir.js");

let n = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    removeTempDir(tmp);
    process.exit(1);
  }
  n++;
}

declareProviderSelection(SELECTED_PROVIDER_IDS);
for (const provider of SELECTED_PROVIDERS) provider.register();
registerConfig({ loadBundles: () => [], loadBindings: () => [], pluginRegistry: {}, skillContent: {}, loadDomains: () => [], loadSilos: () => [], domainsForSurface: () => [] });

const { slackBotToken, slackSigningSecret, resetSlackCredentialMemo } = await import("@open-everywhere/provider-slack/agent/setup/credentials.js");
const { discordBotToken, discordBotTokenForEve, discordRelaySecret } = await import("@open-everywhere/provider-discord/agent/channels/discord-credentials.js");
const { githubWebhookSecret, githubEveCredentials } = await import("@open-everywhere/provider-github/agent/channels/github-credentials.js");
const { githubEventsReach } = await import("@open-everywhere/provider-github/agent/channels/github-event-reach.js");
const { githubAppPrivateKey } = await import("@open-everywhere/core/agent/scm/config.js");
const { personalTokenValue } = await import("@open-everywhere/core/agent/scm/credential.js");
const { staticLinearToken, linearCredentialsConfigured } = await import("@open-everywhere/provider-linear/agent/channels/linear-credentials.js");
const { linearPrimaryWebhookSecret } = await import("@open-everywhere/provider-linear/agent/channels/linear-webhook-verify.js");
const { linearEventsReach } = await import("@open-everywhere/provider-linear/agent/channels/linear-event-reach.js");

const STORED: Record<string, string> = {
  SLACK_BOT_TOKEN: "stored-slack-bot",
  SLACK_SIGNING_SECRET: "stored-slack-signing",
  DISCORD_BOT_TOKEN: "stored-discord-bot",
  OE_RELAY_SECRET: "stored-relay",
  GITHUB_APP_PRIVATE_KEY: "stored-github-pem",
  GITHUB_WEBHOOK_SECRET: "stored-github-webhook",
  GITHUB_TOKEN: "stored-github-pat",
  LINEAR_ACCESS_TOKEN: "stored-linear-access",
  LINEAR_CLIENT_SECRET: "stored-linear-client",
  LINEAR_WEBHOOK_SECRET: "stored-linear-webhook",
  AI_GATEWAY_API_KEY: "stored-gateway-key",
  OE_AWS_WEB_IDENTITY_TOKEN: "stored-aws-jwt",
};
for (const [name, value] of Object.entries(STORED)) {
  await secrets.setOperatorSecret({ name, value, setBy: secrets.SET_BY_CLI });
}
const quiet = console.warn;
console.warn = () => {};

console.log("§1 every surface reads its stored secret, with no env var");
{
  ok((await slackBotToken()) === STORED.SLACK_BOT_TOKEN, "🔴 Slack: the bot token resolves from the store");
  ok((await slackSigningSecret()) === STORED.SLACK_SIGNING_SECRET, "🔴 Slack: the signing secret resolves from the store");
  ok((await discordBotToken()) === STORED.DISCORD_BOT_TOKEN, "🔴 Discord: the bot token resolves from the store");
  ok((await discordBotTokenForEve()) === STORED.DISCORD_BOT_TOKEN, "🔴 Discord: eve's credentials.botToken hand resolves from the store");
  ok((await discordRelaySecret()) === STORED.OE_RELAY_SECRET, "🔴 Discord: the relay secret resolves from the store");
  ok((await githubAppPrivateKey()) === STORED.GITHUB_APP_PRIVATE_KEY, "🔴 GitHub: the App key resolves from the store (one name for both planes)");
  ok((await githubEveCredentials.privateKey()) === STORED.GITHUB_APP_PRIVATE_KEY, "🔴 GitHub: eve's credentials.privateKey hand resolves from the store");
  ok((await githubWebhookSecret()) === STORED.GITHUB_WEBHOOK_SECRET, "🔴 GitHub: the webhook secret resolves from the store");
  ok((await githubEveCredentials.webhookSecret()) === STORED.GITHUB_WEBHOOK_SECRET, "🔴 GitHub: eve's credentials.webhookSecret hand resolves from the store");
  ok((await githubEventsReach()) === true, "GitHub: the event-reach probe sees the stored webhook secret");
  ok((await personalTokenValue()) === STORED.GITHUB_TOKEN, "🔴 GitHub: the personal access token resolves from the store");
  ok((await staticLinearToken()) === STORED.LINEAR_ACCESS_TOKEN, "🔴 Linear: the static token resolves from the store");
  ok((await linearCredentialsConfigured()) === true, "Linear: the credential census counts the stored token");
  ok((await linearPrimaryWebhookSecret()) === STORED.LINEAR_WEBHOOK_SECRET, "🔴 Linear: the primary webhook secret resolves from the store");
  ok((await linearEventsReach()) === true, "Linear: the event-reach probe sees the stored webhook secret");
  ok(await operatorSecretConfigured("AI_GATEWAY_API_KEY"), "the gateway key's presence probe sees the stored key");
}

console.log("§2 the Linear route accepts a delivery signed with the stored secret");
{
  const { signLinearWebhookBody } = await import("eve/channels/linear");
  const channel = (await import("@open-everywhere/provider-linear/agent/channels/linear.js")).default;
  const route = channel.routes.find((r) => r.transport !== "websocket" && r.method === "POST" && r.path === "/eve/v1/linear");
  ok(route !== undefined, "fixture: the provider exposes the POST /eve/v1/linear route");
  const raw = JSON.stringify({ action: "create", type: "Reaction", organizationId: "org-any", webhookTimestamp: Date.now(), data: { emoji: "eyes" } });
  const call = async (signature: string): Promise<number> => {
    const req = new Request("https://example.invalid/eve/v1/linear", { method: "POST", headers: { "linear-signature": signature, "content-type": "application/json" }, body: raw });
    const res = await (route as { handler: (r: Request, a: unknown) => Promise<Response> }).handler(req, {
      from: () => ({ send: async () => undefined }),
      waitUntil: (p: Promise<unknown>) => void Promise.resolve(p).catch(() => undefined),
      to: undefined,
    });
    return res.status;
  };
  const accepted = await call(signLinearWebhookBody(raw, STORED.LINEAR_WEBHOOK_SECRET));
  ok(accepted < 400, `🔴 a delivery signed with the STORED secret is accepted (status ${accepted}), with LINEAR_WEBHOOK_SECRET unset`);
  const refused = await call(signLinearWebhookBody(raw, "some-other-secret"));
  ok(refused === 401, `negative control: the same delivery under a wrong secret is refused 401 (got ${refused})`);
}

console.log("§2b the GitHub route accepts a delivery signed with the stored secret");
{
  const { createHmac } = await import("node:crypto");
  const channel = (await import("@open-everywhere/provider-github/agent/channels/github.js")).default;
  const route = channel.routes.find((r) => r.transport !== "websocket" && r.method === "POST" && r.path === "/eve/v1/github");
  ok(route !== undefined, "fixture: the provider exposes the POST /eve/v1/github route");
  const raw = JSON.stringify({ zen: "Keep it logically awesome.", hook_id: 1, sender: { login: "octocat", id: 1, type: "User" } });
  const sign = (secret: string): string => `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;
  const call = async (signature: string): Promise<number> => {
    const req = new Request("https://example.invalid/eve/v1/github", {
      method: "POST",
      headers: { "x-hub-signature-256": signature, "x-github-event": "ping", "x-github-delivery": "d-1", "content-type": "application/json" },
      body: raw,
    });
    const res = await (route as { handler: (r: Request, a: unknown) => Promise<Response> }).handler(req, {
      from: () => ({ send: async () => undefined }),
      waitUntil: (p: Promise<unknown>) => void Promise.resolve(p).catch(() => undefined),
      to: undefined,
    });
    return res.status;
  };
  const accepted = await call(sign(STORED.GITHUB_WEBHOOK_SECRET));
  ok(accepted < 400, `🔴 a delivery signed with the STORED secret passes OE's gate AND eve's own verify (status ${accepted}), with GITHUB_WEBHOOK_SECRET unset`);
  ok((await call(sign("some-other-secret"))) === 401, "negative control: a wrong secret is refused 401");
}

console.log("§2c eve's Discord channel is handed discordBotTokenForEve");
{
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(join(import.meta.dirname, "..", "packages/providers/discord/agent/channels/discord.ts"), "utf8").replace(/\/\/[^\n]*/g, "");
  ok(/discordChannel\(\{[\s\S]*?credentials:\s*\{\s*botToken:\s*discordBotTokenForEve\s*\}/.test(src), "🔴 discord.ts hands discordChannel({ credentials: { botToken: discordBotTokenForEve } })");
}

console.log("§3 the gateway key reaches the provider's outgoing request");
{
  const { gatewayLanguageModel } = await import("@open-everywhere/adapters/agent/model/gateway.js");
  const auth: string[] = [];
  const savedFetch = globalThis.fetch;
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    auth.push(new Headers(init?.headers).get("authorization") ?? "");
    return new Response(JSON.stringify({ error: { message: "stub", type: "stub" } }), { status: 400, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const model = gatewayLanguageModel("anthropic/claude-sonnet-4") as unknown as { doGenerate: (o: unknown) => Promise<unknown> };
    await model.doGenerate({ prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }] }).catch(() => undefined);
  } finally {
    globalThis.fetch = savedFetch;
  }
  ok(auth[0] === `Bearer ${STORED.AI_GATEWAY_API_KEY}`, `🔴 the FIRST model call presents the STORED key as its bearer, with AI_GATEWAY_API_KEY unset (${auth.length} request(s))`);
}

console.log("§4 the AWS STS mint presents the stored inline token");
{
  const { makeAwsStsProvider } = await import("@open-everywhere/adapters/agent/aws/sts.js");
  const bodies: string[] = [];
  const expiration = new Date(Date.now() + 3600_000).toISOString();
  const provider = makeAwsStsProvider({
    fetch: (async (_url: string, init?: RequestInit) => {
      bodies.push(String(init?.body ?? ""));
      return new Response(
        `<AssumeRoleWithWebIdentityResponse><AssumeRoleWithWebIdentityResult><Credentials><AccessKeyId>AK</AccessKeyId><SecretAccessKey>SK</SecretAccessKey><SessionToken>ST</SessionToken><Expiration>${expiration}</Expiration></Credentials></AssumeRoleWithWebIdentityResult></AssumeRoleWithWebIdentityResponse>`,
        { status: 200 },
      );
    }) as typeof fetch,
  });
  await provider.mint({ kind: "domain-role", roleArn: "arn:aws:iam::123456789012:role/oe-surface-secrets", region: "eu-west-1", roleSessionName: "oe-surface-secrets" });
  ok(new URLSearchParams(bodies[0] ?? "").get("WebIdentityToken") === STORED.OE_AWS_WEB_IDENTITY_TOKEN, "🔴 the STS body carries the STORED inline token");
}

console.log("§5 with the rows deleted, every read answers unset");
{
  for (const name of Object.keys(STORED)) await secrets.removeOperatorSecret(name);
  secrets.resetOperatorSecretMemo();
  resetSlackCredentialMemo();
  ok((await slackBotToken()) === undefined && (await slackSigningSecret()) === undefined, "Slack reads nothing");
  ok((await discordBotToken()) === undefined && (await discordRelaySecret()) === undefined, "Discord reads nothing");
  ok((await githubAppPrivateKey()) === undefined && (await githubWebhookSecret()) === undefined && (await personalTokenValue()) === undefined, "GitHub reads nothing");
  ok((await staticLinearToken()) === undefined && (await linearPrimaryWebhookSecret()) === undefined, "Linear reads nothing");
  ok(!(await operatorSecretConfigured("AI_GATEWAY_API_KEY")), "the gateway key reads as unset");
}

console.warn = quiet;
removeTempDir(tmp);
console.log(`✓ surface-operator-secrets: ${n} assertions passed`);
process.exit(0);
