import {
  makeAwsSsoMinter,
  makeAwsSsoLinkStore,
  makeAwsSsoPurgeHook,
  awsSsoTokenRef,
  parseRoleArn,
  isAwsSsoLinkRequired,
  idTokenSubject,
  AwsSsoLinkRequiredError,
  type AwsSsoPendingStore,
} from "../agent/aws/sso.js";
import type { AwsIdentityRequest, AwsSsoLinkStore, EncryptedKvVault } from "@open-everywhere/core/agent/adapter-api.js";
import { overrideSettingsForTest, resetSettingsForTest } from "@open-everywhere/core/agent/adapter-api.js";
import { awsAccessEnabled, loadAwsSsoConfig } from "../agent/aws/config.js";

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

const ALICE = "p:acme/slack/U_ALICE";
const ALICE_OTHER_ORG = "p:other/slack/U_ALICE";
const ALICE_OTHER_PLATFORM = "p:acme/discord/U_ALICE";

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

const ALICE_AWS_SUB = "94482408-0011-7098-abcd-1e4f2c9b0000";
const BOB_AWS_SUB = "94482408-0011-7098-abcd-1e4f2c9b1111";

function fakeIdToken(claims: Record<string, unknown>): string {
  const seg = (o: unknown) => Buffer.from(JSON.stringify(o), "utf8").toString("base64url");
  return `${seg({ alg: "RS256", typ: "JWT" })}.${seg(claims)}.not-a-signature`;
}

function bindOnly(allowed: string) {
  return async (input: { readonly principalSubject: string; readonly signerSubject: string | undefined }) =>
    input.signerSubject === undefined
      ? ({ ok: false, reason: "the AWS sign-in named no signer" } as const)
      : input.signerSubject === allowed
        ? ({ ok: true, awsNativeId: allowed } as const)
        : ({ ok: false, reason: "the AWS sign-in was completed by a different Identity Center account" } as const);
}

function tokenBlob(
  over: Partial<{ accessToken: string; refreshToken: string; expiresAtMs: number; identityCenterSubject: string | null }> = {},
): string {
  return JSON.stringify({
    accessToken: over.accessToken ?? "sso-access-token",
    ...(over.refreshToken !== undefined ? { refreshToken: over.refreshToken } : {}),
    ...(over.expiresAtMs !== undefined ? { expiresAtMs: over.expiresAtMs } : {}),
    region: REGION,
    obtainedAtMs: 1_000,
    ...(over.identityCenterSubject === null ? {} : { identityCenterSubject: over.identityCenterSubject ?? ALICE_AWS_SUB }),
  });
}

const meReq: AwsIdentityRequest = {
  kind: "user-sso",
  roleArn: "arn:aws:iam::123456789012:role/oe-ops",
  region: REGION,
  roleSessionName: "oe-U_ALICE",
  principalSubject: ALICE,
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
  const store = memStore({ [ALICE]: tokenBlob({ expiresAtMs: Date.now() + 3600_000 }) });
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
  const store = memStore({ [ALICE]: tokenBlob({ accessToken: "stale-access", refreshToken: "refresh-1", expiresAtMs: Date.now() - 1000 }) });
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
  const stored = JSON.parse(store.rows.get(ALICE)!);
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
  ok(pend.principalSubject === ALICE && typeof pend.verifier === "string" && pend.verifier.length > 0, "unlinked: the pending row keys on the acting principal + holds the PKCE verifier server-side");
  ok(!(caught as AwsSsoLinkRequiredError).message.includes(pend.verifier), "unlinked: the error message (with the authorize URL) never leaks the secret PKCE verifier (only the S256 challenge is public)");
  ok(portalHit === false, "unlinked: no portal call is attempted");
}

