import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import type { EncryptedKvVault } from "@open-everywhere/core/agent/adapter-api.js";

const dir = join(tmpdir(), `oe-oauth-xaa-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");
process.env.OE_CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString("base64");

const { makeOeOauth } = await import("../agent/oe-oauth/user-auth-flow.js");
const { loadOeOauthConfig, OE_OAUTH_MODE_XAA } = await import("../agent/oe-oauth/config.js");
const { basicAuthHeader, GRANT_JWT_BEARER, GRANT_TOKEN_EXCHANGE, TOKEN_TYPE_ID_JAG, TOKEN_TYPE_REFRESH_TOKEN } = await import("../agent/oe-oauth/oauth-client.js");
const { xaaNamesOrg } = await import("../agent/directory/okta.js");
import type { OeOauthProviderConfig, OeOauthXaaProviderConfig } from "../agent/oe-oauth/config.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};
async function rejects(p: Promise<unknown>, match: RegExp, label: string): Promise<unknown> {
  let err: unknown;
  try {
    await p;
  } catch (e) {
    err = e;
  }
  const message = err instanceof Error ? err.message : "";
  ok(err !== undefined && match.test(message), `${label} (got ${JSON.stringify(message)})`);
  return err;
}

const ISSUER = "https://acme.okta.com";
const IDP_AUTHZ = `${ISSUER}/oauth2/v1/authorize`;
const IDP_TOKEN = `${ISSUER}/oauth2/v1/token`;
const IDP_JWKS = `${ISSUER}/oauth2/v1/keys`;
const IDP_REVOKE = `${ISSUER}/oauth2/v1/revoke`;
const IDP_CID = "0oaOEAPP";
const IDP_SECRET = "idp-secret-value-that-must-never-leak";
const APP_AS = "https://auth.datadog.example";
const APP_TOKEN = `${APP_AS}/oauth2/token`;
const APP_CID = "dd-client-for-oe";
const APP_SECRET = "app-secret-value-that-must-never-leak";
const REDIRECT = "https://oe.example/oauth/v1/callback";
const ALICE = "p:default/discord/D_ALICE";
const BOB = "p:default/discord/D_BOB";
const ALICE_OKTA = "00uALICE";
const BOB_OKTA = "00uBOB";

const SECRETS: Record<string, string> = { "db:okta:oe-client-secret": IDP_SECRET, "db:datadog:xaa-client-secret": APP_SECRET };

const decl = {
  mode: "xaa",
  idpIssuer: ISSUER,
  idpClientId: IDP_CID,
  idpClientSecretRef: "db:okta:oe-client-secret",
  audience: APP_AS,
  resource: "https://mcp.datadog.example/mcp",
  scopes: ["mcp:read"],
  resourceTokenEndpoint: APP_TOKEN,
  resourceClientId: APP_CID,
  resourceClientSecretRef: "db:datadog:xaa-client-secret",
};

function providers(extra: Record<string, unknown> = {}): Map<string, OeOauthProviderConfig> {
  return loadOeOauthConfig(
    new Map<string, unknown>([
      ["mcp-server/datadog", { ...decl, ...extra }],
      ["mcp-server/linear", { ...decl, audience: "https://auth.linear.example", resource: "https://mcp.linear.example/mcp", resourceTokenEndpoint: "https://auth.linear.example/token" }],
    ]),
  )!;
}

interface FakeOptions {
  readonly signingKey?: KeyObject;
  signer: string;
  readonly revoked: Set<string>;
  readonly jagClientId: string;
  appRefuse?: string;
}

function fakes(o: FakeOptions) {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...(publicKey.export({ format: "jwk" }) as Record<string, unknown>), kid: "k1", alg: "RS256", use: "sig" };
  const counts = { authCode: 0, leg1: 0, leg2: 0, revoke: 0, discovery: 0 };
  const codes = new Map<string, { challenge: string; nonce: string; signer: string }>();
  const refreshOwner = new Map<string, string>();
  const revokedRefresh = new Set<string>();
  const leaked: string[] = [];
  const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
  const idToken = (sub: string, nonce: string) => {
    const now = Math.floor(Date.now() / 1000);
    const head = `${b64({ alg: "RS256", kid: "k1", typ: "JWT" })}.${b64({ iss: ISSUER, aud: IDP_CID, sub, nonce, iat: now, exp: now + 300 })}`;
    return `${head}.${sign("sha256", Buffer.from(head), o.signingKey ?? privateKey).toString("base64url")}`;
  };
  const json = (obj: unknown, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

  const fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    const body = new URLSearchParams(typeof init?.body === "string" ? init.body : "");
    for (const secret of [IDP_SECRET, APP_SECRET]) if (input.includes(secret) || (typeof init?.body === "string" && init.body.includes(secret))) leaked.push(input);

    if (input === `${ISSUER}/.well-known/openid-configuration`) {
      counts.discovery++;
      return json({ issuer: ISSUER, authorization_endpoint: IDP_AUTHZ, token_endpoint: IDP_TOKEN, jwks_uri: IDP_JWKS, revocation_endpoint: IDP_REVOKE });
    }
    if (input === IDP_JWKS) return json({ keys: [jwk] });
    if (input === IDP_REVOKE) {
      if (headers.authorization !== basicAuthHeader(IDP_CID, IDP_SECRET)) return json({ error: "invalid_client" }, 401);
      counts.revoke++;
      revokedRefresh.add(body.get("token") ?? "");
      return new Response(null, { status: 200 });
    }
    if (input === IDP_TOKEN) {
      if (headers.authorization !== basicAuthHeader(IDP_CID, IDP_SECRET)) return json({ error: "invalid_client" }, 401);
      const grant = body.get("grant_type");
      if (grant === "authorization_code") {
        const pending = codes.get(body.get("code") ?? "");
        if (!pending || body.get("redirect_uri") !== REDIRECT) return json({ error: "invalid_grant" }, 400);
        const verifier = body.get("code_verifier") ?? "";
        if (createHash("sha256").update(verifier).digest("base64url") !== pending.challenge) return json({ error: "invalid_grant" }, 400);
        codes.delete(body.get("code") ?? "");
        counts.authCode++;
        const rt = `IDP-RT-${pending.signer}-${counts.authCode}`;
        refreshOwner.set(rt, pending.signer);
        return json({ access_token: "IDP-AT", token_type: "Bearer", expires_in: 3600, refresh_token: rt, id_token: idToken(pending.signer, pending.nonce), scope: "openid offline_access" });
      }
      if (grant === GRANT_TOKEN_EXCHANGE) {
        counts.leg1++;
        if (body.get("requested_token_type") !== TOKEN_TYPE_ID_JAG || body.get("subject_token_type") !== TOKEN_TYPE_REFRESH_TOKEN) return json({ error: "invalid_request" }, 400);
        const subjectToken = body.get("subject_token") ?? "";
        const user = refreshOwner.get(subjectToken);
        if (!user || revokedRefresh.has(subjectToken)) return json({ error: "invalid_grant" }, 400);
        if (o.revoked.has(user)) return json({ error: "access_denied" }, 400);
        const aud = body.get("audience") ?? "";
        const jag = `jag.${b64({ sub: user, aud, client_id: o.jagClientId, resource: body.get("resource"), scope: body.get("scope") })}`;
        return json({ access_token: jag, issued_token_type: TOKEN_TYPE_ID_JAG, token_type: "N_A", expires_in: 300 });
      }
      return json({ error: "unsupported_grant_type" }, 400);
    }
    if (input === APP_TOKEN || input === "https://auth.linear.example/token") {
      counts.leg2++;
      if (o.appRefuse) return json({ error: o.appRefuse }, 400);
      const auth = headers.authorization ?? "";
      const knownClients = [APP_CID, "some-other-client"];
      const authed = knownClients.find((c) => auth === basicAuthHeader(c, APP_SECRET));
      if (!authed) return json({ error: "invalid_client" }, 401);
      if (body.get("grant_type") !== GRANT_JWT_BEARER) return json({ error: "unsupported_grant_type" }, 400);
      const assertion = body.get("assertion") ?? "";
      if (!assertion.startsWith("jag.")) return json({ error: "invalid_grant" }, 400);
      const jag = JSON.parse(Buffer.from(assertion.slice(4), "base64url").toString()) as { sub: string; aud: string; client_id: string };
      const expectedAud = input === APP_TOKEN ? APP_AS : "https://auth.linear.example";
      if (jag.client_id !== authed || jag.aud !== expectedAud) return json({ error: "invalid_grant" }, 400);
      return json({ access_token: `APP-AT-${jag.sub}-${expectedAud}-${counts.leg2}`, token_type: "Bearer", expires_in: 3600, refresh_token: "APP-RT-MUST-NOT-BE-STORED" });
    }
    return json({ error: "not_found" }, 404);
  };

  function openAuthorizeUrl(url: string): { state: string; code: string } {
    const u = new URL(url);
    assert.equal(`${u.origin}${u.pathname}`, IDP_AUTHZ);
    const code = `CODE-${codes.size}-${Math.random()}`;
    codes.set(code, { challenge: u.searchParams.get("code_challenge") ?? "", nonce: u.searchParams.get("nonce") ?? "", signer: o.signer });
    return { state: u.searchParams.get("state") ?? "", code };
  }

  const signerIs = (who: string) => {
    o.signer = who;
  };
  return { fetchImpl, openAuthorizeUrl, counts, leaked, refreshOwner, revokedRefresh, signerIs };
}

type Backing = { raw: Map<string, string>; claims: Map<string, { id: string; at: number }> };
function memVault(shared?: Backing): EncryptedKvVault & Backing {
  const raw = shared?.raw ?? new Map<string, string>();
  const claims = shared?.claims ?? new Map<string, { id: string; at: number }>();
  const tails = new Map<string, Promise<void>>();
  return {
    raw,
    claims,
    async read(ref) {
      return raw.get(ref) ?? null;
    },
    async write(ref, plaintext) {
      raw.set(ref, plaintext);
    },
    async delete(ref) {
      const had = raw.delete(ref);
      claims.delete(ref);
      return had;
    },
    async listRefs(prefix) {
      return [...raw.keys()].filter((k) => k.startsWith(prefix)).sort();
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
    async claim(ref, claimId, nowMs, ttl) {
      if (!raw.has(ref)) return false;
      const cur = claims.get(ref);
      if (cur && nowMs - cur.at < ttl) return false;
      claims.set(ref, { id: claimId, at: nowMs });
      return true;
    },
    async releaseClaim(ref, claimId) {
      if (claims.get(ref)?.id === claimId) claims.delete(ref);
    },
  };
}

const CONFIRMED: Record<string, string | undefined> = { [ALICE]: ALICE_OKTA, [BOB]: BOB_OKTA };
const PLANE = { unreadable: false };
const bindIdentity = async ({ principalSubject, signerSubject }: { principalSubject: string; signerSubject: string | undefined }) =>
  PLANE.unreadable
    ? ({ ok: false, reason: "the identity-link plane could not be read", unreadable: true } as const)
    : CONFIRMED[principalSubject] !== undefined && CONFIRMED[principalSubject] === signerSubject
    ? ({ ok: true, idpNativeId: signerSubject! } as const)
    : ({ ok: false, reason: "the IdP sign-in was completed by a different Okta account" } as const);

function harness(opts: { signer: string; jagClientId?: string; extra?: Record<string, unknown>; signingKey?: KeyObject; appRefuse?: string }) {
  const clock = { t: 1_900_000_000_000 };
  const declared = { now: providers(opts.extra) };
  const refusals: { principalSubject: string; reason: string }[] = [];
  const f = fakes({ signer: opts.signer, revoked: new Set(), jagClientId: opts.jagClientId ?? APP_CID, ...(opts.appRefuse ? { appRefuse: opts.appRefuse } : {}), ...(opts.signingKey ? { signingKey: opts.signingKey } : {}) });
  const vault = memVault();
  let state = 0;
  const oe = makeOeOauth(() => declared.now, {
    vault,
    recordRefusal: async (r) => {
      refusals.push({ principalSubject: r.principalSubject, reason: r.reason });
    },
    fetch: f.fetchImpl,
    now: () => clock.t,
    newState: () => `STATE-${++state}`,
    redirectUri: () => REDIRECT,
    resolveSecret: async (_broker, ref) => SECRETS[ref] ?? "",
    bindIdentity,
    sleep: async () => {
      await new Promise((r) => setImmediate(r));
      clock.t += 250;
    },
  });
  const signIn = async (subject: string, providerRef = "mcp-server/datadog") => {
    const { url } = await oe.flow.startAuthorization(providerRef, { subject: { type: "user", id: subject } }, {});
    const { state: st, code } = f.openAuthorizeUrl(url);
    return { url, result: await oe.completer({ state: st, code }) };
  };
  const mint = (subject: string, providerRef = "mcp-server/datadog") => oe.flow.mintUserToken(providerRef, { subject: { type: "user", id: subject } });
  return { clock, f, vault, oe, signIn, mint, declared, refusals };
}

{
  const cfg = providers().get("mcp-server/datadog") as OeOauthXaaProviderConfig;
  ok(cfg.mode === OE_OAUTH_MODE_XAA && cfg.idpClientSecretBroker === "db" && cfg.resourceClientSecretBroker === "db", "§1 an xaa declaration parses, both secret brokers default to db");
  const refuse = (extra: Record<string, unknown>, match: RegExp, label: string) => {
    let msg = "";
    try {
      loadOeOauthConfig(new Map([["x", { ...decl, ...extra }]]));
    } catch (e) {
      msg = e instanceof Error ? e.message : String(e);
    }
    ok(match.test(msg), `${label} (got ${JSON.stringify(msg)})`);
  };
  refuse({ idpClientSecret: "literal" }, /literal "idpClientSecret"/u, "§1 🔴 a literal IdP client secret is refused");
  refuse({ resourceClientSecret: "literal" }, /literal "resourceClientSecret"/u, "§1 🔴 a literal app client secret is refused");
  refuse({ idpIssuer: "http://acme.okta.com" }, /must use https/u, "§1 an http issuer is refused");
  refuse({ resourceTokenEndpoint: "http://auth.datadog.example/token" }, /must use https/u, "§1 an http app token endpoint is refused");
  refuse({ resourceClientId: undefined }, /resourceClientId must be a non-empty string/u, "§1 a missing app client id is refused, naming the field");
  ok(xaaNamesOrg("https://acme.okta.com", new Map([["mcp-server/datadog", decl]])), "§1 the Okta directory arm proposes own accounts when an xaa sign-in names its org");
  ok(!xaaNamesOrg("https://acme.okta.com", new Map([["notion", { mode: "discovery-dcr-pkce", resource: "https://mcp.notion.com/mcp" }]])), "§1 🔴 DARK: with no xaa declaration the arm proposes nothing new");
  ok(!xaaNamesOrg("https://other.okta.com", new Map([["mcp-server/datadog", decl]])), "§1 an xaa sign-in through another Okta org proposes nothing for this one");
}

{
  const h = harness({ signer: ALICE_OKTA });
  const first = await rejects(h.mint(ALICE), /user authorization required|has not authorized/u, "§2 before the sign-in, a mint asks the person to sign in");
  ok(h.oe.flow.isUserAuthRequired(first), "§2 that refusal classifies as user-auth-required (the person gets the sign-in link)");
  const { url, result } = await h.signIn(ALICE);
  const u = new URL(url);
  ok(u.searchParams.get("client_id") === IDP_CID && u.searchParams.get("scope") === "openid offline_access", "§2 the sign-in is an OIDC request to the IdP for openid + offline_access");
  ok(u.searchParams.get("code_challenge_method") === "S256" && (u.searchParams.get("nonce") ?? "") !== "", "§2 the sign-in carries PKCE and a nonce");
  ok(result.ok === true && result.connectionName === "mcp-server/datadog", "§2 the callback completes for the requester");
  ok(h.f.counts.leg1 === 0, "§2 the sign-in itself mints nothing — the first app token is minted on first use");

  const t1 = await h.mint(ALICE);
  ok(t1.token === `APP-AT-${ALICE_OKTA}-${APP_AS}-1`, "§2 ⭐ the mint runs both legs and returns the APP's token for the signed-in person");
  ok(h.f.counts.leg1 === 1 && h.f.counts.leg2 === 1, "§2 one mint = one ID-JAG + one JWT bearer grant");
  ok(h.f.counts.authCode === 1, "§2 no second authorization — no consent screen at the app");
  ok(![...h.vault.raw.values()].some((v) => v.includes("APP-RT-MUST-NOT-BE-STORED")), "§2 🔴 a refresh token the app returns is NOT stored — a re-mint is the only refresh");

  ok(await h.oe.flow.hasFreshGrant!("mcp-server/linear", { type: "user", id: ALICE }), "§2 a second xaa app reports a fresh grant before its first use");
  const t2 = await h.mint(ALICE, "mcp-server/linear");
  ok(t2.token.startsWith(`APP-AT-${ALICE_OKTA}-https://auth.linear.example`), "§2 ⭐ ONE sign-in serves the second app too, with no new sign-in");
  ok(h.f.counts.authCode === 1, "§2 still one sign-in in total");
  ok(h.f.leaked.length === 0, "§2 🔴 neither client secret ever rode a URL or a body");
  await rejects(h.oe.flow.mintServiceToken("mcp-server/datadog", {}), /acts only as a person/u, "§2 an xaa connection has no service account to mint for");
}

