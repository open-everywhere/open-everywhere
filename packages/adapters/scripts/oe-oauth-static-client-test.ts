import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import type { EncryptedKvVault } from "@open-everywhere/core/agent/adapter-api.js";

const dir = join(tmpdir(), `oe-oauth-static-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");
delete process.env.OE_ORG;
process.env.OE_CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString("base64");

const { makeOeOauth } = await import("../agent/oe-oauth/user-auth-flow.js");
const { loadOeOauthConfig, isStaticConfidential, OE_OAUTH_CONFIG_ENV, OE_OAUTH_MODE_STATIC, OE_OAUTH_MODE_DISCOVERY } = await import("../agent/oe-oauth/config.js");
const { basicAuthHeader } = await import("../agent/oe-oauth/oauth-client.js");
import type { OeOauthProviderConfig, OeOauthStaticProviderConfig } from "../agent/oe-oauth/config.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

function throws(fn: () => unknown, match: RegExp, label: string): void {
  let message = "";
  try {
    fn();
  } catch (e) {
    message = e instanceof Error ? e.message : String(e);
  }
  ok(message !== "" && match.test(message), `${label} (got ${JSON.stringify(message)})`);
}

const AUTHORIZE_URL = "https://api.notion.com/v1/oauth/authorize";
const TOKEN_URL = "https://api.notion.com/v1/oauth/token";
const DISCOVERY_URL = "https://api.notion.com/.well-known/oauth-authorization-server";
const REDIRECT = "https://oe.example/oauth/v1/callback";
const CLIENT_ID = "00000000-0000-4000-8000-00000000e0e5";
const CLIENT_SECRET = "secret_ThisIsTheClientSecretValueThatMustNeverLeak0001";
const SECRET_REF = "db:notion:rest-client-secret";
const NOTION_VERSION = "2022-06-28";

const notionRest: OeOauthStaticProviderConfig = {
  mode: OE_OAUTH_MODE_STATIC,
  ref: "api.notion.com/rest",
  authorizationEndpoint: AUTHORIZE_URL,
  tokenEndpoint: TOKEN_URL,
  clientId: CLIENT_ID,
  clientSecretRef: SECRET_REF,
  clientSecretBroker: "db",
  authorizeParams: { owner: "user" },
  tokenHeaders: { "Notion-Version": NOTION_VERSION },
  bodyEncoding: "json",
};

const staticProviders = new Map<string, OeOauthProviderConfig>([[notionRest.ref, notionRest]]);

interface Recorded {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string;
  readonly redirect: string;
}

interface MockOptions {
  readonly refuseToken?: boolean;
  readonly revocationUrl?: string;
}

function notionMock(opts: MockOptions = {}) {
  const seen: Recorded[] = [];
  let validRefresh = "REFRESH-0";
  let issued = 0;

  const json = (obj: unknown, status = 200): Response => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

  const fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
    const raw = Object.entries((init?.headers ?? {}) as Record<string, string>);
    const headers = Object.fromEntries(raw.map(([k, v]) => [k.toLowerCase(), v]));
    const body = typeof init?.body === "string" ? init.body : "";
    seen.push({ url: input, method: (init?.method ?? "GET").toUpperCase(), headers, body, redirect: String(init?.redirect ?? "") });

    const lowered = raw.map(([k]) => k.toLowerCase());
    if (new Set(lowered).size !== lowered.length) return json({ error: "invalid_request" }, 400);

    if (input.startsWith(DISCOVERY_URL) || input.includes("/.well-known/")) return json({ error: "invalid_request_url" }, 400);
    if (input.includes("/register")) return json({ error: "not_found" }, 404);

    if (opts.revocationUrl && input === opts.revocationUrl) {
      if (headers.authorization !== basicAuthHeader(CLIENT_ID, CLIENT_SECRET)) return json({ error: "invalid_client" }, 401);
      return new Response(null, { status: 200 });
    }

    if (input === TOKEN_URL) {
      if (opts.refuseToken) return json({ error: "invalid_client" }, 401);
      if (headers.authorization !== basicAuthHeader(CLIENT_ID, CLIENT_SECRET)) return json({ error: "invalid_client" }, 401);
      if (headers["content-type"] !== "application/json") return json({ error: "invalid_request" }, 400);
      if (headers["notion-version"] !== NOTION_VERSION) return json({ error: "invalid_request" }, 400);
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(body) as Record<string, unknown>;
      } catch {
        return json({ error: "invalid_request" }, 400);
      }
      if (parsed.grant_type === "authorization_code") {
        if (parsed.code !== "AUTH-CODE" || parsed.redirect_uri !== REDIRECT) return json({ error: "invalid_grant" }, 400);
        issued++;
        return json({
          access_token: `ACCESS-${issued}`,
          token_type: "bearer",
          bot_id: "BOT-1",
          workspace_id: "WS-1",
          workspace_name: "Test Workspace",
          owner: { type: "user", user: { object: "user", id: "USER-1" } },
          refresh_token: validRefresh,
          expires_in: 1,
        });
      }
      if (parsed.grant_type === "refresh_token") {
        if (parsed.refresh_token !== validRefresh) return json({ error: "invalid_grant" }, 400);
        issued++;
        validRefresh = `REFRESH-${issued}`;
        return json({ access_token: `ACCESS-${issued}`, token_type: "bearer", bot_id: "BOT-1", workspace_id: "WS-1", refresh_token: validRefresh, expires_in: 3600 });
      }
      return json({ error: "unsupported_grant_type" }, 400);
    }
    return json({ error: "not_found" }, 404);
  };

  return { fetchImpl, seen };
}

function memVault(): EncryptedKvVault & { raw: Map<string, string> } {
  const raw = new Map<string, string>();
  const claims = new Map<string, { id: string; at: number }>();
  const tails = new Map<string, Promise<void>>();
  return {
    raw,
    async read(ref) {
      return raw.has(ref) ? raw.get(ref)! : null;
    },
    async write(ref, plaintext) {
      raw.set(ref, plaintext);
    },
    async delete(ref) {
      const had = raw.has(ref);
      raw.delete(ref);
      claims.delete(ref);
      return had;
    },
    async listRefs(refPrefix) {
      if (!refPrefix) throw new Error("encryptedKvVault.listRefs: a non-empty ref prefix is required.");
      return [...raw.keys()].filter((k) => k.startsWith(refPrefix)).sort();
    },
    async withLock(key, fn) {
      const prev = tails.get(key) ?? Promise.resolve();
      let release!: () => void;
      const mine = new Promise<void>((r) => (release = r));
      const tail = prev.then(() => mine);
      tails.set(key, tail);
      await prev;
      try {
        return await fn();
      } finally {
        release();
        if (tails.get(key) === tail) tails.delete(key);
      }
    },
    async claim(ref, claimId, nowMs, leaseTtlMs) {
      const cur = claims.get(ref);
      if (!cur || nowMs - cur.at >= leaseTtlMs) {
        claims.set(ref, { id: claimId, at: nowMs });
        return true;
      }
      return false;
    },
    async releaseClaim(ref, claimId) {
      const cur = claims.get(ref);
      if (cur && cur.id === claimId) claims.delete(ref);
    },
  };
}

const warnings: string[] = [];
const realWarn = console.warn.bind(console);
console.warn = (...args: unknown[]) => {
  warnings.push(args.map((a) => String(a)).join(" "));
};

const errorMessages: string[] = [];
async function captureThrow(fn: () => Promise<unknown>): Promise<Error> {
  try {
    await fn();
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    errorMessages.push(err.message, String(err), err.stack ?? "");
    return err;
  }
  throw new Error("expected a throw, got none");
}

{
  const withConfig = <T>(value: string | undefined, fn: () => T): T => {
    const prior = process.env[OE_OAUTH_CONFIG_ENV];
    if (value === undefined) delete process.env[OE_OAUTH_CONFIG_ENV];
    else process.env[OE_OAUTH_CONFIG_ENV] = value;
    try {
      return fn();
    } finally {
      if (prior === undefined) delete process.env[OE_OAUTH_CONFIG_ENV];
      else process.env[OE_OAUTH_CONFIG_ENV] = prior;
    }
  };
  const entry = (extra: Record<string, unknown>): string => JSON.stringify({ "api.notion.com/rest": { mode: OE_OAUTH_MODE_STATIC, ...extra } });
  const good = {
    authorizationEndpoint: AUTHORIZE_URL,
    tokenEndpoint: TOKEN_URL,
    clientId: CLIENT_ID,
    clientSecretRef: SECRET_REF,
    authorizeParams: { owner: "user" },
    tokenHeaders: { "Notion-Version": NOTION_VERSION },
    bodyEncoding: "json",
  };

  const loaded = withConfig(entry(good), () => loadOeOauthConfig());
  const cfg = loaded?.get("api.notion.com/rest");
  ok(cfg !== undefined && isStaticConfidential(cfg), "a JSON entry declaring the static mode loads as a static confidential provider");
  ok(cfg !== undefined && isStaticConfidential(cfg) && cfg.clientSecretBroker === "db", "the client secret broker defaults to the encrypted db credential store");
  ok(cfg !== undefined && isStaticConfidential(cfg) && cfg.authorizeParams?.owner === "user", "the vendor's extra authorize parameter survives the parse (M3 owner=user)");
  ok(cfg !== undefined && isStaticConfidential(cfg) && cfg.tokenHeaders?.["Notion-Version"] === NOTION_VERSION, "the vendor's extra token header survives the parse (M4 Notion-Version)");

  const legacy = withConfig(JSON.stringify({ notion: { resource: "https://mcp.notion.com/mcp" } }), () => loadOeOauthConfig());
  const legacyCfg = legacy?.get("notion");
  ok(legacyCfg !== undefined && legacyCfg.mode === OE_OAUTH_MODE_DISCOVERY, "an entry with no declared mode still reads as the discovery + DCR + PKCE dialect");
  ok(legacyCfg !== undefined && !isStaticConfidential(legacyCfg), "…and it is NOT promoted to the confidential mode");

  throws(
    () => withConfig(JSON.stringify({ x: { resource: "https://mcp.notion.com/mcp", clientId: CLIENT_ID } }), () => loadOeOauthConfig()),
    /carries "clientId" but declares no mode/,
    "a config that LOOKS static but declares no mode is refused, never promoted",
  );
  throws(() => withConfig(JSON.stringify({ x: { mode: "pkce", resource: "https://m.test" } }), () => loadOeOauthConfig()), /is not a known oe-oauth mode/, "an unknown mode is refused, not defaulted");

  throws(() => withConfig(entry({ ...good, clientSecret: CLIENT_SECRET }), () => loadOeOauthConfig()), /must NEVER live in this config block/, "a literal clientSecret in the config block is refused");

  throws(() => withConfig(entry({ ...good, tokenEndpoint: "http://api.notion.com/v1/oauth/token" }), () => loadOeOauthConfig()), /must use https/, "a plaintext http token endpoint is refused");
  throws(() => withConfig(entry({ ...good, authorizationEndpoint: "/v1/oauth/authorize" }), () => loadOeOauthConfig()), /must be an absolute URL/, "a relative authorization endpoint is refused");
  throws(() => withConfig(entry({ ...good, authorizeParams: { client_id: "OTHER" } }), () => loadOeOauthConfig()), /may not set "client_id"/, "config may not override the client_id on the authorize URL");
  throws(() => withConfig(entry({ ...good, authorizeParams: { redirect_uri: "https://evil.test/cb" } }), () => loadOeOauthConfig()), /may not set "redirect_uri"/, "config may not override the redirect_uri on the authorize URL");
  throws(() => withConfig(entry({ ...good, tokenHeaders: { Authorization: "Bearer nope" } }), () => loadOeOauthConfig()), /may not set "Authorization"/, "config may not replace the Basic credential header");
  throws(() => withConfig(entry({ ...good, bodyEncoding: "xml" }), () => loadOeOauthConfig()), /must be "json" or "form"/, "the body encoding vocabulary is closed");
  throws(() => withConfig(entry({ ...good, clientSecretRef: "" }), () => loadOeOauthConfig()), /clientSecretRef must be a non-empty string/, "a static provider with no secret ref is refused");
}

{
  const clock = { t: 1_700_000_000_000 };
  const { fetchImpl, seen } = notionMock();
  const v = memVault();
  let pkceMints = 0;
  const { flow, completer } = makeOeOauth(staticProviders, {
    vault: v,
    fetch: fetchImpl,
    now: () => clock.t,
    newState: () => "STATE-STATIC",
    newPkce: () => {
      pkceMints++;
      return { verifier: "VER-NEVER", challenge: "CHAL-NEVER" };
    },
    redirectUri: () => REDIRECT,
    resolveSecret: async (broker, ref) => {
      ok(broker === "db" && ref === SECRET_REF, "the client secret is read through the declared broker and ref");
      return CLIENT_SECRET;
    },
  });

  const { url } = await flow.startAuthorization(notionRest.ref, { subject: { type: "user", id: "U1" } }, {});
  const u = new URL(url);
  ok(`${u.origin}${u.pathname}` === AUTHORIZE_URL, "M3: the consent URL is Notion's authorize endpoint");
  ok(u.searchParams.get("response_type") === "code", "M3: response_type=code");
  ok(u.searchParams.get("client_id") === CLIENT_ID, "M3: the portal-issued client_id rides the URL");
  ok(u.searchParams.get("redirect_uri") === REDIRECT, "M3: the OE callback redirect_uri");
  ok(u.searchParams.get("owner") === "user", "M3: the vendor's owner=user parameter, from config");
  ok(u.searchParams.get("state") === "STATE-STATIC", "M3: the opaque state");
  ok(u.searchParams.get("code_challenge") === null && u.searchParams.get("code_challenge_method") === null, "M3 NEGATIVE: no PKCE challenge — this server does not support it");
  ok(u.searchParams.get("resource") === null, "M3 NEGATIVE: no RFC 8707 resource indicator");

  ok(pkceMints === 0, "🔴 the PKCE mint is NEVER invoked for a static confidential provider");
  ok(v.raw.get(`oe-oauth:pend:STATE-STATIC`) !== undefined, "the pending authorization row is written");
  ok(JSON.parse(v.raw.get(`oe-oauth:pend:STATE-STATIC`)!).pkceVerifier === "", "…and it stores an EMPTY verifier, not a minted one");

  ok(seen.length === 0, "🔴 starting a static authorization made NO network request at all");
  ok(!seen.some((r) => r.url.includes("/.well-known/")), "M1 NEGATIVE: no discovery document was requested");
  ok(!seen.some((r) => r.url.includes("/register")), "M2 NEGATIVE: no dynamic client registration was attempted");
  ok([...v.raw.keys()].every((k) => !k.startsWith("oe-oauth:dcr:")), "🔴 no DCR client record is written — a static client is config, not state");

  const done = await completer({ state: "STATE-STATIC", code: "AUTH-CODE" });
  ok(done.ok === true, `the callback exchange succeeds against the enforced contract (${done.ok ? "" : done.detail})`);
  const tokenCalls = seen.filter((r) => r.url === TOKEN_URL);
  ok(tokenCalls.length === 1, "exactly one token request was sent");
  const t = tokenCalls[0]!;
  ok(t.method === "POST", "M4: POST");
  ok(t.headers.authorization === `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`, "utf-8").toString("base64")}`, "M4: Authorization is Basic base64(client_id:client_secret)");
  const decoded = Buffer.from(t.headers.authorization.slice("Basic ".length), "base64").toString("utf-8");
  ok(decoded === `${CLIENT_ID}:${CLIENT_SECRET}`, "…and it decodes to exactly the id and the secret, colon-joined");
  ok(t.headers["content-type"] === "application/json", "M4: Content-Type application/json — the body is JSON, not form-encoded");
  ok(t.headers["notion-version"] === NOTION_VERSION, "M4: the vendor's Notion-Version header, from config");
  ok(t.redirect === "error", "the token request refuses to follow a redirect, so the Basic header is never replayed elsewhere");
  const sentBody = JSON.parse(t.body) as Record<string, unknown>;
  ok(sentBody.grant_type === "authorization_code" && sentBody.code === "AUTH-CODE" && sentBody.redirect_uri === REDIRECT, "M4: the body is {grant_type, code, redirect_uri}");
  ok(Object.keys(sentBody).length === 3, "M4 NEGATIVE: the body carries those three fields and nothing else");
  ok(!("code_verifier" in sentBody), "M4 NEGATIVE: no PKCE code_verifier");
  ok(!("client_id" in sentBody) && !("client_secret" in sentBody), "M4 NEGATIVE: no credential in the body — Basic is the only authentication method used");
  ok(!("resource" in sentBody), "M4 NEGATIVE: no RFC 8707 resource indicator");

  clock.t += 10_000;
  const minted = await flow.mintUserToken(notionRest.ref, { subject: { type: "user", id: "U1" } });
  ok(minted.token === "ACCESS-2", "M5: an expired access token is refreshed and the fresh one is returned");
  const refreshCall = seen.filter((r) => r.url === TOKEN_URL).at(-1)!;
  const refreshBody = JSON.parse(refreshCall.body) as Record<string, unknown>;
  ok(refreshBody.grant_type === "refresh_token" && refreshBody.refresh_token === "REFRESH-0", "M5: the stored refresh token is presented");
  ok(refreshCall.headers.authorization === basicAuthHeader(CLIENT_ID, CLIENT_SECRET), "M5: the refresh authenticates with the same Basic credential");
  ok(!seen.some((r) => r.url.includes("/.well-known/") || r.url.includes("/register")), "🔴 NEGATIVE: a static refresh takes no discovery hop and no registration hop");

  {
    const bad = notionMock({ refuseToken: true });
    const badFlow = makeOeOauth(staticProviders, {
      vault: memVault(),
      fetch: bad.fetchImpl,
      now: () => clock.t,
      newState: () => "STATE-BAD",
      redirectUri: () => REDIRECT,
      resolveSecret: async () => CLIENT_SECRET,
    });
    await badFlow.flow.startAuthorization(notionRest.ref, { subject: { type: "user", id: "U1" } }, {});
    const outcome = await badFlow.completer({ state: "STATE-BAD", code: "AUTH-CODE" });
    ok(outcome.ok === false, "M7: the vendor's invalid_client refusal fails the callback");
    if (outcome.ok === false) {
      const detail = outcome.detail ?? "";
      errorMessages.push(detail);
      ok(/invalid_client/.test(detail), "…and the refusal names the RFC 6749 error code, which is public vocabulary");
      ok(!detail.includes(CLIENT_SECRET), "🔴 …and the refusal does NOT carry the client secret");
    }
    for (const r of bad.seen) seen.push(r);
  }

  {
    const unset = makeOeOauth(staticProviders, {
      vault: memVault(),
      fetch: notionMock().fetchImpl,
      now: () => clock.t,
      newState: () => "STATE-UNSET",
      redirectUri: () => REDIRECT,
      resolveSecret: async () => "",
    });
    await unset.flow.startAuthorization(notionRest.ref, { subject: { type: "user", id: "U1" } }, {});
    const outcome = await unset.completer({ state: "STATE-UNSET", code: "AUTH-CODE" });
    ok(outcome.ok === false, "an unprovisioned client secret fails the mint closed");
    if (outcome.ok === false) {
      const detail = outcome.detail ?? "";
      errorMessages.push(detail);
      ok(detail.includes(SECRET_REF), "…and the error names the credential REF, so an operator knows what to fill");
    }
  }

  {
    const drift = new Map<string, OeOauthProviderConfig>([[notionRest.ref, { mode: OE_OAUTH_MODE_DISCOVERY, ref: notionRest.ref, resource: "https://mcp.notion.com/mcp" }]]);
    const driftVault = memVault();
    const before = makeOeOauth(staticProviders, { vault: driftVault, fetch: fetchImpl, now: () => clock.t, newState: () => "STATE-DRIFT", redirectUri: () => REDIRECT, resolveSecret: async () => CLIENT_SECRET });
    await before.flow.startAuthorization(notionRest.ref, { subject: { type: "user", id: "U1" } }, {});
    const after = makeOeOauth(drift, { vault: driftVault, fetch: fetchImpl, now: () => clock.t, redirectUri: () => REDIRECT });
    const outcome = await after.completer({ state: "STATE-DRIFT", code: "AUTH-CODE" });
    ok(outcome.ok === false, "a consent started as a static confidential client is REFUSED once the config declares another mode");
    if (outcome.ok === false) ok(/no longer declares that mode/.test(outcome.detail ?? ""), "…and the refusal says so, rather than exchanging under different parameters");
  }

  const b64 = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`, "utf-8").toString("base64");
  const carriers: string[] = [];
  for (const r of seen) {
    carriers.push(r.url, r.body);
    for (const [name, value] of Object.entries(r.headers)) {
      if (name === "authorization") continue;
      carriers.push(`${name}: ${value}`);
    }
  }
  carriers.push(...errorMessages, ...warnings, ...v.raw.values());
  const leaks = carriers.filter((s) => s.includes(CLIENT_SECRET) || s.includes(b64));
  ok(leaks.length === 0, `🔴 the client secret appears NOWHERE outside the Authorization header (${leaks.length} leak(s): ${leaks.slice(0, 2).join(" | ").slice(0, 200)})`);
  ok([...seen.map((r) => r.headers.authorization ?? "")].some((h) => h.includes(b64)), "…and the sweep's own detector DOES find the credential in the header it belongs in");
  ok(v.raw.size > 0, "…and the vault rows the sweep read were not an empty set");
}

{
  const REVOKE_URL = "https://api.notion.com/v1/oauth/revoke";
  {
    const { fetchImpl, seen } = notionMock({ revocationUrl: REVOKE_URL });
    const v = memVault();
    const withRevoke = new Map<string, OeOauthProviderConfig>([[notionRest.ref, { ...notionRest, revocationEndpoint: REVOKE_URL }]]);
    const tokRef = `oe-oauth:tok:${notionRest.ref}:user:U1`;
    await v.write(tokRef, JSON.stringify({ accessToken: "ACCESS-X", refreshToken: "REFRESH-X", obtainedAt: 0 }));
    const { purge } = makeOeOauth(withRevoke, { vault: v, fetch: fetchImpl, redirectUri: () => REDIRECT, resolveSecret: async () => CLIENT_SECRET });
    const purged = await purge.purgeSubject("U1");
    ok(purged === 1, "the purge destroyed the static provider's token row");
    const revokeCalls = seen.filter((r) => r.url === REVOKE_URL);
    ok(revokeCalls.length === 1, "RFC 7009: the vendor was told, once");
    ok(revokeCalls[0]!.headers.authorization === basicAuthHeader(CLIENT_ID, CLIENT_SECRET), "…authenticated as the confidential client");
    ok(new URLSearchParams(revokeCalls[0]!.body).get("token") === "REFRESH-X", "…presenting the REFRESH token, which kills the grant family");
    ok(new URLSearchParams(revokeCalls[0]!.body).get("token_type_hint") === "refresh_token", "…with the RFC 7009 type hint");
    ok(v.raw.get(tokRef) === undefined, "…and the row is gone");
  }
  {
    const { fetchImpl, seen } = notionMock();
    const v = memVault();
    const tokRef = `oe-oauth:tok:${notionRest.ref}:user:U1`;
    await v.write(tokRef, JSON.stringify({ accessToken: "ACCESS-X", refreshToken: "REFRESH-X", obtainedAt: 0 }));
    const { purge } = makeOeOauth(staticProviders, { vault: v, fetch: fetchImpl, redirectUri: () => REDIRECT, resolveSecret: async () => CLIENT_SECRET });
    const purged = await purge.purgeSubject("U1");
    ok(purged === 1, "with no revocation endpoint configured the row is still destroyed");
    ok(seen.length === 0, "…and NO vendor call was attempted — there is nothing to call");
    ok(v.raw.get(tokRef) === undefined, "…and the row is gone");
  }
}

{
  const AS = "https://as.test";
  const seen: string[] = [];
  const discoveryFetch = async (input: string, init?: RequestInit): Promise<Response> => {
    seen.push(`${(init?.method ?? "GET").toUpperCase()} ${input}`);
    const json = (obj: unknown): Response => new Response(JSON.stringify(obj), { status: 200, headers: { "content-type": "application/json" } });
    if (input.endsWith("/.well-known/oauth-protected-resource")) return json({ authorization_servers: [AS] });
    if (input.endsWith("/.well-known/oauth-authorization-server")) {
      return json({ authorization_endpoint: `${AS}/authorize`, token_endpoint: `${AS}/token`, registration_endpoint: `${AS}/register`, revocation_endpoint: `${AS}/revoke` });
    }
    if (input === `${AS}/register`) return json({ client_id: "CID-PUBLIC" });
    return new Response("{}", { status: 404 });
  };
  const v = memVault();
  let pkceMints = 0;
  const discovery = new Map<string, OeOauthProviderConfig>([["mcp", { mode: OE_OAUTH_MODE_DISCOVERY, ref: "mcp", resource: "https://mcp.test" }]]);
  const { flow } = makeOeOauth(discovery, {
    vault: v,
    fetch: discoveryFetch,
    newState: () => "STATE-PUBLIC",
    newPkce: () => {
      pkceMints++;
      return { verifier: "VER-P", challenge: "CHAL-P" };
    },
    redirectUri: () => REDIRECT,
    resolveSecret: async () => {
      throw new Error("the discovery dialect must not resolve a client secret");
    },
  });
  const { url } = await flow.startAuthorization("mcp", { subject: { type: "user", id: "U1" } }, {});
  const u = new URL(url);
  ok(pkceMints === 1, "NEGATIVE CONTROL: the public PKCE path still mints a verifier");
  ok(u.searchParams.get("code_challenge") === "CHAL-P" && u.searchParams.get("code_challenge_method") === "S256", "…and still carries the S256 challenge");
  ok(u.searchParams.get("resource") === "https://mcp.test", "…and still carries the RFC 8707 resource indicator");
  ok(seen.some((s) => s.includes("/.well-known/oauth-protected-resource")) && seen.some((s) => s.includes("/.well-known/oauth-authorization-server")), "…and still runs two-hop discovery");
  ok(seen.some((s) => s === `POST ${AS}/register`), "…and still performs dynamic client registration");
  ok(v.raw.get("oe-oauth:dcr:mcp") !== undefined, "…and still persists its DCR client record");
}

{
  const v = memVault();
  const AS = "https://as.test";
  await v.write(
    "oe-oauth:dcr:orphan",
    JSON.stringify({ clientId: "CID-ORPHAN", authorizationEndpoint: `${AS}/authorize`, tokenEndpoint: `${AS}/token`, registrationEndpoint: `${AS}/register`, revocationEndpoint: `${AS}/revoke`, resource: "https://mcp.test", registeredAt: 0 }),
  );
  const { flow } = makeOeOauth(new Map<string, OeOauthProviderConfig>(), {
    vault: v,
    fetch: async () => {
      throw new Error("no network call should be needed");
    },
    newState: () => "STATE-ORPHAN",
    newPkce: () => ({ verifier: "V", challenge: "C" }),
    redirectUri: () => REDIRECT,
  });
  const { url } = await flow.startAuthorization("orphan", { subject: { type: "user", id: "U1" } }, {});
  ok(url.startsWith(`${AS}/authorize`), "a discovery mint whose config entry is absent still resolves from its complete DCR record (unchanged behaviour)");
  ok(new URL(url).searchParams.get("client_id") === "CID-ORPHAN", "…using the client id that record already holds");
}

{
  const { fetchImpl, seen } = notionMock();
  const shouty = new Map<string, OeOauthProviderConfig>([[notionRest.ref, { ...notionRest, tokenHeaders: { "Notion-Version": NOTION_VERSION, "Content-Type": "text/plain", Accept: "text/plain" } }]]);
  const { flow, completer } = makeOeOauth(shouty, { vault: memVault(), fetch: fetchImpl, newState: () => "STATE-CASE", redirectUri: () => REDIRECT, resolveSecret: async () => CLIENT_SECRET });
  await flow.startAuthorization(notionRest.ref, { subject: { type: "user", id: "U1" } }, {});
  const outcome = await completer({ state: "STATE-CASE", code: "AUTH-CODE" });
  ok(outcome.ok === true, "a config header that case-varies one the adapter owns does not break the request");
  const sent = seen.find((r) => r.url === TOKEN_URL)!;
  ok(sent.headers["content-type"] === "application/json", "…the adapter's Content-Type is what travels");
  ok(sent.headers["notion-version"] === NOTION_VERSION, "…and the vendor header the adapter does NOT own still travels");
}

console.warn = realWarn;
console.log(`✓ oe-oauth static confidential client: ${n} assertions passed (declared mode, M1–M7 mocked contract, Basic composition, no-PKCE/no-discovery negative controls, secret containment sweep, purge, mode drift)`);