{
  const store = memStore({ [ALICE]: tokenBlob({ expiresAtMs: Date.now() + 3600_000 }) });
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
  const store = memStore({ [ALICE]: tokenBlob({ expiresAtMs: Date.now() + 3600_000 }) });
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
    bindIdentity: bindOnly(ALICE_AWS_SUB),
    fetch: (async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith("/token")) {
        const form = new URLSearchParams(String(init?.body ?? ""));
        ok(form.get("grant_type") === "authorization_code", "roundtrip: completeLink exchanges an authorization_code");
        ok(form.get("code") === "auth-code-xyz", "roundtrip: the code is presented");
        ok(!!form.get("code_verifier"), "roundtrip: the PKCE verifier is presented at exchange");
        return new Response(
          JSON.stringify({ access_token: "linked-access", refresh_token: "linked-refresh", expires_in: 3600, id_token: fakeIdToken({ sub: ALICE_AWS_SUB }) }),
          { status: 200 },
        );
      }
      if (u.includes("/federation/credentials")) return new Response(portalCredsJson(exp), { status: 200 });
      throw new Error(`unexpected fetch to ${u}`);
    }) as typeof fetch,
  });

  const { url } = await minter.startLink(ALICE);
  ok(new URL(url).searchParams.get("state") === "STATE_RT", "roundtrip: startLink returns the authorize URL");
  ok(pending.rows.has("STATE_RT"), "roundtrip: startLink wrote the pending row");

  const done = await minter.completeLink("STATE_RT", "auth-code-xyz");
  ok(done.principalSubject === ALICE, "roundtrip: completeLink resolves the pending principal");
  ok(store.rows.has(ALICE), "roundtrip: completeLink stored the token for that principal");
  const rec = JSON.parse(store.rows.get(ALICE)!);
  ok(rec.accessToken === "linked-access" && rec.refreshToken === "linked-refresh", "roundtrip: the stored token is the exchanged one");
  ok(rec.identityCenterSubject === ALICE_AWS_SUB, "roundtrip: the stored record RECORDS which Identity Center account it is bound to");
  const pend = JSON.parse(pending.rows.get("STATE_RT")!);
  ok(pend.consumed === true && pend.verifier === "", "roundtrip: the pending row is consumed single-use + the verifier scrubbed");

  const creds = await minter.mint(meReq);
  ok(creds.accessKeyId === "ASIASSOROLE", "roundtrip: a mint after linking yields creds");
}

