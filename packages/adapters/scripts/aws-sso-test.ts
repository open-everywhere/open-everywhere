import {
  makeAwsSsoMinter,
  parseRoleArn,
  isAwsSsoLinkRequired,
  AwsSsoLinkRequiredError,
  type AwsSsoPendingStore,
} from "../agent/aws/sso.js";
import type { AwsIdentityRequest, AwsSsoLinkStore } from "@open-everywhere/core/agent/adapter-api.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

const REGION = "eu-west-2";
const CLIENT_ID = "oe-sso-public-client";
process.env.OE_PUBLIC_BASE_URL = "https://oe.example.com";

function memStore(seed?: Record<string, string>): AwsSsoLinkStore & { rows: Map<string, string> } {
  const rows = new Map<string, string>(Object.entries(seed ?? {}));
  return {
    rows,
    async read(p) {
      return rows.has(p) ? rows.get(p)! : null;
    },
    async write(p, t) {
      rows.set(p, t);
    },
    async clear(p) {
      rows.delete(p);
    },
  };
}
function memPending(): AwsSsoPendingStore & { rows: Map<string, string> } {
  const rows = new Map<string, string>();
  return {
    rows,
    async read(s) {
      return rows.has(s) ? rows.get(s)! : null;
    },
    async write(s, v) {
      rows.set(s, v);
    },
  };
}

function tokenBlob(over: Partial<{ accessToken: string; refreshToken: string; expiresAtMs: number }> = {}): string {
  return JSON.stringify({
    accessToken: over.accessToken ?? "sso-access-token",
    ...(over.refreshToken !== undefined ? { refreshToken: over.refreshToken } : {}),
    ...(over.expiresAtMs !== undefined ? { expiresAtMs: over.expiresAtMs } : {}),
    region: REGION,
    obtainedAtMs: 1_000,
  });
}

const meReq: AwsIdentityRequest = {
  kind: "user-sso",
  roleArn: "arn:aws:iam::123456789012:role/oe-ops",
  region: REGION,
  roleSessionName: "oe-U_ALICE",
  principalId: "U_ALICE",
};

function portalCredsJson(expirationMs: number): string {
  return JSON.stringify({
    roleCredentials: {
      accessKeyId: "ASIASSOROLE",
      secretAccessKey: "sso/role+secret",
      sessionToken: "SsoRoleSession==",
      expiration: expirationMs,
    },
  });
}

{
  const a = parseRoleArn("arn:aws:iam::123456789012:role/oe-ops");
  ok(a.accountId === "123456789012" && a.roleName === "oe-ops", "parseRoleArn: account id + role name");
  const b = parseRoleArn("arn:aws:iam::999999999999:role/team/path/oe-nested");
  ok(b.accountId === "999999999999" && b.roleName === "team/path/oe-nested", "parseRoleArn: a path-bearing role name is preserved");
  let threw = "";
  try {
    parseRoleArn("not-an-arn");
  } catch (e) {
    threw = String(e);
  }
  ok(threw.includes("is not an IAM role ARN"), "parseRoleArn: a non-role ARN throws");
}

{
  const store = memStore({ U_ALICE: tokenBlob({ expiresAtMs: Date.now() + 3600_000 }) });
  const portalCalls: string[] = [];
  const bearerSeen: (string | null)[] = [];
  const exp = Date.now() + 3600_000;
  const minter = makeAwsSsoMinter({
    region: REGION,
    clientId: CLIENT_ID,
    store,
    pending: memPending(),
    fetch: (async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/federation/credentials")) {
        portalCalls.push(u);
        bearerSeen.push(((init?.headers as Record<string, string>) ?? {})["x-amz-sso_bearer_token"] ?? null);
        return new Response(portalCredsJson(exp), { status: 200 });
      }
      throw new Error(`unexpected fetch to ${u}`);
    }) as typeof fetch,
  });

  const creds = await minter.mint(meReq);
  ok(creds.accessKeyId === "ASIASSOROLE", "mint: parsed AccessKeyId from GetRoleCredentials");
  ok(creds.secretAccessKey === "sso/role+secret", "mint: parsed SecretAccessKey");
  ok(creds.sessionToken === "SsoRoleSession==", "mint: parsed SessionToken");
  ok(creds.expiresAtMs === exp, "mint: portal expiration (epoch ms) → expiresAtMs");
  ok(portalCalls.length === 1, "mint: exactly one GetRoleCredentials call");
  ok(portalCalls[0].includes("account_id=123456789012"), "mint: portal GET carries account_id parsed from the roleArn");
  ok(portalCalls[0].includes("role_name=oe-ops"), "mint: portal GET carries role_name parsed from the roleArn");
  ok(portalCalls[0].startsWith("https://portal.sso.eu-west-2.amazonaws.com/federation/credentials"), "mint: portal endpoint is region-scoped");
  ok(bearerSeen[0] === "sso-access-token", "mint: the SSO access token rides the x-amz-sso_bearer_token HEADER");
  ok(!portalCalls[0].includes("sso-access-token"), "mint: the SSO access token is NEVER on the query string");

  const creds2 = await minter.mint(meReq);
  ok(creds2.accessKeyId === creds.accessKeyId, "warm: second mint returns the same creds");
  ok(portalCalls.length === 1, "warm: second mint inside TTL does NOT re-call GetRoleCredentials");
}

