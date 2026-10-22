import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes, createHash } from "node:crypto";
import type { EncryptedKvVault } from "@open-everywhere/core/agent/adapter-api.js";
import { encryptedKvVault } from "@open-everywhere/core/agent/adapter-api.js";

const dir = join(tmpdir(), `oe-oauth-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");
_setDeploymentIdentityForTest({ org: undefined });
process.env.OE_CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString("base64");

const { makePkce, makeState } = await import("../agent/oe-oauth/pkce.js");
const { makeOeOauthTokenVault, CLAIM_LEASE_TTL_MS } = await import("../agent/oe-oauth/token-vault.js");
const { makeOeOauth } = await import("../agent/oe-oauth/user-auth-flow.js");
const { OeOauthNeedsConsentError, OeOauthNeedsReconsentError, OeOauthRefreshContendedError } = await import("../agent/oe-oauth/errors.js");
import type { OeOauthProviderConfig } from "../agent/oe-oauth/config.js";
import { _setDeploymentIdentityForTest } from "@open-everywhere/core/agent/adapter-api.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

const RESOURCE = "https://mcp.test";
const AS = "https://as.test";
const TOKEN_URL = `${AS}/token`;
const REG_URL = `${AS}/register`;
const providers = new Map<string, OeOauthProviderConfig>([["notion", { mode: "discovery-dcr-pkce", ref: "notion", resource: RESOURCE }]]);
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
  ok(done.subject?.type === "user" && done.subject.id === "U1", "…and hands back the SUBJECT it bound, which core audits");
  ok(done.rebound === false, "…and the rebind flag — false here, because nothing was bound for U1 before this");

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

type ClaimState = { id: string; at: number };
type SharedBacking = { raw: Map<string, string>; claims: Map<string, ClaimState> };
function memVault(shared?: SharedBacking): EncryptedKvVault & SharedBacking {
  const raw = shared?.raw ?? new Map<string, string>();
  const claims = shared?.claims ?? new Map<string, ClaimState>();
  const tails = new Map<string, Promise<void>>();
  return {
    raw,
    claims,
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
      if (!refPrefix) throw new Error("encryptedKvVault.listRefs: a non-empty ref prefix is required — this interface cannot enumerate the whole credential store.");
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
      const free = !cur || nowMs - cur.at >= leaseTtlMs;
      if (free) {
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

{
  const clock = { t: 5_000_000_000 };
  const shared: SharedBacking = { raw: new Map(), claims: new Map() };
  const vA = memVault(shared);
  const vB = memVault(shared);
  await seedDcr(vA);
  await vA.write(tokRef, JSON.stringify({ accessToken: "OLD", refreshToken: "RT-0", expiresAt: clock.t - 1, obtainedAt: 0 }));
  const s: MockState = { registrations: 0, exchanges: 0, refreshCount: 0, access: "AT-0", validRefresh: "RT-0", seq: 0, exchangeExpiresIn: 1 };
  let tokenCalls = 0;
  const baseFetch = makeMockFetch(s);
  const countingFetch = async (input: string, init?: RequestInit) => {
    if (input === TOKEN_URL && (init?.method ?? "GET").toUpperCase() === "POST") tokenCalls++;
    return baseFetch(input, init);
  };
  const yieldSleep = async () => {
    await Promise.resolve();
  };
  const mkVault = (v: EncryptedKvVault) => makeOeOauthTokenVault(providers, { vault: v, fetch: countingFetch, now: () => clock.t, sleep: yieldSleep });
  const vaultA = mkVault(vA);
  const vaultB = mkVault(vB);
  const N = 8;
  const calls = Array.from({ length: N }, (_, i) => (i % 2 === 0 ? vaultA : vaultB).accessTokenFor("notion", { type: "user", id: "U1" }));
  const tokens = await Promise.all(calls);
  ok(s.refreshCount === 1, `⭐ ${N} cross-process concurrent refreshes triggered EXACTLY ONE upstream refresh (got ${s.refreshCount})`);
  ok(tokenCalls === 1, "cross-process: exactly one token-endpoint call across both instances");
  ok(tokens.every((t) => t === "AT-1"), "cross-process: every caller (both instances) ended with the SAME rotated token");
  ok(tokens.length === N, "cross-process: zero bricked connections — every caller got a token");
}

{
  const clock = { t: 6_000_000_000 };
  const shared: SharedBacking = { raw: new Map(), claims: new Map() };
  const vA = memVault(shared);
  const vB = memVault(shared);
  await seedDcr(vA);
  await vA.write(tokRef, JSON.stringify({ accessToken: "OLD", refreshToken: "RT-0", expiresAt: clock.t - 1, obtainedAt: 0 }));
  const s: MockState = { registrations: 0, exchanges: 0, refreshCount: 0, access: "AT-0", validRefresh: "RT-0", seq: 0, exchangeExpiresIn: 1 };
  shared.claims.set(tokRef, { id: "A-CRASHED", at: clock.t });
  const advanceSleep = (ms: number) => {
    clock.t += ms;
    return Promise.resolve();
  };
  const vaultBshort = makeOeOauthTokenVault(providers, { vault: vB, fetch: makeMockFetch(s), now: () => clock.t, sleep: advanceSleep });
  let caughtEarly: unknown;
  try {
    await vaultBshort.accessTokenFor("notion", { type: "user", id: "U1" });
  } catch (e) {
    caughtEarly = e;
  }
  ok(caughtEarly instanceof OeOauthRefreshContendedError, "crashed-winner: before the lease TTL, a loser times out (claim held)");
  ok(s.refreshCount === 0, "crashed-winner: the timed-out loser NEVER called the token endpoint");
  clock.t = 6_000_000_000 + CLAIM_LEASE_TTL_MS + 1;
  const vaultBsteal = makeOeOauthTokenVault(providers, { vault: vB, fetch: makeMockFetch(s), now: () => clock.t });
  const token = await vaultBsteal.accessTokenFor("notion", { type: "user", id: "U1" });
  ok(token === "AT-1" && s.refreshCount === 1, "crashed-winner: after the lease TTL, a fresh attempt steals the stale claim and refreshes once");
}

{
  const clock = { t: 7_000_000_000 };
  const shared: SharedBacking = { raw: new Map(), claims: new Map() };
  const vB = memVault(shared);
  await seedDcr(vB);
  await vB.write(tokRef, JSON.stringify({ accessToken: "OLD", refreshToken: "RT-DEAD-SECRET", expiresAt: clock.t - 1, obtainedAt: 0 }));
  const s: MockState = { registrations: 0, exchanges: 0, refreshCount: 0, access: "AT-0", validRefresh: "NEVER", seq: 0, exchangeExpiresIn: 1 };
  const advanceSleep = (ms: number) => {
    clock.t += ms;
    shared.claims.set(tokRef, { id: "LIVE-WINNER", at: clock.t });
    return Promise.resolve();
  };
  shared.claims.set(tokRef, { id: "LIVE-WINNER", at: clock.t });
  const vaultB = makeOeOauthTokenVault(providers, { vault: vB, fetch: makeMockFetch(s), now: () => clock.t, sleep: advanceSleep });
  let caught: unknown;
  try {
    await vaultB.accessTokenFor("notion", { type: "user", id: "U1" });
  } catch (e) {
    caught = e;
  }
  ok(caught instanceof OeOauthRefreshContendedError, "loser-timeout: a held claim past the wait budget ⇒ typed contended error");
  ok((caught as { code?: string }).code === "oe_oauth_refresh_contended", "loser-timeout: the error carries the stable transient code");
  ok(!(caught as Error).message.includes("RT-DEAD-SECRET"), "loser-timeout: no secret leaks into the error message");
  ok(s.refreshCount === 0, "loser-timeout: the loser NEVER called the token endpoint");
}

{
  const rv = encryptedKvVault();
  const CREF = "oe-oauth:tok:realclaim:user:U1";
  await rv.write(CREF, JSON.stringify({ accessToken: "AT", refreshToken: "RT", obtainedAt: 0 }), { connector: "notion" });
  const base = 8_000_000_000;
  ok((await rv.claim(CREF, "R-A", base, CLAIM_LEASE_TTL_MS)) === true, "real-store: first claimant wins the free row");
  ok((await rv.claim(CREF, "R-B", base + 10, CLAIM_LEASE_TTL_MS)) === false, "real-store: a second claimant loses while the lease is held");
  await rv.releaseClaim(CREF, "R-B");
  ok((await rv.claim(CREF, "R-B2", base + 20, CLAIM_LEASE_TTL_MS)) === false, "real-store: a wrong-holder release did NOT free the row");
  await rv.releaseClaim(CREF, "R-A");
  ok((await rv.claim(CREF, "R-C", base + 30, CLAIM_LEASE_TTL_MS)) === true, "real-store: a released row is claimable again");
  ok((await rv.claim(CREF, "R-D", base + 30 + CLAIM_LEASE_TTL_MS + 1, CLAIM_LEASE_TTL_MS)) === true, "real-store: an expired lease is stolen by a fresh claim");
  ok(JSON.parse((await rv.read(CREF))!).accessToken === "AT", "real-store: claim/release never touch the stored value");
}

{
  const { discoverEndpoints } = await import("../agent/oe-oauth/oauth-client.js");
  const AS_META = { authorization_endpoint: `${AS}/authorize`, token_endpoint: TOKEN_URL, registration_endpoint: REG_URL };

  {
    const fetched: string[] = [];
    const eps = await discoverEndpoints("https://mcp.test/mcp", async (url: string) => {
      fetched.push(url);
      if (url === "https://mcp.test/.well-known/oauth-protected-resource/mcp") return json({ authorization_servers: [AS] });
      if (url === `${AS}/.well-known/oauth-authorization-server`) return json(AS_META);
      return json({ error: "unauthorized" }, 401);
    });
    ok(eps.registrationEndpoint === REG_URL, "path-bearing resource: discovery resolves endpoints via the RFC 9728 form");
    ok(fetched[0] === "https://mcp.test/.well-known/oauth-protected-resource/mcp", "path-bearing resource: first fetch is the origin-inserted, path-suffixed form");
    ok(!fetched.some((u) => u.includes("/mcp/.well-known/")), "path-bearing resource: the naive appended form is never fetched");
  }

  {
    const fetched: string[] = [];
    const eps = await discoverEndpoints("https://mcp.test/mcp", async (url: string) => {
      fetched.push(url);
      if (url === "https://mcp.test/.well-known/oauth-protected-resource") return json({ authorization_servers: [AS] });
      if (url === `${AS}/.well-known/oauth-authorization-server`) return json(AS_META);
      return json({}, 404);
    });
    ok(eps.tokenEndpoint === TOKEN_URL, "root-only server: discovery falls back to the origin-root form");
    ok(fetched[0] === "https://mcp.test/.well-known/oauth-protected-resource/mcp" && fetched[1] === "https://mcp.test/.well-known/oauth-protected-resource", "root-only server: RFC form tried first, root form second");
  }

  {
    const fetched: string[] = [];
    await discoverEndpoints("https://mcp.test", async (url: string) => {
      fetched.push(url);
      if (url === "https://mcp.test/.well-known/oauth-protected-resource") return json({ authorization_servers: [AS] });
      if (url === `${AS}/.well-known/oauth-authorization-server`) return json(AS_META);
      return json({}, 404);
    });
    ok(fetched[0] === "https://mcp.test/.well-known/oauth-protected-resource" && fetched.length === 2, "pathless resource: single origin-root PR fetch, unchanged behaviour");
  }
}

{
  const v = memVault();
  await v.write(tokRef, JSON.stringify({ accessToken: "AT", refreshToken: "RT", expiresAt: 1, obtainedAt: 0 }));
  const { flow } = makeOeOauth(providers, { vault: v, fetch: makeMockFetch({ registrations: 0, exchanges: 0, refreshCount: 0, access: "", validRefresh: "", seq: 0, exchangeExpiresIn: 1 }), now: () => 9_999_999_999 });
  ok((await flow.hasFreshGrant!("notion", { type: "user", id: "U1" })) === true, "hasFreshGrant: a stored (even expired) token row for the subject ⇒ true");
  ok((await flow.hasFreshGrant!("notion", { type: "user", id: "U2" })) === false, "hasFreshGrant: no token row for the subject ⇒ false");

  const throwingVault: EncryptedKvVault = {
    async read() {
      throw new Error("vault backing unavailable");
    },
    async write() {},
    async delete() {
      return false;
    },
    async listRefs() {
      throw new Error("vault backing unavailable");
    },
    async withLock(_k, fn) {
      return fn();
    },
    async claim() {
      return true;
    },
    async releaseClaim() {},
  };
  const { flow: flowThrows } = makeOeOauth(providers, { vault: throwingVault });
  let threw = false;
  let result: boolean | undefined;
  try {
    result = await flowThrows.hasFreshGrant!("notion", { type: "user", id: "U1" });
  } catch {
    threw = true;
  }
  ok(!threw && result === false, "hasFreshGrant: a vault read that throws is caught ⇒ false (never crashes the resume)");
}

{
  const REVOKE_URL = `${AS}/revoke`;
  interface RevokeCall {
    token: string;
    hint: string | null;
    clientId: string | null;
  }
  function purgeFetch(opts: { revocation: boolean; status?: number; failFirst?: number }, calls: RevokeCall[]) {
    return async (input: string, init?: RequestInit): Promise<Response> => {
      const method = (init?.method ?? "GET").toUpperCase();
      if (input.endsWith("/.well-known/oauth-protected-resource")) return json({ authorization_servers: [AS] });
      if (input.endsWith("/.well-known/oauth-authorization-server")) {
        return json({
          authorization_endpoint: `${AS}/authorize`,
          token_endpoint: TOKEN_URL,
          registration_endpoint: REG_URL,
          ...(opts.revocation ? { revocation_endpoint: REVOKE_URL } : {}),
        });
      }
      if (input === REG_URL && method === "POST") return json({ client_id: "CID-1" });
      if (input === REVOKE_URL && method === "POST") {
        const form = new URLSearchParams(String(init?.body ?? ""));
        calls.push({ token: form.get("token") ?? "", hint: form.get("token_type_hint"), clientId: form.get("client_id") });
        const failing = opts.status !== undefined && opts.status >= 400 && (opts.failFirst === undefined || calls.length <= opts.failFirst);
        return failing ? json({ error: "invalid_request" }, opts.status) : new Response("", { status: 200 });
      }
      return new Response("unexpected", { status: 404 });
    };
  }

  const seedTok = (v: EncryptedKvVault, ref: string, rec: Record<string, unknown>) => v.write(ref, JSON.stringify(rec));

  {
    const calls: RevokeCall[] = [];
    const v = memVault();
    const vault = makeOeOauthTokenVault(providers, { vault: v, fetch: purgeFetch({ revocation: true }, calls), redirectUri: () => REDIRECT });
    await vault.startAuthorization("notion", { type: "user", id: "U1" }, {});
    await seedTok(v, tokRef, { accessToken: "AT-live", refreshToken: "RT-live", expiresAt: 9_999_999_999_999, obtainedAt: 0 });

    ok((await vault.forget("notion", { type: "user", id: "U1" })) === true, "purge: forget reports the row went");
    ok(calls.length === 1, "purge: the provider's RFC 7009 revocation endpoint was called exactly once");
    ok(calls[0].token === "RT-live", "purge: the REFRESH token is what is presented (revoking it kills the whole grant family)");
    ok(calls[0].hint === "refresh_token", "purge: token_type_hint names the refresh token");
    ok(calls[0].clientId === "CID-1", "purge: the public client_id is presented (no secret exists to present)");
    ok((await v.read(tokRef)) === null, "🔴 purge: the ciphertext row is GONE from the vault — not merely unreachable");
    ok((await v.read("oe-oauth:dcr:notion")) !== null, "purge: the provider's DCR client registration SURVIVES (a purge forgets a person, not the deployment's client)");

    ok((await vault.forget("notion", { type: "user", id: "U1" })) === false, "purge: a second purge of the same subject reports false (idempotent)");
    ok(calls.length === 1, "purge: nothing is presented to the vendor when there was no record to revoke");
  }

  {
    const calls: RevokeCall[] = [];
    const v = memVault();
    const vault = makeOeOauthTokenVault(providers, { vault: v, fetch: purgeFetch({ revocation: false }, calls), redirectUri: () => REDIRECT });
    await vault.startAuthorization("notion", { type: "user", id: "U1" }, {});
    await seedTok(v, tokRef, { accessToken: "AT-live", refreshToken: "RT-live", obtainedAt: 0 });

    ok((await vault.forget("notion", { type: "user", id: "U1" })) === true, "purge (no revocation_endpoint): the row still goes");
    ok(calls.length === 0, "purge (no revocation_endpoint): nothing is called — an absent optional endpoint is skipped, never an error");
    ok((await v.read(tokRef)) === null, "purge (no revocation_endpoint): the ciphertext is destroyed anyway (local death does not depend on the vendor)");
  }

  {
    const calls: RevokeCall[] = [];
    const v = memVault();
    const vault = makeOeOauthTokenVault(providers, { vault: v, fetch: purgeFetch({ revocation: true, status: 400 }, calls), redirectUri: () => REDIRECT });
    await vault.startAuthorization("notion", { type: "user", id: "U1" }, {});
    await seedTok(v, tokRef, { accessToken: "AT-live", refreshToken: "RT-live", obtainedAt: 0 });

    let threw = false;
    let purged: boolean | undefined;
    const unrevoked: string[] = [];
    try {
      purged = await vault.forget("notion", { type: "user", id: "U1" }, (ref) => unrevoked.push(ref));
    } catch {
      threw = true;
    }
    ok(!threw, "purge (vendor 4xx): forget does not throw — a vendor failure never blocks the purge");
    ok(purged === true, "purge (vendor 4xx): the row still went");
    ok(calls.length === 2, `purge (vendor 4xx): 🔴 the revocation is retried ONCE before the local delete (OPE-2565) — ${calls.length} call(s)`);
    ok(unrevoked.join(",") === "notion", `purge (vendor 4xx): 🔴 the failed revocation is REPORTED with the connection ref, not only warned (OPE-2565) — [${unrevoked.join(",")}]`);
    ok((await v.read(tokRef)) === null, "🔴 purge (vendor 4xx): the ciphertext is destroyed anyway");
  }

  {
    const calls: RevokeCall[] = [];
    const v = memVault();
    const vault = makeOeOauthTokenVault(providers, { vault: v, fetch: purgeFetch({ revocation: true, status: 503, failFirst: 1 }, calls), redirectUri: () => REDIRECT });
    await vault.startAuthorization("notion", { type: "user", id: "U1" }, {});
    await seedTok(v, tokRef, { accessToken: "AT-live", refreshToken: "RT-live", obtainedAt: 0 });
    const unrevoked: string[] = [];
    ok((await vault.forget("notion", { type: "user", id: "U1" }, (ref) => unrevoked.push(ref))) === true, "purge (one 503): the row went");
    ok(calls.length === 2 && calls[1].token === "RT-live", "purge (one 503): the retry presented the same refresh token");
    ok(unrevoked.length === 0, "purge (one 503): a retry that succeeded reports nothing — negative control for (c)");
  }

  {
    const calls: RevokeCall[] = [];
    const v = memVault();
    const { purge } = makeOeOauth(providers, { vault: v, fetch: purgeFetch({ revocation: true, status: 400 }, calls), redirectUri: () => REDIRECT });
    const vaultOnly = makeOeOauthTokenVault(providers, { vault: v, fetch: purgeFetch({ revocation: true }, []), redirectUri: () => REDIRECT });
    await vaultOnly.startAuthorization("notion", { type: "user", id: "U1" }, {});
    await seedTok(v, tokRef, { accessToken: "AT-live", refreshToken: "RT-live", obtainedAt: 0 });
    const unrevoked: string[] = [];
    ok((await purge.purgeSubject("U1", { unrevoked: (p) => void unrevoked.push(p) })) === 1, "purge hook (vendor 4xx): the row still counts as purged");
    ok(unrevoked.join(",") === "notion", `purge hook (vendor 4xx): 🔴 the hook reports the provider that refused — [${unrevoked.join(",")}]`);
    ok((await v.read(tokRef)) === null, "purge hook (vendor 4xx): the ciphertext is destroyed anyway");
  }

  {
    const calls: RevokeCall[] = [];
    const v = memVault();
    const vault = makeOeOauthTokenVault(providers, { vault: v, fetch: purgeFetch({ revocation: true }, calls), redirectUri: () => REDIRECT });
    await vault.startAuthorization("notion", { type: "user", id: "U1" }, {});
    await seedTok(v, tokRef, { accessToken: "AT-only", obtainedAt: 0 });

    await vault.forget("notion", { type: "user", id: "U1" });
    ok(calls[0].token === "AT-only" && calls[0].hint === "access_token", "purge: with no refresh token stored, the ACCESS token is presented and hinted as such");
  }

  {
    const calls: RevokeCall[] = [];
    const multi = new Map<string, OeOauthProviderConfig>([
      ["notion", { mode: "discovery-dcr-pkce", ref: "notion", resource: RESOURCE }],
      ["linear", { mode: "discovery-dcr-pkce", ref: "linear", resource: RESOURCE }],
    ]);
    const v = memVault();
    const { purge } = makeOeOauth(multi, { vault: v, fetch: purgeFetch({ revocation: true }, calls), redirectUri: () => REDIRECT });
    const LS = "ls:default/SET-1";
    await seedTok(v, `oe-oauth:tok:notion:user:${LS}`, { accessToken: "A1", refreshToken: "R1", obtainedAt: 0 });
    await seedTok(v, `oe-oauth:tok:linear:user:${LS}`, { accessToken: "A2", refreshToken: "R2", obtainedAt: 0 });
    await seedTok(v, "oe-oauth:tok:notion:user:ls:default/SET-2", { accessToken: "A3", refreshToken: "R3", obtainedAt: 0 });

    ok((await purge.purgeSubject(LS)) === 2, "purge hook: sweeps EVERY configured provider for the subject (2 rows)");
    ok((await v.read(`oe-oauth:tok:notion:user:${LS}`)) === null && (await v.read(`oe-oauth:tok:linear:user:${LS}`)) === null, "purge hook: both of the subject's rows are destroyed");
    ok((await v.read("oe-oauth:tok:notion:user:ls:default/SET-2")) !== null, "🔴 purge hook: ANOTHER subject's credential is untouched (a purge is scoped to one person)");
    ok((await purge.purgeSubject(LS)) === 0, "purge hook: re-purging an already-purged subject reports 0, never an error");
  }

  {
    const calls: RevokeCall[] = [];
    const v = memVault();
    const declared = { now: new Map<string, OeOauthProviderConfig>([["linear", { mode: "discovery-dcr-pkce", ref: "linear", resource: RESOURCE }]]) };
    const { purge } = makeOeOauth(() => declared.now, { vault: v, fetch: purgeFetch({ revocation: true }, calls), redirectUri: () => REDIRECT });
    const vaultOnly = makeOeOauthTokenVault(() => declared.now, { vault: v, fetch: purgeFetch({ revocation: true }, calls), redirectUri: () => REDIRECT });
    await vaultOnly.startAuthorization("linear", { type: "user", id: "U1" }, {});
    const LS = "ls:default/SET-9";
    await seedTok(v, `oe-oauth:tok:linear:user:${LS}`, { accessToken: "A9", refreshToken: "R9", obtainedAt: 0 });
    await seedTok(v, "oe-oauth:tok:linear:user:ls:default/SET-10", { accessToken: "A10", refreshToken: "R10", obtainedAt: 0 });
    await seedTok(v, `oe-oauth:tok:linear:user:X:user:${LS}`, { accessToken: "AX", obtainedAt: 0 });
    declared.now = new Map();
    ok((await purge.purgeSubject(LS)) === 1, "purge hook (nothing declared): the subject's token for an undeclared connection is purged");
    ok((await v.read(`oe-oauth:tok:linear:user:${LS}`)) === null, "🔴 purge hook (nothing declared): the ciphertext row is gone");
    ok(calls.length === 1 && calls[0].token === "R9", "purge hook (nothing declared): the stored DCR client still revokes the refresh token at the provider");
    ok((await v.read("oe-oauth:tok:linear:user:ls:default/SET-10")) !== null, "purge hook (nothing declared): ANOTHER subject's token stays");
    ok((await v.read(`oe-oauth:tok:linear:user:X:user:${LS}`)) !== null, "🔴 purge hook (nothing declared): a ref that only ENDS with the subject key is not this subject's");
  }

  {
    const v = memVault();
    const vault = makeOeOauthTokenVault(providers, { vault: v, fetch: purgeFetch({ revocation: false }, []) });
    await seedTok(v, tokRef, { accessToken: "AT-live", refreshToken: "RT-live", obtainedAt: 0 });

    const state = { purgeFinished: false };
    let inFlight!: Promise<void>;
    await v.withLock(tokRef, async () => {
      inFlight = vault.forget("notion", { type: "user", id: "U1" }).then(() => {
        state.purgeFinished = true;
      });
      for (let i = 0; i < 20; i++) await Promise.resolve();
      ok(state.purgeFinished === false, "🔴 purge takes the refresh lock: it cannot run inside another holder's critical section");
      await v.write(tokRef, JSON.stringify({ accessToken: "AT-rotated", refreshToken: "RT-rotated", obtainedAt: 1 }));
    });
    await inFlight;
    ok(state.purgeFinished === true, "purge takes the refresh lock: it runs once the holder releases");
    ok((await v.read(tokRef)) === null, "🔴 purge takes the refresh lock: the ROTATED token written inside the critical section is destroyed too (no resurrection)");
  }
}

{
  const RETENTION = 60 * 60 * 1000;
  const PEND = "oe-oauth:pend:";
  const clock = { t: 5_000_000_000 };
  const seedPend = (v: EncryptedKvVault, state: string, expiresAt: number) =>
    v.write(`${PEND}${state}`, JSON.stringify({ providerRef: "notion", subject: { type: "user", id: "U1" }, pkceVerifier: "VER", tokenEndpoint: TOKEN_URL, clientId: "CID-1", resource: RESOURCE, redirectUri: REDIRECT, createdAt: expiresAt - 900_000, expiresAt }));

  {
    const v = memVault();
    await seedDcr(v);
    const s: MockState = { registrations: 0, exchanges: 0, refreshCount: 0, access: "AT", validRefresh: "RT", seq: 0, exchangeExpiresIn: 3600 };
    const vault = makeOeOauthTokenVault(providers, { vault: v, fetch: makeMockFetch(s), now: () => clock.t, pendingRetentionMs: RETENTION });

    await seedPend(v, "OLD-1", clock.t - 30 * 24 * 3600_000);
    await seedPend(v, "OLD-2", clock.t - RETENTION - 1);
    await seedPend(v, "EDGE-KEEP", clock.t - RETENTION);
    await seedPend(v, "LIVE", clock.t + 600_000);
    await v.write(`${PEND}CORRUPT`, "{not json");
    await v.write(`${PEND}NO-EXPIRY`, JSON.stringify({ providerRef: "notion", subject: { type: "user", id: "U1" } }));
    await v.write("oe-oauth:tok:notion:user:U1", JSON.stringify({ accessToken: "AT", refreshToken: "RT", obtainedAt: 0 }));

    const report = await vault.sweepExpiredPending();
    ok(report.scanned === 6, `sweep scans ONLY the oe-oauth:pend: namespace (scanned ${report.scanned}, expected 6 — the tok row and the DCR row are not in it)`);
    ok(report.deleted === 2, `sweep destroys the rows past expiry + retention (deleted ${report.deleted}, expected 2)`);
    ok(report.live === 2, `sweep KEEPS the rows that may still complete (live ${report.live}, expected 2)`);
    ok(report.unreadable === 2, `sweep KEEPS and COUNTS the rows whose expiry it cannot establish (unreadable ${report.unreadable}, expected 2)`);
    ok(report.scanned === report.deleted + report.live + report.unreadable, "the sweep's four counts RECONCILE");

    ok((await v.read(`${PEND}OLD-1`)) === null, "🔴 an expired pending row is DESTROYED (the month-old residue)");
    ok((await v.read(`${PEND}OLD-2`)) === null, "🔴 a row one ms past the retention edge is DESTROYED");
    ok((await v.read(`${PEND}EDGE-KEEP`)) !== null, "🔴 negative control: a row exactly AT the retention edge SURVIVES (the boundary is >, not >=)");
    ok((await v.read(`${PEND}LIVE`)) !== null, "🔴 negative control: a row inside its consent window SURVIVES the sweep");
    ok((await v.read(`${PEND}CORRUPT`)) !== null, "🔴 negative control: an UNREADABLE row SURVIVES — its expiry is the one fact the sweep cannot establish");
    ok((await v.read(`${PEND}NO-EXPIRY`)) !== null, "🔴 negative control: a row with no numeric expiresAt SURVIVES");
    ok((await v.read("oe-oauth:tok:notion:user:U1")) !== null, "🔴 negative control: a TOKEN row is untouched — the sweep never leaves its own namespace");
    ok((await v.read("oe-oauth:dcr:notion")) !== null, "🔴 negative control: the DCR client registration is untouched");
  }

  {
    const v = memVault();
    const POISON = `${PEND}POISON`;
    const guarded: EncryptedKvVault = {
      ...v,
      async read(ref) {
        if (ref === POISON) throw new Error("db credential broker: stored ciphertext is truncated — refusing (fail closed).");
        return v.read(ref);
      },
    };
    const s: MockState = { registrations: 0, exchanges: 0, refreshCount: 0, access: "AT", validRefresh: "RT", seq: 0, exchangeExpiresIn: 3600 };
    const vault = makeOeOauthTokenVault(providers, { vault: guarded, fetch: makeMockFetch(s), now: () => clock.t, pendingRetentionMs: RETENTION });

    await v.write(POISON, "irrelevant — the read throws before this is parsed");
    await seedPend(v, "AAA-EXPIRED", clock.t - 30 * 24 * 3600_000);
    await seedPend(v, "ZZZ-EXPIRED", clock.t - 30 * 24 * 3600_000);

    const report = await vault.sweepExpiredPending();
    ok(report.unreadable === 1, `🔴 an undecryptable row is COUNTED as unreadable, not thrown (unreadable ${report.unreadable})`);
    ok(report.deleted === 2, `🔴 the sweep CONTINUES past the undecryptable row — the rows after it are still destroyed (deleted ${report.deleted}, expected 2)`);
    ok((await v.read(`${PEND}ZZZ-EXPIRED`)) === null, "🔴 the expired row sorted AFTER the poison row is destroyed — one bad row cannot disable the sweep");
    ok((await v.read(POISON)) !== null, "🔴 negative control: the undecryptable row itself SURVIVES — its expiry is unknowable, so it is not ours to destroy");
  }

  {
    const v = memVault();
    const s: MockState = { registrations: 0, exchanges: 0, refreshCount: 0, access: "AT", validRefresh: "RT", seq: 0, exchangeExpiresIn: 3600 };
    const vault = makeOeOauthTokenVault(providers, { vault: v, fetch: makeMockFetch(s), now: () => clock.t, newState: () => "FRESH", newPkce: () => ({ verifier: "V", challenge: "C" }), redirectUri: () => REDIRECT, pendingRetentionMs: RETENTION });
    await seedPend(v, "STALE", clock.t - 30 * 24 * 3600_000);
    ok((await v.read(`${PEND}STALE`)) !== null, "reachability precondition: the stale row exists BEFORE the mint");

    await vault.startAuthorization("notion", { type: "user", id: "U1" }, {});
    ok((await v.read(`${PEND}STALE`)) === null, "🔴 REACHABILITY: startAuthorization CALLS the sweep — the stale row is gone after a mint");
    ok((await v.read(`${PEND}FRESH`)) !== null, "🔴 the pending row the mint JUST wrote survives its own sweep (kept by the expiry rule, not by ordering)");
  }

  {
    const v = memVault();
    const breaking: EncryptedKvVault = { ...v, async listRefs() { throw new Error("enumeration unavailable"); } };
    const s: MockState = { registrations: 0, exchanges: 0, refreshCount: 0, access: "AT", validRefresh: "RT", seq: 0, exchangeExpiresIn: 3600 };
    const vault = makeOeOauthTokenVault(providers, { vault: breaking, fetch: makeMockFetch(s), now: () => clock.t, newState: () => "S", newPkce: () => ({ verifier: "V", challenge: "C" }), redirectUri: () => REDIRECT });
    let url: string | undefined;
    let threw = false;
    try {
      ({ url } = await vault.startAuthorization("notion", { type: "user", id: "U1" }, {}));
    } catch {
      threw = true;
    }
    ok(!threw && typeof url === "string" && url.startsWith(`${AS}/authorize`), "🔴 a sweep that THROWS is swallowed — the mint still returns the authorization URL");
  }

  {
    const v = memVault();
    let threw = false;
    try {
      await v.listRefs("");
    } catch {
      threw = true;
    }
    ok(threw, "🔴 listRefs REFUSES an empty prefix — there is no way to spell 'enumerate every credential'");
  }
}

{
  const REVOKE_URL = `${AS}/revoke`;
  function dcrFetch(opts: { revocation: boolean }, counts: { discovery: number; registrations: number; revokes: number }) {
    return async (input: string, init?: RequestInit): Promise<Response> => {
      const method = (init?.method ?? "GET").toUpperCase();
      if (input.endsWith("/.well-known/oauth-protected-resource")) return json({ authorization_servers: [AS] });
      if (input.endsWith("/.well-known/oauth-authorization-server")) {
        counts.discovery++;
        return json({
          authorization_endpoint: `${AS}/authorize`,
          token_endpoint: TOKEN_URL,
          registration_endpoint: REG_URL,
          ...(opts.revocation ? { revocation_endpoint: REVOKE_URL } : {}),
        });
      }
      if (input === REG_URL && method === "POST") {
        counts.registrations++;
        return json({ client_id: "CID-1" });
      }
      if (input === REVOKE_URL && method === "POST") {
        counts.revokes++;
        return new Response("", { status: 200 });
      }
      return new Response("unexpected", { status: 404 });
    };
  }

  {
    const counts = { discovery: 0, registrations: 0, revokes: 0 };
    const v = memVault();
    await seedDcr(v);
    const vault = makeOeOauthTokenVault(providers, { vault: v, fetch: dcrFetch({ revocation: true }, counts), redirectUri: () => REDIRECT });

    ok(
      (JSON.parse((await v.read("oe-oauth:dcr:notion"))!) as { revocationEndpoint?: string }).revocationEndpoint === undefined,
      "backfill precondition: the seeded record predates revocationEndpoint parsing",
    );

    await vault.startAuthorization("notion", { type: "user", id: "U1" }, {});

    const rec = JSON.parse((await v.read("oe-oauth:dcr:notion"))!) as { clientId: string; revocationEndpoint?: string };
    ok(rec.revocationEndpoint === REVOKE_URL, "🔴 OPE-1037: the next mint BACKFILLS the missing revocationEndpoint onto the existing record");
    ok(rec.clientId === "CID-1", "backfill NEVER re-registers — the clientId is unchanged");
    ok(counts.registrations === 0, "🔴 backfill calls discovery, never registerClient — zero registrations");

    await v.write(tokRef, JSON.stringify({ accessToken: "AT-live", refreshToken: "RT-live", obtainedAt: 0 }));
    ok((await vault.forget("notion", { type: "user", id: "U1" })) === true, "backfill: forget still reports the row went");
    ok(counts.revokes === 1, "🔴 OPE-1037: a purge that was LOCAL-ONLY before the backfill now reaches the vendor's revoke endpoint");
  }

  {
    const counts = { discovery: 0, registrations: 0, revokes: 0 };
    const v = memVault();
    await seedDcr(v);
    const vault = makeOeOauthTokenVault(providers, { vault: v, fetch: dcrFetch({ revocation: false }, counts), redirectUri: () => REDIRECT });

    await vault.startAuthorization("notion", { type: "user", id: "U1" }, {});
    const rec = JSON.parse((await v.read("oe-oauth:dcr:notion"))!) as { revocationEndpoint?: string };
    ok(rec.revocationEndpoint === undefined, "🔴 negative control: a server publishing no revocation endpoint is NOT backfilled — this is a real answer, not a failure");

    await v.write(tokRef, JSON.stringify({ accessToken: "AT-only", obtainedAt: 0 }));
    let threw = false;
    let purged: boolean | undefined;
    try {
      purged = await vault.forget("notion", { type: "user", id: "U1" });
    } catch {
      threw = true;
    }
    ok(!threw && purged === true, "🔴 negative control: the purge still succeeds locally, without looping or throwing");
    ok(counts.revokes === 0, "negative control: no vendor revoke was attempted — none exists to call");
  }

  {
    const counts = { discovery: 0, registrations: 0, revokes: 0 };
    const v = memVault();
    await seedDcr(v);
    const vault = makeOeOauthTokenVault(providers, { vault: v, fetch: dcrFetch({ revocation: true }, counts), redirectUri: () => REDIRECT });

    await vault.startAuthorization("notion", { type: "user", id: "U1" }, {});
    const discoveryAfterRun1 = counts.discovery;
    ok(discoveryAfterRun1 > 0, "run 1 performed the backfill discovery");
    await vault.startAuthorization("notion", { type: "user", id: "U1" }, {});
    await vault.startAuthorization("notion", { type: "user", id: "U1" }, {});
    ok(counts.discovery === discoveryAfterRun1, "🔴 OPE-1037: once backfilled, later runs take the fast path — no repeat discovery calls");
    ok(counts.registrations === 0, "🔴 the job survives multiple runs without ever re-registering");
    const rec = JSON.parse((await v.read("oe-oauth:dcr:notion"))!) as { clientId: string; revocationEndpoint?: string };
    ok(rec.clientId === "CID-1" && rec.revocationEndpoint === REVOKE_URL, "the record is complete and stable across all three runs");
  }

  {
    const v = memVault();
    await seedDcr(v);
    const breaking = async (): Promise<Response> => {
      throw new Error("discovery unreachable");
    };
    const vault = makeOeOauthTokenVault(providers, { vault: v, fetch: breaking, redirectUri: () => REDIRECT });
    let url: string | undefined;
    let threw = false;
    try {
      ({ url } = await vault.startAuthorization("notion", { type: "user", id: "U1" }, {}));
    } catch {
      threw = true;
    }
    ok(!threw && typeof url === "string" && url.startsWith(`${AS}/authorize`), "🔴 a backfill discovery failure is swallowed — the mint still returns the authorization URL");
    const rec = JSON.parse((await v.read("oe-oauth:dcr:notion"))!) as { clientId: string; revocationEndpoint?: string };
    ok(rec.clientId === "CID-1" && rec.revocationEndpoint === undefined, "a failed backfill leaves the frozen record exactly as it was");
  }
}

{
  const clock = { t: 1_000_000_000 };
  const s: MockState = { registrations: 0, exchanges: 0, refreshCount: 0, access: "AT-0", validRefresh: "RT-0", seq: 0, exchangeExpiresIn: 3600 };
  const v = memVault();
  const vault = makeOeOauthTokenVault(providers, {
    vault: v,
    fetch: makeMockFetch(s),
    now: () => clock.t,
    newState: () => "STATE-C",
    newPkce: () => ({ verifier: "VER-C", challenge: "CHAL-C" }),
    redirectUri: () => REDIRECT,
  });

  const carriage = { detourId: "det-x", connector: "notion", origin: { org: "acme", surfaceKey: "slack/T1/C1" } };
  await vault.startAuthorization("notion", { type: "user", id: "U1" }, { consent: carriage });

  const pendRef = "oe-oauth:pend:STATE-C";
  const stored = JSON.parse((await v.read(pendRef))!) as { consent?: { detourId?: string } };
  ok(stored.consent?.detourId === "det-x", "the carriage is persisted VERBATIM on the pending row");

  const first = await vault.completeAuthorization("STATE-C", "CODE-1");
  ok(first.providerRef === "notion", "the first consume completes the authorization");
  ok((first.consent as { detourId?: string } | undefined)?.detourId === "det-x", "the first consume hands the carriage back verbatim");

  const after = JSON.parse((await v.read(pendRef))!) as { consumed?: boolean; pkceVerifier?: string; consent?: unknown };
  ok(after.consumed === true, "the row is marked consumed");
  ok(after.pkceVerifier === "", "the verifier is scrubbed (unchanged behaviour)");
  ok(after.consent === undefined, "🔴 the spent carriage is scrubbed too — no room, thread or principal id survives the consume");

  let replayErr: unknown;
  let replayed: { consent?: unknown } | undefined;
  try {
    replayed = await vault.completeAuthorization("STATE-C", "CODE-1");
  } catch (e) {
    replayErr = e;
  }
  ok(replayErr instanceof Error && /already used/i.test(replayErr.message), "a replayed state throws 'authorization state already used'");
  ok(replayed === undefined, "a replayed state returns NOTHING — so there is no carriage for a return hop to act on twice");
  ok(s.exchanges === 1, "the replay never reaches the token endpoint — the refusal runs before the exchange");

  let unknownErr: unknown;
  try {
    await vault.completeAuthorization("STATE-NEVER-MINTED", "CODE-1");
  } catch (e) {
    unknownErr = e;
  }
  ok(unknownErr instanceof Error && /unknown or expired/i.test(unknownErr.message), "an unminted state is refused as unknown, not as consumed");

  const vault2 = makeOeOauthTokenVault(providers, {
    vault: memVault(),
    fetch: makeMockFetch({ ...s, exchanges: 0 }),
    now: () => clock.t,
    newState: () => "STATE-D",
    newPkce: () => ({ verifier: "VER-D", challenge: "CHAL-D" }),
    redirectUri: () => REDIRECT,
  });
  await vault2.startAuthorization("notion", { type: "user", id: "U1" }, {});
  const bare = await vault2.completeAuthorization("STATE-D", "CODE-2");
  ok(bare.consent === undefined, "an authorization started with no carriage completes with none — nothing to resume, and no error");
}

{
  const clock = { t: 1_000_000_000 };
  const s: MockState = { registrations: 0, exchanges: 0, refreshCount: 0, access: "AT-0", validRefresh: "RT-0", seq: 0, exchangeExpiresIn: 3600 };
  const v = memVault();
  let state = "STATE-E1";
  const vault = makeOeOauthTokenVault(providers, {
    vault: v,
    fetch: makeMockFetch(s),
    now: () => clock.t,
    newState: () => state,
    newPkce: () => ({ verifier: "VER-E", challenge: "CHAL-E" }),
    redirectUri: () => REDIRECT,
  });

  await vault.startAuthorization("notion", { type: "app" }, {});
  const firstBind = await vault.completeAuthorization(state, "CODE-E1");
  ok(firstBind.subject.type === "app", "the completion names the APP subject it bound — the deployment-wide row, keyed to no principal");
  ok(firstBind.rebound === false, "🔴 …and reports rebound FALSE on a first bind (the negative control for the flag below)");

  state = "STATE-E2";
  await vault.startAuthorization("notion", { type: "app" }, {});
  const secondBind = await vault.completeAuthorization(state, "CODE-E2");
  ok(secondBind.rebound === true, "🔴 a SECOND consent for the same subject reports rebound TRUE — the swap the audit row exists to witness");

  state = "STATE-E3";
  await vault.startAuthorization("notion", { type: "user", id: "U-NEW" }, {});
  const userBind = await vault.completeAuthorization(state, "CODE-E3");
  ok(userBind.subject.type === "user" && (userBind.subject as { id: string }).id === "U-NEW", "…and a user-subject completion names that subject");
  ok(userBind.rebound === false, "🔴 …with rebound FALSE: the flag is per (provider, SUBJECT) row, not 'the second completion on this vault'");

  ok(!JSON.stringify(firstBind).includes(s.access) && !JSON.stringify(secondBind).includes("RT-"), "🔴 the returned facts carry no access or refresh token");
}

{
  const saved = { a: process.env.OE_PUBLIC_BASE_URL, b: process.env.VERCEL_PROJECT_PRODUCTION_URL, c: process.env.VERCEL_URL };
  const restore = () => {
    for (const [k, v] of [["OE_PUBLIC_BASE_URL", saved.a], ["VERCEL_PROJECT_PRODUCTION_URL", saved.b], ["VERCEL_URL", saved.c]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  try {
    delete process.env.OE_PUBLIC_BASE_URL;
    process.env.VERCEL_PROJECT_PRODUCTION_URL = "acme-oe.vercel.app";
    process.env.VERCEL_URL = "acme-oe-abc123.vercel.app";
    const fresh = new Map<string, OeOauthProviderConfig>([["notion-2669", { mode: "discovery-dcr-pkce", ref: "notion-2669", resource: RESOURCE }]]);
    const s: MockState = { registrations: 0, exchanges: 0, refreshCount: 0, access: "AT-0", validRefresh: "RT-0", seq: 0, exchangeExpiresIn: 1 };
    const { flow } = makeOeOauth(fresh, { fetch: makeMockFetch(s) });
    const { url } = await flow.startAuthorization("notion-2669", { subject: { type: "user", id: "U1" } }, {});
    const sent = new URL(url).searchParams.get("redirect_uri");
    ok(sent === "https://acme-oe.vercel.app/oauth/v1/callback", `🔴 OPE-2669: with only the Vercel variables the default redirect_uri is the production alias plus the callback path (saw ${sent})`);

    process.env.OE_PUBLIC_BASE_URL = "https://agent.acme.example";
    const { url: movedUrl } = await flow.startAuthorization("notion-2669", { subject: { type: "user", id: "U1" } }, {});
    const movedSent = new URL(movedUrl).searchParams.get("redirect_uri");
    ok(movedSent === "https://acme-oe.vercel.app/oauth/v1/callback", `🔴 OPE-2669: after the address moves, a registered dynamic client keeps sending the callback it registered with (saw ${movedSent})`);
    ok(s.registrations === 1, "OPE-2669: the moved address registers no second client");
    delete process.env.OE_PUBLIC_BASE_URL;

    delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
    delete process.env.VERCEL_URL;
    const none = new Map<string, OeOauthProviderConfig>([["notion-2669b", { mode: "discovery-dcr-pkce", ref: "notion-2669b", resource: RESOURCE }]]);
    const { flow: flowNone } = makeOeOauth(none, { fetch: makeMockFetch({ ...s, registrations: 0 }) });
    const err = await flowNone.startAuthorization("notion-2669b", { subject: { type: "user", id: "U1" } }, {}).then(() => undefined, (e: unknown) => e);
    ok(err instanceof Error && /no public URL \(set OE_PUBLIC_BASE_URL\)/.test(err.message), `OPE-2669: with no public URL the flow refuses and names the setting (saw ${String(err)})`);
  } finally {
    restore();
  }
}

console.log(`✓ oe-oauth: ${n} assertions passed (PKCE, DCR/authorize, in-process + cross-process single-flight, crashed-winner steal, loser-timeout, recovery, real-store claim CAS, RFC 9728 well-known derivation, hasFreshGrant probe, RFC 7009 purge, expired-pending sweep, DCR endpoint backfill, consent carriage single-use + scrub, typed errors)`);