{
  const h = harness({ signer: ALICE_OKTA });
  await h.signIn(ALICE);
  const N = 6;
  const all = await Promise.all(Array.from({ length: N }, () => h.mint(ALICE)));
  ok(h.f.counts.leg1 === 1 && h.f.counts.leg2 === 1, `§3 ⭐ ${N} concurrent first mints ran exactly ONE mint (got leg1=${h.f.counts.leg1})`);
  ok(all.every((r) => r.token === all[0]!.token), "§3 every concurrent caller got the same token");
  h.clock.t += 30 * 60 * 1000;
  await h.mint(ALICE);
  ok(h.f.counts.leg1 === 1, "§3 a mint inside the token's lifetime reuses the cached token");
  h.clock.t += 31 * 60 * 1000;
  const renewed = await h.mint(ALICE);
  ok(h.f.counts.leg1 === 2 && renewed.token !== all[0]!.token, "§3 past expiry, exactly one new mint");
}

{
  const h = harness({ signer: ALICE_OKTA });
  await h.signIn(ALICE);
  const other = makeOeOauth(providers(), {
    vault: memVault(h.vault),
    fetch: h.f.fetchImpl,
    now: () => h.clock.t,
    redirectUri: () => REDIRECT,
    resolveSecret: async (_b, ref) => SECRETS[ref] ?? "",
    bindIdentity,
    sleep: async () => {
      await new Promise((r) => setTimeout(r, 1));
      h.clock.t += 250;
    },
  });
  const both = await Promise.all([h.mint(ALICE), other.flow.mintUserToken("mcp-server/datadog", { subject: { type: "user", id: ALICE } })]);
  ok(h.f.counts.leg1 === 1, `§3b ⭐ two processes minting at once ran exactly ONE ID-JAG mint (got ${h.f.counts.leg1})`);
  ok(both[0].token === both[1].token, "§3b the losing process adopted the winner's token");
}