{
  const store = memStore({ U_ALICE: tokenBlob({ accessToken: "stale-access", refreshToken: "refresh-1", expiresAtMs: Date.now() - 1000 }) });
  const tokenCalls: string[] = [];
  let portalBearer: string | null = null;
  const minter = makeAwsSsoMinter({
    region: REGION,
    clientId: CLIENT_ID,
    store,
    pending: memPending(),
    fetch: (async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith("/token")) {
        tokenCalls.push(String(init?.body ?? ""));
        return new Response(JSON.stringify({ access_token: "fresh-access", refresh_token: "refresh-2", expires_in: 3600 }), { status: 200 });
      }
      if (u.includes("/federation/credentials")) {
        portalBearer = ((init?.headers as Record<string, string>) ?? {})["x-amz-sso_bearer_token"] ?? null;
        return new Response(portalCredsJson(Date.now() + 3600_000), { status: 200 });
      }
      throw new Error(`unexpected fetch to ${u}`);
    }) as typeof fetch,
  });

  const creds = await minter.mint(meReq);
  ok(creds.accessKeyId === "ASIASSOROLE", "refresh: mint still yields creds after a refresh");
  ok(tokenCalls.length === 1, "refresh: exactly one OIDC token (refresh) call");
  const form = new URLSearchParams(tokenCalls[0]);
  ok(form.get("grant_type") === "refresh_token", "refresh: grant_type=refresh_token");
  ok(form.get("refresh_token") === "refresh-1", "refresh: presents the stored refresh token");
  ok(form.get("client_id") === CLIENT_ID, "refresh: carries the public client id");
  ok(portalBearer === "fresh-access", "refresh: GetRoleCredentials uses the REFRESHED access token");
  const stored = JSON.parse(store.rows.get("U_ALICE")!);
  ok(stored.accessToken === "fresh-access" && stored.refreshToken === "refresh-2", "refresh: the rotated token is re-stored");
}

{
  const store = memStore();
  const pending = memPending();
  let portalHit = false;
  const minter = makeAwsSsoMinter({
    region: REGION,
    clientId: CLIENT_ID,
    store,
    pending,
    newState: () => "STATE123",
    fetch: (async (url: string) => {
      if (String(url).includes("/federation/credentials")) portalHit = true;
      throw new Error(`unexpected fetch to ${String(url)}`);
    }) as typeof fetch,
  });

  let caught: unknown;
  try {
    await minter.mint(meReq);
  } catch (e) {
    caught = e;
  }
  ok(caught instanceof AwsSsoLinkRequiredError, "unlinked: mint throws AwsSsoLinkRequiredError");
  ok(isAwsSsoLinkRequired(caught), "unlinked: isAwsSsoLinkRequired classifies it");
  const url = (caught as AwsSsoLinkRequiredError).authorizationUrl;
  ok(url.startsWith("https://oidc.eu-west-2.amazonaws.com/authorize?"), "unlinked: the authorize URL is the region OIDC endpoint");
  const q = new URL(url).searchParams;
  ok(q.get("response_type") === "code", "unlinked: authorize URL is response_type=code (auth-code flow)");
  ok(q.get("client_id") === CLIENT_ID, "unlinked: authorize URL carries the public client id");
  ok(q.get("code_challenge_method") === "S256", "unlinked: authorize URL uses PKCE S256");
  ok(!!q.get("code_challenge"), "unlinked: authorize URL carries a code_challenge");
  ok(q.get("redirect_uri") === "https://oe.example.com/oauth/v1/aws-sso/callback", "unlinked: authorize URL carries the OE callback redirect_uri");
  ok(q.get("state") === "STATE123", "unlinked: authorize URL carries the opaque state");
  ok(pending.rows.has("STATE123"), "unlinked: a pending row was written keyed by the state");
  const pend = JSON.parse(pending.rows.get("STATE123")!);
  ok(pend.principalId === "U_ALICE" && typeof pend.verifier === "string" && pend.verifier.length > 0, "unlinked: the pending row keys on the acting principal + holds the PKCE verifier server-side");
  ok(!(caught as AwsSsoLinkRequiredError).message.includes(pend.verifier), "unlinked: the error message (with the authorize URL) never leaks the secret PKCE verifier (only the S256 challenge is public)");
  ok(portalHit === false, "unlinked: no portal call is attempted");
}

