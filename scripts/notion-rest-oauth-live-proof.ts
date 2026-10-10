import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { URL } from "node:url";

const DEFAULT_PROVIDER = "api.notion.com/rest";
const DEFAULT_REDIRECT = "http://localhost:8787/callback";

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}
function present(name: string): boolean {
  return process.argv.includes(`--${name}`);
}
function fail(message: string): never {
  console.error(`✗ ${message}`);
  process.exit(1);
}

const providerRef = flag("provider") ?? DEFAULT_PROVIDER;
const redirectUri = flag("redirect-uri") ?? DEFAULT_REDIRECT;

const { loadOeOauthConfig, isStaticConfidential } = await import("../packages/adapters/agent/oe-oauth/config.js");
const signInPath = flag("sign-in");
if (!signInPath) fail("pass --sign-in <file.json> — the sign-in declaration to drive. See this file's header for the shape.");
const providers = loadOeOauthConfig(new Map([[providerRef, JSON.parse(readFileSync(signInPath, "utf8")) as unknown]]));
const cfg = providers?.get(providerRef);
if (!cfg) fail(`the sign-in in ${signInPath} did not load for "${providerRef}". See this file's header for the shape.`);
if (!isStaticConfidential(cfg)) fail(`provider "${providerRef}" declares mode "${cfg.mode}" — this proof drives the static confidential mode.`);

const { registerDbCredentialBroker } = await import("@open-everywhere/core/agent/credentials/db-broker.js");
const { getSecretVia } = await import("@open-everywhere/core/agent/access/credentials.js");
registerDbCredentialBroker();
let clientSecret: string;
try {
  clientSecret = await getSecretVia(cfg.clientSecretBroker, cfg.clientSecretRef);
} catch (e) {
  fail(`could not read the client secret at "${cfg.clientSecretRef}" (broker "${cfg.clientSecretBroker}"): ${e instanceof Error ? e.message : String(e)}`);
}
if (!clientSecret) fail(`the client secret at "${cfg.clientSecretRef}" has no stored value — run \`oe secret set ${cfg.clientSecretRef}\` first.`);

const { buildStaticAuthorizationUrl, exchangeCodeConfidential, refreshTokenConfidential } = await import("../packages/adapters/agent/oe-oauth/oauth-client.js");
const client = {
  clientId: cfg.clientId,
  clientSecret,
  bodyEncoding: cfg.bodyEncoding,
  ...(cfg.tokenHeaders ? { headers: cfg.tokenHeaders } : {}),
} as const;

const state = `proof-${Date.now().toString(36)}`;
const authorizeUrl = buildStaticAuthorizationUrl({
  authorizationEndpoint: cfg.authorizationEndpoint,
  clientId: cfg.clientId,
  redirectUri,
  state,
  ...(cfg.scopes ? { scopes: cfg.scopes } : {}),
  ...(cfg.authorizeParams ? { extraParams: cfg.authorizeParams } : {}),
});

console.log(`provider     : ${providerRef}`);
console.log(`client id    : ${cfg.clientId}`);
console.log(`secret ref   : ${cfg.clientSecretRef} (broker ${cfg.clientSecretBroker}) — value read, never printed`);
console.log(`redirect uri : ${redirectUri}`);
console.log(`\n① AUTHORIZE — open this URL and approve:\n\n${authorizeUrl}\n`);

if (present("no-listen") && flag("code") === undefined) process.exit(0);

async function awaitCode(): Promise<string> {
  const target = new URL(redirectUri);
  if (target.protocol !== "http:" || (target.hostname !== "localhost" && target.hostname !== "127.0.0.1")) {
    fail(`--redirect-uri ${redirectUri} is not a local URL, so this script cannot listen on it. Pass --code <code> instead, or use the default ${DEFAULT_REDIRECT}.`);
  }
  const port = Number(target.port || "80");
  return new Promise<string>((resolve, reject) => {
    const server = createServer((req, res) => {
      const got = new URL(req.url ?? "/", `http://${target.host}`);
      if (got.pathname !== target.pathname) {
        res.writeHead(404).end("not the callback path");
        return;
      }
      const code = got.searchParams.get("code");
      const returnedState = got.searchParams.get("state");
      res.writeHead(200, { "content-type": "text/plain" }).end(code ? "authorization received — you can close this tab." : "no code on the callback.");
      server.close();
      if (returnedState !== state) return reject(new Error(`the callback returned state ${JSON.stringify(returnedState)}, not the one this run minted — refusing to exchange it`));
      if (!code) return reject(new Error(`the callback carried no code (error=${got.searchParams.get("error") ?? "none"})`));
      resolve(code);
    });
    server.on("error", reject);
    server.listen(port, () => console.log(`waiting on ${redirectUri} …`));
  });
}

const code = flag("code") ?? (await awaitCode());

console.log("\n② TOKEN — exchanging the code as a confidential client (HTTP Basic) …");
const tokens = await exchangeCodeConfidential(cfg.tokenEndpoint, { code, redirectUri }, client, (input, init) => fetch(input, init));
console.log(`   access_token  : present (${tokens.access_token.length} chars, not printed)`);
console.log(`   token_type    : ${tokens.token_type ?? "(absent)"}`);
console.log(`   refresh_token : ${tokens.refresh_token ? "present (not printed)" : "ABSENT — this grant cannot be refreshed"}`);
console.log(`   expires_in    : ${tokens.expires_in ?? "(absent — no stated expiry)"}`);

console.log("\n③ REST — calling GET https://api.notion.com/v1/users/me under the minted token …");
const me = await fetch("https://api.notion.com/v1/users/me", {
  headers: {
    authorization: `Bearer ${tokens.access_token}`,
    "notion-version": cfg.tokenHeaders?.["Notion-Version"] ?? "2022-06-28",
  },
});
const body = (await me.json().catch(() => ({}))) as Record<string, unknown>;
if (!me.ok) fail(`Notion refused the REST call — HTTP ${me.status}, code ${JSON.stringify(body.code ?? "unknown")}. A 401 here means the token is the WRONG FAMILY for api.notion.com.`);
const bot = body.bot as { owner?: { user?: { name?: string } } } | undefined;
console.log(`   HTTP ${me.status} — object=${String(body.object)} id=${String(body.id)} name=${JSON.stringify(body.name ?? null)} owner=${JSON.stringify(bot?.owner?.user?.name ?? null)}`);

if (tokens.refresh_token) {
  console.log("\n④ REFRESH — presenting the refresh token as the same confidential client …");
  const rotated = await refreshTokenConfidential(cfg.tokenEndpoint, { refreshToken: tokens.refresh_token, ...(cfg.scopes ? { scopes: cfg.scopes } : {}) }, client, (input, init) => fetch(input, init));
  console.log(`   access_token  : present (${rotated.access_token.length} chars, not printed)`);
  console.log(`   refresh_token : ${rotated.refresh_token ? (rotated.refresh_token === tokens.refresh_token ? "unchanged — this server does NOT rotate" : "ROTATED") : "absent — the prior one is kept"}`);
}

console.log("\n✓ LIVE PROOF COMPLETE — Notion accepted the static confidential client end to end.");