{
  const revoked = new Set<string>();
  const f = fakes({ signer: ALICE_OKTA, revoked, jagClientId: APP_CID });
  const vault = memVault();
  const clock = { t: 1_900_000_000_000 };
  const oe = makeOeOauth(providers(), { vault, fetch: f.fetchImpl, now: () => clock.t, newState: () => "S4", redirectUri: () => REDIRECT, resolveSecret: async (_b, ref) => SECRETS[ref] ?? "", bindIdentity });
  const { url } = await oe.flow.startAuthorization("mcp-server/datadog", { subject: { type: "user", id: ALICE } }, {});
  const { state, code } = f.openAuthorizeUrl(url);
  await oe.completer({ state, code });
  const before = await oe.flow.mintUserToken("mcp-server/datadog", { subject: { type: "user", id: ALICE } });
  ok(before.token.startsWith("APP-AT-"), "§4 NEGATIVE CONTROL — the person mints while assigned");
  revoked.add(ALICE_OKTA);
  clock.t += 2 * 60 * 60 * 1000;
  const err = await rejects(oe.flow.mintUserToken("mcp-server/datadog", { subject: { type: "user", id: ALICE } }), /identity provider refused access \(access_denied\)/u, "§4 ⭐ a revoked person is refused at the next mint");
  ok(!oe.flow.isUserAuthRequired(err), "§4 🔴 the refusal is NOT user-auth-required: no 'connect my account' link for an admin revocation");
  ok((err as { code?: string }).code === "oe_oauth_access_removed", "§4 the refusal carries the access-removed code");
}