{
  const store = memStore({ U_ALICE: tokenBlob({ expiresAtMs: Date.now() + 3600_000 }) });
  const minter = makeAwsSsoMinter({
    region: REGION,
    clientId: CLIENT_ID,
    store,
    pending: memPending(),
    fetch: (async (url: string) => {
      if (String(url).includes("/federation/credentials")) return new Response(JSON.stringify({ message: "Forbidden" }), { status: 403 });
      throw new Error(`unexpected fetch to ${String(url)}`);
    }) as typeof fetch,
  });
  let caught: unknown;
  try {
    await minter.mint(meReq);
  } catch (e) {
    caught = e;
  }
  ok(caught instanceof Error && !isAwsSsoLinkRequired(caught), "not-entitled: a 403 is a hard fail, NOT link-required");
  ok(String(caught).includes("not entitled") && String(caught).includes("Fail-closed"), "not-entitled: the error names the entitlement denial + fails closed");
}

{
  const store = memStore({ U_ALICE: tokenBlob({ expiresAtMs: Date.now() + 3600_000 }) });
  const minter = makeAwsSsoMinter({
    region: REGION,
    clientId: CLIENT_ID,
    store,
    pending: memPending(),
    fetch: (async (url: string) => {
      if (String(url).includes("/federation/credentials")) return new Response("", { status: 401 });
      throw new Error(`unexpected fetch to ${String(url)}`);
    }) as typeof fetch,
  });
  let caught: unknown;
  try {
    await minter.mint(meReq);
  } catch (e) {
    caught = e;
  }
  ok(isAwsSsoLinkRequired(caught), "token-rejected: a portal 401 classifies as link-required (re-link)");
  ok(!!(caught as AwsSsoLinkRequiredError).authorizationUrl, "token-rejected: the re-link error carries a fresh authorize URL");
}

{
  const store = memStore();
  const pending = memPending();
  const exp = Date.now() + 3600_000;
  const minter = makeAwsSsoMinter({
    region: REGION,
    clientId: CLIENT_ID,
    store,
    pending,
    newState: () => "STATE_RT",
    fetch: (async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith("/token")) {
        const form = new URLSearchParams(String(init?.body ?? ""));
        ok(form.get("grant_type") === "authorization_code", "roundtrip: completeLink exchanges an authorization_code");
        ok(form.get("code") === "auth-code-xyz", "roundtrip: the code is presented");
        ok(!!form.get("code_verifier"), "roundtrip: the PKCE verifier is presented at exchange");
        return new Response(JSON.stringify({ access_token: "linked-access", refresh_token: "linked-refresh", expires_in: 3600 }), { status: 200 });
      }
      if (u.includes("/federation/credentials")) return new Response(portalCredsJson(exp), { status: 200 });
      throw new Error(`unexpected fetch to ${u}`);
    }) as typeof fetch,
  });

  const { url } = await minter.startLink("U_ALICE");
  ok(new URL(url).searchParams.get("state") === "STATE_RT", "roundtrip: startLink returns the authorize URL");
  ok(pending.rows.has("STATE_RT"), "roundtrip: startLink wrote the pending row");

  const done = await minter.completeLink("STATE_RT", "auth-code-xyz");
  ok(done.principalId === "U_ALICE", "roundtrip: completeLink resolves the pending principal");
  ok(store.rows.has("U_ALICE"), "roundtrip: completeLink stored the token for that principal");
  const rec = JSON.parse(store.rows.get("U_ALICE")!);
  ok(rec.accessToken === "linked-access" && rec.refreshToken === "linked-refresh", "roundtrip: the stored token is the exchanged one");
  const pend = JSON.parse(pending.rows.get("STATE_RT")!);
  ok(pend.consumed === true && pend.verifier === "", "roundtrip: the pending row is consumed single-use + the verifier scrubbed");

  const creds = await minter.mint(meReq);
  ok(creds.accessKeyId === "ASIASSOROLE", "roundtrip: a mint after linking yields creds");
}

console.log(`✓ aws-sso: ${passed} assertions passed (mint happy path + parse + refresh + unlinked/not-entitled/re-link + warm cache + link roundtrip)`);
