import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes, createHash } from "node:crypto";
import type { EncryptedKvVault } from "@open-everywhere/core/agent/adapter-api.js";

const dir = join(tmpdir(), `oe-oauth-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");
delete process.env.OE_ORG;
process.env.OE_CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString("base64");

const { makePkce, makeState } = await import("../agent/oe-oauth/pkce.js");
const { makeOeOauthTokenVault } = await import("../agent/oe-oauth/token-vault.js");
const { makeOeOauth } = await import("../agent/oe-oauth/user-auth-flow.js");
const { OeOauthNeedsConsentError, OeOauthNeedsReconsentError } = await import("../agent/oe-oauth/errors.js");
import type { OeOauthProviderConfig } from "../agent/oe-oauth/config.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

const RESOURCE = "https://mcp.test";
const AS = "https://as.test";
const TOKEN_URL = `${AS}/token`;
const REG_URL = `${AS}/register`;
const providers = new Map<string, OeOauthProviderConfig>([["notion", { ref: "notion", resource: RESOURCE }]]);
const REDIRECT = "https://oe.example/oauth/v1/callback";

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
}

interface MockState {
  registrations: number;
  exchanges: number;
  refreshCount: number;
  access: string;
  validRefresh: string;
  seq: number;
  exchangeExpiresIn: number;
  onInvalidGrant?: () => Promise<void>;
}

function makeMockFetch(s: MockState) {
  return async (input: string, init?: RequestInit): Promise<Response> => {
    const url = input;
    const method = (init?.method ?? "GET").toUpperCase();
    if (url.endsWith("/.well-known/oauth-protected-resource")) return json({ authorization_servers: [AS] });
    if (url.endsWith("/.well-known/oauth-authorization-server")) {
      return json({ authorization_endpoint: `${AS}/authorize`, token_endpoint: TOKEN_URL, registration_endpoint: REG_URL });
    }
    if (url === REG_URL && method === "POST") {
      s.registrations++;
      return json({ client_id: "CID-1" });
    }
    if (url === TOKEN_URL && method === "POST") {
      const form = new URLSearchParams(String(init?.body ?? ""));
      const grant = form.get("grant_type");
      if (grant === "authorization_code") {
        s.exchanges++;
        return json({ access_token: s.access, refresh_token: s.validRefresh, expires_in: s.exchangeExpiresIn });
      }
      if (grant === "refresh_token") {
        const presented = form.get("refresh_token");
        if (presented !== s.validRefresh) {
          if (s.onInvalidGrant) await s.onInvalidGrant();
          return json({ error: "invalid_grant" }, 400);
        }
        s.refreshCount++;
        s.seq++;
        s.access = `AT-${s.seq}`;
        s.validRefresh = `RT-${s.seq}`;
        return json({ access_token: s.access, refresh_token: s.validRefresh, expires_in: 3600 });
      }
    }
    return new Response("unexpected", { status: 404 });
  };
}

{
  const { verifier, challenge } = makePkce();
  const expected = createHash("sha256").update(verifier).digest("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  ok(challenge === expected, "PKCE challenge = base64url(SHA-256(verifier))");
  ok(/^[A-Za-z0-9_-]{43}$/.test(verifier), "PKCE verifier is 43-char base64url (32 bytes)");
  ok(makeState() !== makeState(), "state is fresh per call (random)");
}

{
  const clock = { t: 1_000_000_000 };
  const s: MockState = { registrations: 0, exchanges: 0, refreshCount: 0, access: "AT-0", validRefresh: "RT-0", seq: 0, exchangeExpiresIn: 1 };
  const { flow, completer } = makeOeOauth(providers, {
    fetch: makeMockFetch(s),
    now: () => clock.t,
    newState: () => "STATE-A",
    newPkce: () => ({ verifier: "VER-A", challenge: "CHAL-A" }),
    redirectUri: () => REDIRECT,
  });

  const { url } = await flow.startAuthorization("notion", { subject: { type: "user", id: "U1" } }, {});
  const u = new URL(url);
  ok(s.registrations === 1, "DCR registered exactly once on first authorize");
  ok(u.searchParams.get("code_challenge") === "CHAL-A", "auth URL carries the PKCE code_challenge");
  ok(u.searchParams.get("code_challenge_method") === "S256", "auth URL uses S256");
  ok(u.searchParams.get("state") === "STATE-A", "auth URL carries the opaque state");
  ok(u.searchParams.get("resource") === RESOURCE, "auth URL carries the RFC 8707 resource indicator");
  ok(u.searchParams.get("redirect_uri") === REDIRECT, "auth URL carries the OE callback redirect_uri");
  ok(!url.includes("VER-A"), "PKCE verifier NEVER appears in the authorization URL");

  const done = await completer({ state: "STATE-A", code: "AUTHCODE" });
  ok(done.ok && done.connectionName === "notion", "callback completer exchanges the code and reports the connection");
  ok(s.exchanges === 1, "code was exchanged exactly once");

  await flow.startAuthorization("notion", { subject: { type: "user", id: "U1" } }, {});
  ok(s.registrations === 1, "DCR client is persisted + reused (still one registration)");

  clock.t += 10_000;
  const N = 8;
  const results = await Promise.all(Array.from({ length: N }, () => flow.mintUserToken("notion", { subject: { type: "user", id: "U1" } })));
  ok(s.refreshCount === 1, `⭐ ${N} concurrent mints triggered EXACTLY ONE upstream refresh (got ${s.refreshCount})`);
  ok(results.every((r) => r.token === "AT-1"), "all N callers ended with the SAME fresh access token");
  ok(results.length === N && results.every((r) => typeof r.token === "string" && r.token.length > 0), "zero bricked connections — every caller got a token");

  const again = await flow.mintUserToken("notion", { subject: { type: "user", id: "U1" } });
  ok(s.refreshCount === 1 && again.token === "AT-1", "a mint within validity reuses the token (no extra refresh)");
}

function memVault(): EncryptedKvVault & { raw: Map<string, string> } {
  const raw = new Map<string, string>();
  const tails = new Map<string, Promise<void>>();
  return {
    raw,
    async read(ref) {
      return raw.has(ref) ? raw.get(ref)! : null;
    },
    async write(ref, plaintext) {
      raw.set(ref, plaintext);
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
  };
}

function seedDcr(v: EncryptedKvVault) {
  return v.write(
    "oe-oauth:dcr:notion",
    JSON.stringify({ clientId: "CID-1", authorizationEndpoint: `${AS}/authorize`, tokenEndpoint: TOKEN_URL, registrationEndpoint: REG_URL, resource: RESOURCE, registeredAt: 0 }),
  );
}
const tokRef = "oe-oauth:tok:notion:user:U1";

{
  const clock = { t: 2_000_000_000 };
  const v = memVault();
  await seedDcr(v);
  await v.write(tokRef, JSON.stringify({ accessToken: "OLD", refreshToken: "R0", expiresAt: clock.t - 1, obtainedAt: 0 }));
  const s: MockState = { registrations: 0, exchanges: 0, refreshCount: 0, access: "x", validRefresh: "NEVER-MATCHES", seq: 0, exchangeExpiresIn: 1 };
  s.onInvalidGrant = async () => {
    await v.write(tokRef, JSON.stringify({ accessToken: "FROM-OTHER-PROC", refreshToken: "R99", expiresAt: clock.t + 3_600_000, obtainedAt: clock.t }));
  };
  let tokenCalls = 0;
  const baseFetch = makeMockFetch(s);
  const countingFetch = async (input: string, init?: RequestInit) => {
    if (input === TOKEN_URL && (init?.method ?? "GET").toUpperCase() === "POST") tokenCalls++;
    return baseFetch(input, init);
  };
  const vault = makeOeOauthTokenVault(providers, { vault: v, fetch: countingFetch, now: () => clock.t });
  const token = await vault.accessTokenFor("notion", { type: "user", id: "U1" });
  ok(token === "FROM-OTHER-PROC", "invalid_grant + a concurrent rotation ⇒ loser adopts the winner's fresh token");
  ok(tokenCalls === 1, "no tight loop — exactly one token-endpoint attempt");
}

{
  const clock = { t: 3_000_000_000 };
  const v = memVault();
  await seedDcr(v);
  await v.write(tokRef, JSON.stringify({ accessToken: "OLD", refreshToken: "RT-DEAD-SECRET", expiresAt: clock.t - 1, obtainedAt: 0 }));
  const s: MockState = { registrations: 0, exchanges: 0, refreshCount: 0, access: "x", validRefresh: "NEVER", seq: 0, exchangeExpiresIn: 1 };
  let tokenCalls = 0;
  const baseFetch = makeMockFetch(s);
  const countingFetch = async (input: string, init?: RequestInit) => {
    if (input === TOKEN_URL && (init?.method ?? "GET").toUpperCase() === "POST") tokenCalls++;
    return baseFetch(input, init);
  };
  const vault = makeOeOauthTokenVault(providers, { vault: v, fetch: countingFetch, now: () => clock.t });
  let caught: unknown;
  try {
    await vault.accessTokenFor("notion", { type: "user", id: "U1" });
  } catch (e) {
    caught = e;
  }
  ok(caught instanceof OeOauthNeedsReconsentError, "dead refresh token ⇒ typed needs-reconsent error");
  ok((caught as { code?: string }).code === "oe_oauth_needs_reconsent", "needs-reconsent carries the stable code");
  ok(!(caught as Error).message.includes("RT-DEAD-SECRET"), "§8: the refresh-token value NEVER leaks into the error message");
  ok(tokenCalls === 1, "no tight loop — exactly one refresh attempt before failing");
}

{
  const v = memVault();
  const vault = makeOeOauthTokenVault(providers, { vault: v, fetch: makeMockFetch({ registrations: 0, exchanges: 0, refreshCount: 0, access: "", validRefresh: "", seq: 0, exchangeExpiresIn: 1 }), now: () => 1 });
  let caught: unknown;
  try {
    await vault.accessTokenFor("notion", { type: "user", id: "U1" });
  } catch (e) {
    caught = e;
  }
  ok(caught instanceof OeOauthNeedsConsentError, "no stored token ⇒ typed needs-consent error");
}

{
  const clock = { t: 4_000_000_000 };
  const v = memVault();
  await seedDcr(v);
  await v.write(tokRef, JSON.stringify({ accessToken: "SOON", refreshToken: "RT-0", expiresAt: clock.t + 5_000, obtainedAt: 0 }));
  const s: MockState = { registrations: 0, exchanges: 0, refreshCount: 0, access: "AT-0", validRefresh: "RT-0", seq: 0, exchangeExpiresIn: 1 };
  const vault = makeOeOauthTokenVault(providers, { vault: v, fetch: makeMockFetch(s), now: () => clock.t });
  const token = await vault.accessTokenFor("notion", { type: "user", id: "U1" });
  ok(s.refreshCount === 1 && token === "AT-1", "a token inside the expiry-skew window is proactively refreshed");
}

{
  const { flow } = makeOeOauth(providers, { fetch: makeMockFetch({ registrations: 0, exchanges: 0, refreshCount: 0, access: "", validRefresh: "", seq: 0, exchangeExpiresIn: 1 }) });
  ok(flow.isUserAuthRequired(new OeOauthNeedsConsentError("notion", { type: "app" })), "needs-consent classifies as user-auth-required");
  ok(flow.isUserAuthRequired(new OeOauthNeedsReconsentError("notion", { type: "user", id: "U1" }, "x")), "needs-reconsent classifies as user-auth-required");
  ok(flow.isUserAuthRequired(Object.assign(new Error("cross-proc"), { code: "oe_oauth_needs_reconsent" })), "duck-typed code match works across module instances");
  ok(!flow.isUserAuthRequired(new Error("some other failure")), "an unrelated error is NOT user-auth-required");
  ok((await flow.environmentClaim()) === "self", "environmentClaim is the honest, stable 'self' stamp");
}

console.log(`✓ oe-oauth: ${n} assertions passed (PKCE, DCR/authorize, forced-rotation single-flight, recovery, typed errors)`);