{
  const h = harness({ signer: ALICE_OKTA, jagClientId: "some-other-client" });
  await h.signIn(ALICE);
  const err = await rejects(h.mint(ALICE), /app refused access \(invalid_grant\)/u, "§5 ⭐ an ID-JAG whose client_id is not the authenticated client is refused");
  ok(!h.oe.flow.isUserAuthRequired(err), "§5 a new sign-in cannot fix it, so no sign-in link is offered");
  ok(!(await h.oe.flow.hasFreshGrant!("mcp-server/datadog", { type: "user", id: BOB })), "§5 negative: Bob has no grant");
}

{
  const h = harness({ signer: BOB_OKTA });
  const { result } = await h.signIn(ALICE);
  ok(result.ok === false && /different Okta account/u.test(result.ok === false ? (result.detail ?? "") : ""), "§6 ⭐ Bob's IdP account cannot complete Alice's link");
  ok(![...h.vault.raw.keys()].some((k) => k.startsWith("oe-oauth:xaa-idp:")), "§6 🔴 the refused sign-in stored NO IdP grant");
  ok(h.f.refreshOwner.size === 1, "§6 (the IdP did issue a refresh token — OE discarded it)");
  await rejects(h.mint(ALICE), /has not authorized/u, "§6 Alice still has no grant: her next mint asks her to sign in");
  const pend = [...h.vault.raw.entries()].find(([k]) => k.startsWith("oe-oauth:pend:"));
  ok(pend !== undefined && (JSON.parse(pend[1]) as { consumed?: boolean }).consumed === true, "§6 the refusal SPENT the link");
  const own = await h.signIn(BOB);
  ok(own.result.ok === true, "§6 NEGATIVE CONTROL — Bob's own link completes for Bob");
}