{
  const writes: { ref: string; value: string }[] = [];
  const reads: string[] = [];
  const fakeVault: EncryptedKvVault = {
    async read(ref) {
      reads.push(ref);
      const hit = writes.findLast((w) => w.ref === ref);
      return hit ? hit.value : null;
    },
    async write(ref, plaintext) {
      writes.push({ ref, value: plaintext });
    },
    async delete(ref) {
      const had = writes.some((w) => w.ref === ref);
      for (let i = writes.length - 1; i >= 0; i--) if (writes[i].ref === ref) writes.splice(i, 1);
      return had;
    },
    async listRefs(refPrefix) {
      if (!refPrefix) throw new Error("encryptedKvVault.listRefs: a non-empty ref prefix is required — this interface cannot enumerate the whole credential store.");
      return [...new Set(writes.map((w) => w.ref))].filter((r) => r.startsWith(refPrefix)).sort();
    },
    async withLock(_key, fn) {
      return fn();
    },
    async claim() {
      return true;
    },
    async releaseClaim() {},
  };
  const store = makeAwsSsoLinkStore(fakeVault);

  await store.write(ALICE, "blob-alice");
  ok(writes.length === 1 && writes[0].ref === `aws-sso:tok:${ALICE}`, "vault ref: the token row is `aws-sso:tok:<qualified-subject>` — the subject rides in VERBATIM");
  ok(writes[0].ref.includes("p:acme/slack/"), "vault ref: 🔴 the ref carries the org + platform qualifier, not a bare `U_ALICE`");
  ok((await store.read(ALICE)) === "blob-alice", "vault ref: the qualified subject reads its own row back");
  ok((await store.read("U_ALICE")) === null, "vault ref: 🔴 the PRE-OPE-286 bare-id ref reads NOTHING — old rows orphan (re-consent) and no fallback read re-opens the collision");
  ok((await store.read(ALICE_OTHER_ORG)) === null, "vault ref: 🔴 the same native id in another ORG addresses a different row");
  ok((await store.read(ALICE_OTHER_PLATFORM)) === null, "vault ref: 🔴 the same native id on another PLATFORM addresses a different row");
  ok(reads.every((r) => r.startsWith("aws-sso:tok:")), "vault ref: every read goes through the one ref composer (no second spelling)");

  const purge = makeAwsSsoPurgeHook(fakeVault);
  await store.write(ALICE, "blob-alice");
  await store.write(ALICE_OTHER_ORG, "blob-other-org");
  ok((await purge.purgeSubject(ALICE)) === 1, "G3 purge: the hook destroys the principal's SSO token row and reports 1");
  ok((await store.read(ALICE)) === null, "🔴 G3 purge: the row is GONE — a real delete, not the link store's clear() (which writes an empty string and leaves the row)");
  ok((await store.read(ALICE_OTHER_ORG)) === "blob-other-org", "🔴 G3 purge: another subject's row is untouched (subject-scoped, through the one ref composer)");
  ok((await purge.purgeSubject(ALICE)) === 0, "G3 purge: a second purge of the same subject reports 0 (idempotent, as the hook contract requires)");
  ok(awsSsoTokenRef(ALICE) === `aws-sso:tok:${ALICE}`, "G3 purge: store and purge share ONE exported ref composer — they cannot drift onto different rows");
}

{
  const store = memStore({
    [ALICE]: tokenBlob({ accessToken: "token-acme-slack", expiresAtMs: Date.now() + 3600_000 }),
    [ALICE_OTHER_ORG]: tokenBlob({ accessToken: "token-other-org", expiresAtMs: Date.now() + 3600_000 }),
    [ALICE_OTHER_PLATFORM]: tokenBlob({ accessToken: "token-acme-discord", expiresAtMs: Date.now() + 3600_000 }),
  });
  const bearers: (string | null)[] = [];
  const minter = makeAwsSsoMinter({
    region: REGION,
    clientId: CLIENT_ID,
    store,
    pending: memPending(),
    fetch: (async (url: string, init?: RequestInit) => {
      if (!String(url).includes("/federation/credentials")) throw new Error(`unexpected fetch to ${String(url)}`);
      bearers.push(((init?.headers as Record<string, string>) ?? {})["x-amz-sso_bearer_token"] ?? null);
      return new Response(portalCredsJson(Date.now() + 3600_000), { status: 200 });
    }) as typeof fetch,
  });

  await minter.mint({ ...meReq, principalSubject: ALICE });
  await minter.mint({ ...meReq, principalSubject: ALICE_OTHER_ORG });
  await minter.mint({ ...meReq, principalSubject: ALICE_OTHER_PLATFORM });
  ok(bearers.length === 3, "warm: 🔴 three subjects sharing ONE native id mint THREE times — the cache key separates them (a shared key would have served the first caller's live creds to the other two)");
  ok(new Set(bearers).size === 3, "warm: …and each mint presented that subject's OWN linked SSO token, so no caller borrowed another's Identity Center session");

  await minter.mint({ ...meReq, principalSubject: ALICE });
  ok(bearers.length === 3, "warm: a repeat mint for the SAME subject inside the TTL still reuses its entry — separation did not defeat the cache");
}

