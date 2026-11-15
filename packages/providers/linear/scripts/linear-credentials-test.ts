// proves: linear.token_mint_failed

import {
  _resetLinearMintCache,
  linearAppActorCredentials,
  linearAppForOrg,
  linearAppRegistry,
  linearCredentialsConfigured,
  linearCredentialsForOrg,
  mintLinearAppActorToken,
  primaryLinearOrganizationId,
  resolveLinearAccessTokenForOrg,
  resolveLinearAccessTokenSeam,
  staticLinearToken,
  type LinearMintFetch,
} from "../agent/channels/linear-credentials.js";
import { readAudit, deploymentOrg, getSettings, overrideSettingsForTest, RateLimitExhaustedError } from "@open-everywhere/core/agent/adapter-api.js";

import { rmSync as __rmSuiteStore } from "node:fs";
import { join as __joinSuiteStore } from "node:path";
import { tmpdir as __tmpdirSuiteStore } from "node:os";
const __suiteStoreDir = __joinSuiteStore(__tmpdirSuiteStore(), `open-everywhere-suite-linear-credentials-${process.pid}`);
__rmSuiteStore(__suiteStoreDir, { recursive: true, force: true });
process.env.OE_SQLITE_PATH = __joinSuiteStore(__suiteStoreDir, "ops.sqlite3");

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

const LINEAR_ENV_KEYS = [
  "LINEAR_AGENT_ACCESS_TOKEN", "LINEAR_ACCESS_TOKEN", "LINEAR_API_KEY", "LINEAR_API_TOKEN",
  "LINEAR_CLIENT_ID", "LINEAR_CLIENT_SECRET",
  "LINEAR_ORGANIZATION_ID",
  "LINEAR_APP_SOAK_ORG_ID", "LINEAR_APP_SOAK_CLIENT_ID", "LINEAR_APP_SOAK_CLIENT_SECRET", "LINEAR_APP_SOAK_WEBHOOK_SECRET",
];
function clearLinearEnv(): void {
  for (const k of LINEAR_ENV_KEYS) delete process.env[k];
  overrideSettingsForTest({ linear: { clientId: "", organizationId: "" } });
}
const savedEnv: Record<string, string | undefined> = {};
for (const k of LINEAR_ENV_KEYS) savedEnv[k] = process.env[k];
const savedSettings = { clientId: getSettings().linear.clientId, organizationId: getSettings().linear.organizationId };

function mkFetch(
  responses: ReadonlyArray<{ status?: number; body?: unknown; networkError?: boolean }>,
): { fetch: LinearMintFetch; calls: string[] } {
  const calls: string[] = [];
  let i = 0;
  const fetch: LinearMintFetch = async (url, init) => {
    calls.push(init.body);
    const r = responses[Math.min(i, responses.length - 1)]!;
    i++;
    if (r.networkError) throw new Error("simulated network failure");
    const status = r.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(r.body ?? {}),
      json: async () => r.body ?? {},
    };
  };
  return { fetch, calls };
}