{
  const forged = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
  const h = harness({ signer: ALICE_OKTA, signingKey: forged });
  const { result } = await h.signIn(ALICE);
  ok(result.ok === false && /did not verify/u.test(result.ok === false ? (result.detail ?? "") : ""), "§7 🔴 an id token signed by another key is refused");
  ok(![...h.vault.raw.keys()].some((k) => k.startsWith("oe-oauth:xaa-idp:")), "§7 and nothing is stored");
  ok(h.refusals.length === 1 && h.refusals[0]!.principalSubject === ALICE && /did not verify/u.test(h.refusals[0]!.reason), "§7 🔴 the refused sign-in is AUDITED for the requester");
}

{
  const h = harness({ signer: ALICE_OKTA });
  await h.signIn(ALICE);
  await h.mint(ALICE);
  for (const rt of h.f.refreshOwner.keys()) h.f.revokedRefresh.add(rt);
  h.clock.t += 2 * 60 * 60 * 1000;
  const err = await rejects(h.mint(ALICE), /must re-authorize/u, "§4b leg-1 invalid_grant asks the person to sign in again");
  ok(h.oe.flow.isUserAuthRequired(err) && (err as { code?: string }).code === "oe_oauth_needs_reconsent", "§4b ⭐ it IS user-auth-required: the person gets a new sign-in link");

  const g = harness({ signer: ALICE_OKTA, appRefuse: "unauthorized_client" });
  await g.signIn(ALICE);
  const appErr = await rejects(g.mint(ALICE), /app refused access \(unauthorized_client\)/u, "§4b a leg-2 unauthorized_client is an app refusal");
  ok(!g.oe.flow.isUserAuthRequired(appErr), "§4b and it offers no sign-in link");
}