function linkMinter(idTokenClaims: Record<string, unknown> | undefined) {
  const store = memStore();
  const pending = memPending();
  const minter = makeAwsSsoMinter({
    region: REGION,
    clientId: CLIENT_ID,
    store,
    pending,
    newState: () => "STATE_BIND",
    bindIdentity: bindOnly(ALICE_AWS_SUB),
    fetch: (async (url: string) => {
      if (String(url).endsWith("/token")) {
        return new Response(
          JSON.stringify({
            access_token: "linked-access",
            expires_in: 3600,
            ...(idTokenClaims ? { id_token: fakeIdToken(idTokenClaims) } : {}),
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch to ${String(url)}`);
    }) as typeof fetch,
  });
  return { minter, store, pending };
}

{
  const { minter, store, pending } = linkMinter({ sub: BOB_AWS_SUB });
  await minter.startLink(ALICE);
  let caught: unknown;
  try {
    await minter.completeLink("STATE_BIND", "auth-code-xyz");
  } catch (e) {
    caught = e;
  }
  ok(caught instanceof Error, "bind-mismatch: a sign-in by a DIFFERENT Identity Center account is REFUSED");
  ok(caught instanceof Error && /different Identity Center account/u.test(caught.message), "bind-mismatch: the refusal names the axis that failed");
  ok(store.rows.size === 0, "🔴 bind-mismatch: NO token is stored — a refused completion leaves nothing behind for the requester to spend");
  const pend = JSON.parse(pending.rows.get("STATE_BIND")!);
  ok(pend.consumed === true && pend.verifier === "", "bind-mismatch: the opened link is SPENT — the forwarder gets no second attempt at the same capability");
}

{
  const { minter, store } = linkMinter({ sub: ALICE_AWS_SUB });
  await minter.startLink(ALICE);
  const done = await minter.completeLink("STATE_BIND", "auth-code-xyz");
  ok(done.principalSubject === ALICE, "bind-match: the requester's OWN sign-in completes the link");
  ok(JSON.parse(store.rows.get(ALICE)!).identityCenterSubject === ALICE_AWS_SUB, "bind-match: the stored record names the account it was bound to");
}

{
  const asked: (string | undefined)[] = [];
  const store = memStore();
  const minter = makeAwsSsoMinter({
    region: REGION,
    clientId: CLIENT_ID,
    store,
    pending: memPending(),
    newState: () => "STATE_BIND",
    bindIdentity: async (input) => {
      asked.push(input.signerSubject);
      return { ok: false, reason: "the AWS sign-in named no signer" };
    },
    fetch: (async () => new Response(JSON.stringify({ access_token: "linked-access", expires_in: 3600 }), { status: 200 })) as typeof fetch,
  });
  await minter.startLink(ALICE);
  let caught: unknown;
  try {
    await minter.completeLink("STATE_BIND", "auth-code-xyz");
  } catch (e) {
    caught = e;
  }
  ok(caught instanceof Error && /no id-token subject/u.test(caught.message), "bind-no-idtoken: a response naming no signer is refused, and points at the OIDC client");
  ok(asked.length === 1 && asked[0] === undefined, "🔴 bind-no-idtoken: the binding check IS ASKED with an absent signer, so the refusal is audited like every other");
  ok(store.rows.size === 0, "bind-no-idtoken: nothing is stored");
}

{
  const { minter } = linkMinter({ aud: CLIENT_ID });
  await minter.startLink(ALICE);
  let caught: unknown;
  try {
    await minter.completeLink("STATE_BIND", "auth-code-xyz");
  } catch (e) {
    caught = e;
  }
  ok(caught instanceof Error && /no id-token subject/u.test(caught.message), "bind-no-sub: an id-token carrying no `sub` names nobody — refused");
}

{
  const store = memStore({ [ALICE]: tokenBlob({ expiresAtMs: Date.now() + 3600_000, identityCenterSubject: null }) });
  const minter = makeAwsSsoMinter({
    region: REGION,
    clientId: CLIENT_ID,
    store,
    pending: memPending(),
    fetch: (async () => {
      throw new Error("legacy-row: no network call may be made for an unproven row");
    }) as typeof fetch,
  });
  let caught: unknown;
  try {
    await minter.mint(meReq);
  } catch (e) {
    caught = e;
  }
  ok(isAwsSsoLinkRequired(caught), "legacy-row: a record written before the binding check is UNPROVEN — the mint demands a fresh link");
  ok(caught instanceof Error && /predates the identity check/u.test(caught.message), "legacy-row: the person is told why they must link again");
  ok(!store.rows.has(ALICE), "🔴 legacy-row: the unproven row is DESTROYED, not merely declined — it held a live, refreshable session that may be another human's");
}

{
  ok(idTokenSubject(fakeIdToken({ sub: ALICE_AWS_SUB })) === ALICE_AWS_SUB, "idTokenSubject: reads `sub` from the payload segment");
  ok(idTokenSubject(undefined) === undefined, "idTokenSubject: undefined in, undefined out");
  ok(idTokenSubject("not.a.jwt") === undefined, "idTokenSubject: a non-base64url payload yields nothing rather than throwing");
  ok(idTokenSubject("only.two") === undefined, "idTokenSubject: a value that is not three segments is not an id-token");
  ok(idTokenSubject(fakeIdToken({ sub: "" })) === undefined, "idTokenSubject: an EMPTY `sub` names nobody");
  ok(idTokenSubject(fakeIdToken({ sub: 42 })) === undefined, "idTokenSubject: a non-string `sub` names nobody");
  ok(idTokenSubject(fakeIdToken(["not", "an", "object"] as unknown as Record<string, unknown>)) === undefined, "idTokenSubject: a non-object payload names nobody");
}

{
  const pending = memPending();
  const minter = makeAwsSsoMinter({ region: REGION, clientId: CLIENT_ID, store: memStore(), pending, newState: () => "STATE_SCOPE" });
  const { url } = await minter.startLink(ALICE);
  const scope = new URL(url).searchParams.get("scope") ?? "";
  ok(scope.split(" ").includes("openid"), "🔴 scopes: the default link requests `openid` — without it the token response carries no id-token and every completion refuses");
  ok(scope.split(" ").includes("sso:account:access"), "scopes: the portal scope is still requested");

  const strictPending = memPending();
  const noOpenId = makeAwsSsoMinter({ region: REGION, clientId: CLIENT_ID, scopes: ["sso:account:access"], store: memStore(), pending: strictPending });
  let caught: unknown;
  try {
    await noOpenId.startLink(ALICE);
  } catch (e) {
    caught = e;
  }
  ok(caught instanceof Error && /omit "openid"/u.test(caught.message), "🔴 scopes: a scope override without `openid` refuses the LINK, so nobody signs in to a flow that can never complete");
  ok(strictPending.rows.size === 0, "scopes: the refused link wrote no pending row — it fails before any state is created");
}

{
  resetSettingsForTest();
  ok(awsAccessEnabled() === false, "aws.enabled: shipped OFF — the plane stays inert with nothing declared");
  ok(loadAwsSsoConfig().scopes === undefined, "aws.ssoScopes: shipped EMPTY ⇒ no override, the minter's default (with openid) applies");
  overrideSettingsForTest({ aws: { enabled: true, ssoScopes: ["sso:account:access", "openid", "extra:scope"] } });
  ok(awsAccessEnabled() === true, "aws.enabled: a registered true arms the plane");
  ok(JSON.stringify(loadAwsSsoConfig().scopes) === JSON.stringify(["sso:account:access", "openid", "extra:scope"]), "aws.ssoScopes: the registered list is what the link asks for");
  resetSettingsForTest();
  ok(awsAccessEnabled() === false && loadAwsSsoConfig().scopes === undefined, "…and a reset returns both to the shipped values (read per call, not latched)");
}

console.log(`✓ aws-sso: ${passed} assertions passed (mint happy path + parse + refresh + unlinked/not-entitled/re-link + warm cache + link roundtrip + OPE-286 qualified-subject keying + OPE-300 purge hook + OPE-1955 signer binding)`);