try {
  {
    clearLinearEnv();
    _resetLinearMintCache();
    process.env.LINEAR_ACCESS_TOKEN = "lin_static_token";
    overrideSettingsForTest({ linear: { clientId: "client-id-should-be-ignored" } });
    process.env.LINEAR_CLIENT_SECRET = "client-secret-should-be-ignored";
    ok((await resolveLinearAccessTokenSeam()) === "lin_static_token", "precedence: a static LINEAR_ACCESS_TOKEN wins even when a client-credentials pair is ALSO set");
    ok((await staticLinearToken()) === "lin_static_token", "staticLinearToken: reads LINEAR_ACCESS_TOKEN");
  }
  {
    clearLinearEnv();
    _resetLinearMintCache();
    process.env.LINEAR_API_TOKEN = "d";
    process.env.LINEAR_API_KEY = "c";
    process.env.LINEAR_ACCESS_TOKEN = "b";
    process.env.LINEAR_AGENT_ACCESS_TOKEN = "a";
    ok((await staticLinearToken()) === "a", "precedence order: LINEAR_AGENT_ACCESS_TOKEN beats every other static var");
    delete process.env.LINEAR_AGENT_ACCESS_TOKEN;
    ok((await staticLinearToken()) === "b", "…LINEAR_ACCESS_TOKEN next");
    delete process.env.LINEAR_ACCESS_TOKEN;
    ok((await staticLinearToken()) === "c", "…LINEAR_API_KEY next");
    delete process.env.LINEAR_API_KEY;
    ok((await staticLinearToken()) === "d", "…LINEAR_API_TOKEN last");
  }

  {
    clearLinearEnv();
    _resetLinearMintCache();
    ok((await resolveLinearAccessTokenSeam()) === "", "neither static nor client-credentials configured → resolves \"\" (falsy) so eve's own missing-token error still fires");
    ok((await linearCredentialsConfigured()) === false, "linearCredentialsConfigured: false when nothing is set");
  }

  {
    clearLinearEnv();
    _resetLinearMintCache();
    overrideSettingsForTest({ linear: { clientId: "client-abc" } });
    process.env.LINEAR_CLIENT_SECRET = "secret-xyz";
    ok((await linearCredentialsConfigured()) === true, "linearCredentialsConfigured: true when the client-credentials pair is set");
    const { fetch, calls } = mkFetch([{ body: { access_token: "minted-token-1", expires_in: 3600 } }]);
    const minted = await mintLinearAppActorToken("client-abc", "secret-xyz", fetch);
    ok(minted.value === "minted-token-1", "mintLinearAppActorToken: returns the response's access_token as a BrokeredSecret value");
    ok((minted.expiresAtMs ?? 0) > Date.now(), "mintLinearAppActorToken: computes a future expiry from expires_in");
    ok(calls.length === 1, "mintLinearAppActorToken: exactly one token-endpoint call");
    const params = new URLSearchParams(calls[0]);
    ok(params.get("grant_type") === "client_credentials", "mint request: grant_type=client_credentials");
    ok(params.get("actor") === "app", "mint request: actor=app (the Agent Session-capable actor)");
    ok(params.get("client_id") === "client-abc" && params.get("client_secret") === "secret-xyz", "mint request: carries the configured client id/secret");
    ok(params.get("scope") === "read write app:assignable app:mentionable", "mint request: the same scope set the manual setup doc mints");
  }

  {
    const { fetch } = mkFetch([{ body: { access_token: "no-ttl-token" } }]);
    const before = Date.now();
    const minted = await mintLinearAppActorToken("c", "s", fetch);
    const days = ((minted.expiresAtMs ?? 0) - before) / (24 * 60 * 60 * 1000);
    ok(days > 29 && days < 31, "mintLinearAppActorToken: missing expires_in defaults to ~30 days");
  }

  {
    clearLinearEnv();
    _resetLinearMintCache();
    overrideSettingsForTest({ linear: { clientId: "client-abc" } });
    process.env.LINEAR_CLIENT_SECRET = "secret-xyz";

    const realFetch = globalThis.fetch;
    try {
      let callCount = 0;
      const responses = [
        { body: { access_token: "cached-token-A", expires_in: 3600 } },
        { body: { access_token: "refreshed-token-B", expires_in: 3600 } },
      ];
      globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
        callCount++;
        const r = responses[Math.min(callCount - 1, responses.length - 1)]!;
        return new Response(JSON.stringify(r.body), { status: 200 });
      }) as unknown as typeof fetch;

      const first = await resolveLinearAccessTokenSeam();
      ok(first === "cached-token-A", "cache: first resolve mints and returns the fresh token");
      ok(callCount === 1, "cache: exactly one mint call for the first resolve");

      const second = await resolveLinearAccessTokenSeam();
      ok(second === "cached-token-A", "cache: a second resolve within the TTL serves the CACHED token");
      ok(callCount === 1, "cache: …without a second mint call");

      _resetLinearMintCache();
      callCount = 0;
      const shortLived = [{ body: { access_token: "short-lived-C", expires_in: 60 } }];
      globalThis.fetch = (async () => {
        callCount++;
        return new Response(JSON.stringify(shortLived[0]!.body), { status: 200 });
      }) as unknown as typeof fetch;
      const third = await resolveLinearAccessTokenSeam();
      ok(third === "short-lived-C", "cache/expiry: a token whose TTL is inside the refresh margin is still served on first mint");
      const fourth = await resolveLinearAccessTokenSeam();
      ok(fourth === "short-lived-C" || callCount === 2, "cache/expiry: a token inside the refresh margin triggers a re-mint on the NEXT resolve (never silently served past the margin)");
      ok(callCount === 2, "cache/expiry: exactly one refresh mint once inside the safety margin");
    } finally {
      globalThis.fetch = realFetch;
    }
  }

  {
    clearLinearEnv();
    _resetLinearMintCache();
    overrideSettingsForTest({ linear: { clientId: "client-abc" } });
    process.env.LINEAR_CLIENT_SECRET = "secret-xyz";
    const realFetch = globalThis.fetch;
    try {
      let callCount = 0;
      let resolveMint: (() => void) | undefined;
      const gate = new Promise<void>((r) => { resolveMint = r; });
      globalThis.fetch = (async () => {
        callCount++;
        await gate;
        return new Response(JSON.stringify({ access_token: "single-flight-token", expires_in: 3600 }), { status: 200 });
      }) as unknown as typeof fetch;

      const p1 = resolveLinearAccessTokenSeam();
      const p2 = resolveLinearAccessTokenSeam();
      const p3 = resolveLinearAccessTokenSeam();
      await new Promise((r) => setTimeout(r, 10));
      resolveMint!();
      const [t1, t2, t3] = await Promise.all([p1, p2, p3]);
      ok(t1 === "single-flight-token" && t2 === "single-flight-token" && t3 === "single-flight-token", "single-flight: all concurrent resolves get the same minted token");
      ok(callCount === 1, "single-flight: exactly ONE token-endpoint call for three concurrent resolves (no stampede)");
    } finally {
      globalThis.fetch = realFetch;
    }
  }

  {
    clearLinearEnv();
    _resetLinearMintCache();
    const org = deploymentOrg();
    const before = (await readAudit({ org, platform: "linear", action: "linear.token_mint_failed" })).length;

    {
      const { fetch } = mkFetch([{ status: 500, body: { error: "internal" } }]);
      let threw = false;
      try {
        await mintLinearAppActorToken("c", "s", fetch);
      } catch (err) {
        threw = true;
        ok(String(err).includes("500"), "mint HTTP-error message names the status code");
        ok(!String(err).includes("secret-xyz") && !String(err).toLowerCase().includes("client-secret"), "mint failure error never echoes the client secret");
      }
      ok(threw, "mintLinearAppActorToken: a non-2xx response THROWS (never a silent empty token)");
    }

    {
      const badJsonFetch: LinearMintFetch = async () => ({
        ok: true,
        status: 200,
        text: async () => "not json",
        json: async () => { throw new SyntaxError("Unexpected token"); },
      });
      let threw = false;
      try {
        await mintLinearAppActorToken("c", "s", badJsonFetch);
      } catch {
        threw = true;
      }
      ok(threw, "mintLinearAppActorToken: a malformed JSON body throws");
    }

    {
      const { fetch } = mkFetch([{ body: { expires_in: 3600 } }]);
      let threw = false;
      let msg = "";
      try {
        await mintLinearAppActorToken("c", "s", fetch);
      } catch (err) {
        threw = true;
        msg = String(err);
      }
      ok(threw, "mintLinearAppActorToken: a 200 with no access_token still throws");
      ok(msg.includes("no access_token"), "…with a diagnosable message");
    }

    overrideSettingsForTest({ linear: { clientId: "client-abc" } });
    process.env.LINEAR_CLIENT_SECRET = "secret-xyz";
    const realFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async () => {
        throw new Error("simulated network down");
      }) as unknown as typeof fetch;
      let threw = false;
      try {
        await resolveLinearAccessTokenSeam();
      } catch (err) {
        threw = true;
        ok(String(err).includes("network error"), "resolveLinearAccessTokenSeam: a network failure surfaces a diagnosable error");
      }
      ok(threw, "resolveLinearAccessTokenSeam: a mint network failure THROWS (never silently returns an empty/stale token)");
    } finally {
      globalThis.fetch = realFetch;
    }

    const after = await readAudit({ org, platform: "linear", action: "linear.token_mint_failed" });
    ok(after.length > before, "mint failure appends AT LEAST ONE linear.token_mint_failed audit row (durable, queryable after the triggering turn's own logs rotate)");
    const last = after[0]!;
    ok(typeof last.detail?.error === "string" && (last.detail!.error as string).length > 0, "the audit row carries a non-empty error detail");
    ok(!JSON.stringify(last).includes("secret-xyz"), "the audit row never carries the client secret");
  }

  {
    clearLinearEnv();
    _resetLinearMintCache();
    overrideSettingsForTest({ linear: { clientId: "client-abc" } });
    process.env.LINEAR_CLIENT_SECRET = "secret-xyz";
    const realFetch = globalThis.fetch;
    try {
      let callCount = 0;
      globalThis.fetch = (async () => {
        callCount++;
        return new Response(JSON.stringify({ error: "denied" }), { status: 403 });
      }) as unknown as typeof fetch;
      const results = await Promise.allSettled([resolveLinearAccessTokenSeam(), resolveLinearAccessTokenSeam(), resolveLinearAccessTokenSeam()]);
      ok(results.every((r) => r.status === "rejected"), "single-flight failure: every concurrent caller rejects");
      ok(callCount === 1, "single-flight failure: exactly ONE token-endpoint call for three concurrent failing resolves");
      callCount = 0;
      globalThis.fetch = (async () => new Response(JSON.stringify({ access_token: "recovered-token", expires_in: 3600 }), { status: 200 })) as unknown as typeof fetch;
      const recovered = await resolveLinearAccessTokenSeam();
      ok(recovered === "recovered-token", "after a failed mint, the NEXT call retries and can recover (no permanent wedge)");
    } finally {
      globalThis.fetch = realFetch;
    }
  }

  {
    clearLinearEnv();
    _resetLinearMintCache();
    overrideSettingsForTest({ linear: { clientId: "primary-client" } });
    process.env.LINEAR_CLIENT_SECRET = "primary-secret";
    process.env.LINEAR_APP_SOAK_ORG_ID = "org-soak";
    process.env.LINEAR_APP_SOAK_CLIENT_ID = "soak-client";
    process.env.LINEAR_APP_SOAK_CLIENT_SECRET = "soak-secret";
    process.env.LINEAR_APP_SOAK_WEBHOOK_SECRET = "soak-webhook-secret";

    const registry = linearAppRegistry();
    ok(registry.length === 1, "registry: exactly one additional app is discovered from LINEAR_APP_<SLOT>_ORG_ID");
    ok(registry[0]!.slot === "SOAK" && registry[0]!.organizationId === "org-soak", "registry: the slot label and organization id are read from the env names");
    ok(registry[0]!.clientId === "soak-client" && registry[0]!.clientSecret === "soak-secret", "registry: the entry carries its OWN client pair, not the primary's");
    ok(registry[0]!.webhookSecret === "soak-webhook-secret", "registry: the entry carries its own webhook signing secret");
    ok(linearAppForOrg("org-soak")?.slot === "SOAK", "linearAppForOrg: finds the app by organization id");
    ok(linearAppForOrg("org-unknown") === undefined, "linearAppForOrg: an unregistered organization has no app");

    const realFetch = globalThis.fetch;
    try {
      const bodies: string[] = [];
      globalThis.fetch = (async (_url: string, init: { body: string }) => {
        bodies.push(init.body);
        const clientId = new URLSearchParams(init.body).get("client_id");
        return new Response(JSON.stringify({ access_token: `token-for-${clientId}`, expires_in: 3600 }), { status: 200 });
      }) as unknown as typeof fetch;

      const soakToken = await resolveLinearAccessTokenForOrg("org-soak");
      ok(soakToken === "token-for-soak-client", "org-keyed: a registered organization mints from THAT app's client pair");
      const primaryToken = await resolveLinearAccessTokenForOrg(undefined);
      ok(primaryToken === "token-for-primary-client", "org-keyed: the org-free form still mints from the PRIMARY client pair");
      ok(bodies.length === 2, "org-keyed: the two organizations do NOT share one warm entry (two mints, not one cache hit)");

      ok((await resolveLinearAccessTokenForOrg("org-soak")) === "token-for-soak-client", "org-keyed: the second organization's warm entry serves its OWN token");
      ok((await resolveLinearAccessTokenForOrg(undefined)) === "token-for-primary-client", "org-keyed: the primary warm entry is unaffected by the second organization's");
      ok(bodies.length === 2, "org-keyed: neither re-resolve minted again (one warm entry per app, both held)");

      ok((await linearCredentialsForOrg("org-soak").accessToken()) === "token-for-soak-client", "linearCredentialsForOrg: the object resolves the registered organization's token");
      ok(linearCredentialsForOrg(undefined) === linearAppActorCredentials, "linearCredentialsForOrg(undefined) returns the shared org-free object by identity (no per-call allocation)");
    } finally {
      globalThis.fetch = realFetch;
    }
  }

  {
    clearLinearEnv();
    _resetLinearMintCache();
    process.env.LINEAR_ACCESS_TOKEN = "primary-static-token";
    process.env.LINEAR_APP_SOAK_ORG_ID = "org-soak";
    process.env.LINEAR_APP_SOAK_CLIENT_ID = "soak-client";
    process.env.LINEAR_APP_SOAK_CLIENT_SECRET = "soak-secret";
    const realFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async () => new Response(JSON.stringify({ access_token: "soak-minted", expires_in: 3600 }), { status: 200 })) as unknown as typeof fetch;
      ok((await resolveLinearAccessTokenForOrg("org-soak")) === "soak-minted", "org-keyed: a registered organization does NOT get the primary workspace's static token");
      ok((await resolveLinearAccessTokenForOrg(undefined)) === "primary-static-token", "org-keyed: the primary chain still returns the static token, unchanged");
    } finally {
      globalThis.fetch = realFetch;
    }
  }

  {
    clearLinearEnv();
    _resetLinearMintCache();
    process.env.LINEAR_API_KEY = "legacy-static";
    ok(linearAppRegistry().length === 0, "byte-identical: no LINEAR_APP_* variables ⇒ an EMPTY registry");
    ok((await resolveLinearAccessTokenSeam()) === "legacy-static", "byte-identical: the org-free seam is the unchanged static chain");
    ok((await resolveLinearAccessTokenForOrg("any-org-at-all")) === "legacy-static", "byte-identical: with no primary organization declared, ANY organization still gets the primary token (the pre-ticket catch-all)");
    ok((await linearCredentialsForOrg("any-org-at-all").accessToken()) === "legacy-static", "byte-identical: the org-keyed credentials object agrees with the seam");
  }

  {
    clearLinearEnv();
    _resetLinearMintCache();
    process.env.LINEAR_API_KEY = "primary-static";
    overrideSettingsForTest({ linear: { organizationId: "org-primary" } });
    ok(primaryLinearOrganizationId() === "org-primary", "primaryLinearOrganizationId: reads the linear.organizationId setting");
    ok((await resolveLinearAccessTokenForOrg("org-primary")) === "primary-static", "fail-closed: the DECLARED primary organization still resolves the primary token");
    ok((await resolveLinearAccessTokenForOrg(undefined)) === "primary-static", "fail-closed: a call site that names no organization still resolves the primary token");
    ok((await resolveLinearAccessTokenForOrg("org-stranger")) === "", "fail-closed: an UNKNOWN organization resolves \"\" so eve throws its stock missing-token error");
    process.env.LINEAR_APP_SOAK_ORG_ID = "org-soak";
    process.env.LINEAR_APP_SOAK_CLIENT_ID = "soak-client";
    process.env.LINEAR_APP_SOAK_CLIENT_SECRET = "soak-secret";
    const realFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async () => new Response(JSON.stringify({ access_token: "soak-minted", expires_in: 3600 }), { status: 200 })) as unknown as typeof fetch;
      ok((await resolveLinearAccessTokenForOrg("org-soak")) === "soak-minted", "fail-closed: a REGISTERED organization is served even with a declared primary");
      ok((await resolveLinearAccessTokenForOrg("org-stranger")) === "", "fail-closed: an unregistered stranger is still refused");
    } finally {
      globalThis.fetch = realFetch;
    }
  }

  {
    clearLinearEnv();
    _resetLinearMintCache();
    process.env.LINEAR_ORGANIZATION_ID = "org-primary";
    process.env.LINEAR_CLIENT_ID = "env-client";
    process.env.LINEAR_CLIENT_SECRET = "primary-secret";
    const mintBodies: string[] = [];
    const realFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async (_url: string, init: RequestInit) => {
        mintBodies.push(String(init.body));
        return new Response(JSON.stringify({ access_token: "primary-minted", expires_in: 3600 }), { status: 200 });
      }) as unknown as typeof fetch;
      ok(primaryLinearOrganizationId() === undefined, "🔴 OPE-2650: env LINEAR_ORGANIZATION_ID with the setting unset ⇒ no declared primary organization");
      ok((await linearCredentialsConfigured()) === false, "🔴 OPE-2650: env LINEAR_CLIENT_ID with the setting unset ⇒ the client pair does not count as configured");
      ok((await resolveLinearAccessTokenForOrg("org-stranger")) === "", "🔴 OPE-2650: env ids alone ⇒ no mint (the env client id is ignored)");
      ok(mintBodies.length === 0, "🔴 OPE-2650: env ids alone ⇒ the token endpoint is never called");

      overrideSettingsForTest({ linear: { organizationId: "org-primary", clientId: "settings-client" } });
      _resetLinearMintCache();
      ok(primaryLinearOrganizationId() === "org-primary", "OPE-2650: the linear.organizationId setting declares the primary organization");
      ok((await resolveLinearAccessTokenForOrg("org-stranger")) === "", "OPE-2650: with the setting, the strict arm refuses an unknown organization");
      ok(mintBodies.length === 0, "OPE-2650: the strict arm refuses before any mint");
      ok((await resolveLinearAccessTokenForOrg("org-primary")) === "primary-minted", "OPE-2650: with the linear.clientId setting, the primary organization mints");
      ok(mintBodies.length === 1 && new URLSearchParams(mintBodies[0]).get("client_id") === "settings-client", "OPE-2650: the mint sends the setting's client id, never the env one");
    } finally {
      globalThis.fetch = realFetch;
    }
  }

  {
    clearLinearEnv();
    _resetLinearMintCache();
    process.env.LINEAR_APP_SOAK_ORG_ID = "org-soak";
    process.env.LINEAR_APP_SOAK_CLIENT_ID = "soak-client";
    ok(linearAppRegistry().length === 0, "half-configured: an entry with no client secret is DROPPED from the registry");
    ok((await linearCredentialsConfigured()) === false, "half-configured: the credential census does not count a half-configured app");
    process.env.LINEAR_APP_SOAK_CLIENT_SECRET = "soak-secret";
    ok(linearAppRegistry().length === 1, "half-configured: the entry appears once its client secret is set");
    ok((await linearCredentialsConfigured()) === true, "half-configured: a registered app alone makes the surface count as credentialed");
  }

  {
    const headers = new Headers();
    headers.set("retry-after", "2");
    let calls = 0;
    const rateLimitedThenOk: LinearMintFetch = async () => {
      calls++;
      if (calls === 1) return { ok: false, status: 429, headers, text: async () => "rate limited", json: async () => ({}) } as never;
      return { ok: true, status: 200, text: async () => "", json: async () => ({ access_token: "minted-after-429", expires_in: 3600 }) };
    };
    const slept: number[] = [];
    const minted = await mintLinearAppActorToken("c", "s", rateLimitedThenOk, { sleep: async (ms) => void slept.push(ms) });
    ok(slept.length === 1 && slept[0] === 2000, "backoff: the honoured delay is the exact Retry-After value (2 s)");
    ok(calls === 2, "backoff: the token POST is repeated until Linear accepts it");
    ok(minted.value === "minted-after-429", "backoff: the eventual token is returned once the 429 clears");
  }
  {
    let calls = 0;
    const forbidden: LinearMintFetch = async () => {
      calls++;
      return { ok: false, status: 403, text: async () => "forbidden", json: async () => ({}) } as never;
    };
    const slept: number[] = [];
    let threw = false;
    try {
      await mintLinearAppActorToken("c", "s", forbidden, { sleep: async (ms) => void slept.push(ms) });
    } catch {
      threw = true;
    }
    ok(threw, "backoff negative control: a 403 still throws");
    ok(calls === 1, "backoff negative control: a 403 is requested EXACTLY once");
    ok(slept.length === 0, "backoff negative control: zero sleeps");
  }
  {
    const headers = new Headers();
    headers.set("retry-after", "1");
    const alwaysLimited: LinearMintFetch = async () => ({ ok: false, status: 429, headers, text: async () => "rate limited", json: async () => ({}) }) as never;
    const slept: number[] = [];
    let caught: unknown;
    try {
      await mintLinearAppActorToken("c", "s", alwaysLimited, { sleep: async (ms) => void slept.push(ms) });
    } catch (err) {
      caught = err;
    }
    ok(caught instanceof RateLimitExhaustedError, "🔴 backoff exhaustion: the NAMED RateLimitExhaustedError survives the mint's own catch block unwrapped");
    ok((caught as RateLimitExhaustedError).surface === "linear", "backoff exhaustion: the surface names linear");
    ok((caught as RateLimitExhaustedError).operation === "oauth.token", "backoff exhaustion: the operation is the vendor route name");
    ok(slept.length === 3 && slept.every((ms) => ms === 1000), "backoff exhaustion: three waits under the shared default");
  }

  {
    for (const k of LINEAR_ENV_KEYS) delete process.env[k];
    process.env.LINEAR_CLIENT_ID = "mint-only-client";
    process.env.LINEAR_CLIENT_SECRET = "mint-only-secret";
    _resetLinearMintCache();
    const { enrichUserGuest, _resetLinearGuestCache } = await import("../agent/channels/linear.js");
    _resetLinearGuestCache();
    const urls: string[] = [];
    const savedFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      urls.push(String(input instanceof Request ? input.url : input));
      return new Response(JSON.stringify({ access_token: "minted", expires_in: 3600, data: { user: { guest: false } } }), { status: 200 });
    }) as typeof fetch;
    let guest: boolean | undefined;
    try {
      guest = await enrichUserGuest("user-1");
    } finally {
      globalThis.fetch = savedFetch;
    }
    ok(guest === undefined, "🔴 OPE-2650 guest probe: a mint-only deployment answers undefined (fail closed), as before");
    ok(!urls.some((u) => u.includes("/oauth/token")), `🔴 OPE-2650 guest probe: the token endpoint is never called (saw: ${urls.join(", ") || "nothing"})`);
    process.env.LINEAR_ACCESS_TOKEN = "static-for-guest";
    _resetLinearGuestCache();
    globalThis.fetch = (async (input: string | URL | Request) => {
      urls.push(String(input instanceof Request ? input.url : input));
      return new Response(JSON.stringify({ data: { user: { guest: false } } }), { status: 200 });
    }) as typeof fetch;
    try {
      guest = await enrichUserGuest("user-2");
    } finally {
      globalThis.fetch = savedFetch;
    }
    ok(guest === false, "guest probe: with a static token the probe answers (positive control)");
    ok(!urls.some((u) => u.includes("/oauth/token")), "guest probe: …still without a mint");
  }

  console.log(`\n✓ linear-credentials: ${passed} assertions passed`);
} finally {
  for (const k of LINEAR_ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k];
  }
  overrideSettingsForTest({ linear: savedSettings });
  _resetLinearMintCache();
}