{
  const h = harness({ signer: ALICE_OKTA });
  await h.signIn(ALICE);
  await h.mint(ALICE);
  CONFIRMED[ALICE] = undefined;
  try {
    const cached = await h.mint(ALICE);
    ok(cached.token.startsWith("APP-AT-"), "§9 a cached token serves until it expires (the check runs per mint, not per read)");
    h.clock.t += 2 * 60 * 60 * 1000;
    const err = await rejects(h.mint(ALICE), /has not authorized/u, "§9 ⭐ after the link is revoked, the next mint refuses");
    ok(h.oe.flow.isUserAuthRequired(err), "§9 the person is asked to sign in again (and the sign-in will be refused until relinked)");
    ok(![...h.vault.raw.keys()].some((k) => k.startsWith("oe-oauth:xaa-idp:")), "§9 🔴 the stale IdP grant is deleted");
    ok(h.f.counts.leg1 === 1, "§9 no ID-JAG was minted for the unlinked person");
  } finally {
    CONFIRMED[ALICE] = ALICE_OKTA;
  }
}

{
  const h = harness({ signer: ALICE_OKTA });
  await h.signIn(ALICE);
  await h.mint(ALICE);
  h.clock.t += 2 * 60 * 60 * 1000;
  PLANE.unreadable = true;
  try {
    const err = await rejects(h.mint(ALICE), /could not be read/u, "§9b an unreadable link plane refuses the mint (fail closed)");
    ok(!h.oe.flow.isUserAuthRequired(err), "§9b it is NOT user-auth-required — the person has nothing to redo");
    ok([...h.vault.raw.keys()].some((k) => k.startsWith("oe-oauth:xaa-idp:")), "§9b 🔴 the grant SURVIVES an outage");
    ok(h.f.counts.leg1 === 1, "§9b no ID-JAG was minted while the plane was unreadable");
  } finally {
    PLANE.unreadable = false;
  }
  const after = await h.mint(ALICE);
  ok(after.token.startsWith("APP-AT-") && h.f.counts.leg1 === 2, "§9b once the plane answers, the next mint succeeds with no new sign-in");
}

