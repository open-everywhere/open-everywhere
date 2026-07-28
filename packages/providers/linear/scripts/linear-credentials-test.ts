import {
  _resetLinearMintCache,
  linearCredentialsConfigured,
  mintLinearAppActorToken,
  resolveLinearAccessTokenSeam,
  staticLinearToken,
  type LinearMintFetch,
} from "../agent/channels/linear-credentials.js";
import { readAudit, deploymentOrg } from "@open-everywhere/core/agent/adapter-api.js";

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
];
function clearLinearEnv(): void {
  for (const k of LINEAR_ENV_KEYS) delete process.env[k];
}
const savedEnv: Record<string, string | undefined> = {};
for (const k of LINEAR_ENV_KEYS) savedEnv[k] = process.env[k];

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
    process.env.LINEAR_CLIENT_ID = "client-id-should-be-ignored";
    process.env.LINEAR_CLIENT_SECRET = "client-secret-should-be-ignored";
    ok((await resolveLinearAccessTokenSeam()) === "lin_static_token", "precedence: a static LINEAR_ACCESS_TOKEN wins even when a client-credentials pair is ALSO set");
    ok(staticLinearToken() === "lin_static_token", "staticLinearToken: reads LINEAR_ACCESS_TOKEN");
  }
  {
    clearLinearEnv();
    _resetLinearMintCache();
    process.env.LINEAR_API_TOKEN = "d";
    process.env.LINEAR_API_KEY = "c";
    process.env.LINEAR_ACCESS_TOKEN = "b";
    process.env.LINEAR_AGENT_ACCESS_TOKEN = "a";
    ok(staticLinearToken() === "a", "precedence order: LINEAR_AGENT_ACCESS_TOKEN beats every other static var");
    delete process.env.LINEAR_AGENT_ACCESS_TOKEN;
    ok(staticLinearToken() === "b", "…LINEAR_ACCESS_TOKEN next");
    delete process.env.LINEAR_ACCESS_TOKEN;
    ok(staticLinearToken() === "c", "…LINEAR_API_KEY next");
    delete process.env.LINEAR_API_KEY;
    ok(staticLinearToken() === "d", "…LINEAR_API_TOKEN last");
  }

  {
    clearLinearEnv();
    _resetLinearMintCache();
    ok((await resolveLinearAccessTokenSeam()) === "", "neither static nor client-credentials configured → resolves \"\" (falsy) so eve's own missing-token error still fires");
    ok(linearCredentialsConfigured() === false, "linearCredentialsConfigured: false when nothing is set");
  }

  {
    clearLinearEnv();
    _resetLinearMintCache();
    process.env.LINEAR_CLIENT_ID = "client-abc";
    process.env.LINEAR_CLIENT_SECRET = "secret-xyz";
    ok(linearCredentialsConfigured() === true, "linearCredentialsConfigured: true when the client-credentials pair is set");
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
    process.env.LINEAR_CLIENT_ID = "client-abc";
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
    process.env.LINEAR_CLIENT_ID = "client-abc";
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

    process.env.LINEAR_CLIENT_ID = "client-abc";
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
    process.env.LINEAR_CLIENT_ID = "client-abc";
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

  console.log(`\n✓ linear-credentials: ${passed} assertions passed`);
} finally {
  for (const k of LINEAR_ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k];
  }
  _resetLinearMintCache();
}