{
  const h = harness({ signer: ALICE_OKTA });
  await h.vault.write(
    "oe-oauth:pend:OLD",
    JSON.stringify({ providerRef: "mcp-server/datadog", subject: { type: "user", id: ALICE }, pkceVerifier: "v", tokenEndpoint: "https://old.example/token", clientId: "old", resource: "https://old.example/mcp", redirectUri: REDIRECT, createdAt: h.clock.t, expiresAt: h.clock.t + 60_000 }),
  );
  const r = await h.oe.completer({ state: "OLD", code: "C" });
  ok(r.ok === false && /now declares "xaa"/u.test(r.ok === false ? (r.detail ?? "") : ""), "§10 ⭐ a discovery-stamped pending row is refused once the config declares xaa");
  ok(![...h.vault.raw.keys()].some((k) => k.startsWith("oe-oauth:tok:")), "§10 and no token is stored for the xaa connection");
}

{
  const h = harness({ signer: ALICE_OKTA });
  await h.signIn(ALICE);
  h.f.signerIs(BOB_OKTA);
  await h.signIn(BOB);
  const grantRows = () => [...h.vault.raw.keys()].filter((k) => k.startsWith("oe-oauth:xaa-idp:"));
  ok(grantRows().length === 2, "§11 setup: Alice and Bob each hold an IdP grant");
  h.declared.now = new Map();
  const purged = await h.oe.purge.purgeSubject(ALICE);
  ok(purged === 1, "§11 🔴 the orphaned IdP grant is deleted by the purge");
  ok(grantRows().length === 1 && grantRows()[0]!.endsWith(`:user:${BOB}`), "§11 NEGATIVE CONTROL — Bob's grant survives Alice's purge");
  const crafted = `oe-oauth:xaa-idp:${"a".repeat(32)}:user:X:user:${ALICE}`;
  await h.vault.write(crafted, "{}");
  await h.oe.purge.purgeSubject(ALICE);
  ok(h.vault.raw.has(crafted), "§11 🔴 a subject key that only ends with Alice's is NOT purged as Alice's");
}

{
  const v = memVault();
  await v.write("oe-oauth:tok:notion:user:U1", "{}");
  const broken: EncryptedKvVault = { ...v, read: async () => { throw new Error("undecryptable envelope"); } };
  const plain = loadOeOauthConfig(new Map([["notion", { resource: "https://mcp.notion.com/mcp" }]]))!;
  const oe = makeOeOauth(plain, { vault: broken });
  await rejects(oe.purge.purgeSubject("U1"), /undecryptable envelope/u, "§12 🔴 when every provider's purge fails, the purge REJECTS — it never reports 0 as success");
}

{
  const h = harness({ signer: ALICE_OKTA });
  await h.signIn(ALICE);
  await h.mint(ALICE);
  await h.mint(ALICE, "mcp-server/linear");
  const purged = await h.oe.purge.purgeSubject(ALICE);
  ok(purged === 3, `§8 the purge removes both app tokens and the IdP grant (got ${purged})`);
  ok(h.f.counts.revoke === 1 && h.f.revokedRefresh.size === 1, "§8 ⭐ the IdP refresh token is revoked at the IdP, once");
  ok(![...h.vault.raw.keys()].some((k) => k.startsWith("oe-oauth:tok:") || k.startsWith("oe-oauth:xaa-idp:")), "§8 no token row is left");
}

console.log(`✓ oe-oauth-xaa: ${n} assertions passed`);
rmSync(dir, { recursive: true, force: true });
process.exit(0);
