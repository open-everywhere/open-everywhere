import assert from "node:assert/strict";
import {
  useSelfHostEgress,
  onVercel,
  egressProxyUrl,
  postPolicy,
  pushEgressPolicy,
  selfHostEgressBootLog,
  DOCKER_BEHIND_PROXY_FATAL,
  type FetchLike,
  type PushPolicyBody,
} from "../agent/access/self-host-egress.js";
import { hostPlaneFetch, hostPlanePolicy } from "../agent/access/host-plane-egress.js";
import { assertSafeFetchUrl } from "../agent/access/host-egress.js";
import http from "node:http";
import { ProxyAgent } from "undici";
import type { SandboxNetworkPolicy } from "eve/sandbox";
import { defineSettings, overrideSettingsForTest, resetSettingsForTest } from "../agent/settings/settings.js";
import { resolveSelfHostBackendKind, type SelfHostBackendKind } from "../agent/sandbox/backend-select.js";
import { pinSuiteStore } from "./_suite-store.js";

pinSuiteStore("self-host-egress");

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

function withEnv(patch: Record<string, string | undefined>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(patch)) saved[k] = process.env[k];
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

function withProxy<T>(url: string, fn: () => T): T {
  overrideSettingsForTest({ egress: { proxyUrl: url } });
  try {
    return fn();
  } finally {
    overrideSettingsForTest({ egress: { proxyUrl: "" } });
  }
}

{
  withEnv({ VERCEL: undefined }, () =>
    withProxy("http://proxy:8080", () => {
      ok(!onVercel(), "onVercel() false when VERCEL unset");
      ok(egressProxyUrl() === "http://proxy:8080", "egressProxyUrl reads the egress.proxyUrl setting");
      ok(useSelfHostEgress(), "off Vercel + proxy URL → self-host push path");
    }),
  );
  withEnv({ VERCEL: "1" }, () =>
    withProxy("http://proxy:8080", () => {
      ok(onVercel(), "onVercel() true when VERCEL set");
      ok(!useSelfHostEgress(), "ON Vercel → NEVER the self-host push path (use setNetworkPolicy)");
    }),
  );
  withEnv({ VERCEL: undefined }, () => {
    ok(!useSelfHostEgress(), "off Vercel but NO proxy URL → legacy setNetworkPolicy path");
  });
  withEnv({ VERCEL: undefined }, () =>
    withProxy("   ", () => {
      ok(!useSelfHostEgress(), "blank proxy URL is treated as unset");
    }),
  );
  withEnv({ VERCEL: undefined, OE_EGRESS_PROXY_URL: "http://proxy:8080" }, () => {
    ok(egressProxyUrl() === undefined, "🔴 OE_EGRESS_PROXY_URL in the environment is not read (OPE-2650)");
    ok(!useSelfHostEgress(), "…so it does not switch on the self-host push path");
  });
}

function fakeFetch(res: { ok: boolean; status: number; text?: string }): {
  fetch: FetchLike;
  calls: { url: string; init: { method: string; headers: Record<string, string>; body: string } }[];
} {
  const calls: { url: string; init: { method: string; headers: Record<string, string>; body: string } }[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return { ok: res.ok, status: res.status, text: async () => res.text ?? "" };
  };
  return { fetch, calls };
}

{
  const brokered: SandboxNetworkPolicy = {
    allow: {
      "github.com": [{ match: { path: { startsWith: "/acme/" } }, transform: [{ headers: { Authorization: "Basic zzz" } }] }],
      "api.acme.test": [],
    },
  };
  const { fetch, calls } = fakeFetch({ ok: true, status: 200 });
  await postPolicy(fetch, "http://proxy:8080/", "sekret", { policy: brokered, sourceIp: "172.20.0.3", sessionId: "s/ws/x" });
  ok(calls.length === 1, "postPolicy makes exactly one call");
  ok(calls[0].url === "http://proxy:8080/policy", "trailing slashes are normalised → /policy");
  ok(calls[0].init.method === "POST", "it is a POST");
  ok(calls[0].init.headers.authorization === "Bearer sekret", "bearer token is sent when configured");
  const body = JSON.parse(calls[0].init.body) as PushPolicyBody;
  ok(JSON.stringify(body.policy) === JSON.stringify(brokered), "the EXACT compiled policy is serialised (broker header rule intact)");
  ok(body.sourceIp === "172.20.0.3", "explicit sourceIp is forwarded");
  ok(body.sessionId === "s/ws/x", "sessionId is forwarded");

  const noAuth = fakeFetch({ ok: true, status: 200 });
  await postPolicy(noAuth.fetch, "http://proxy:8080", undefined, { policy: "deny-all" });
  ok(noAuth.calls[0].init.headers.authorization === undefined, "no auth header when no token");
  ok(JSON.parse(noAuth.calls[0].init.body).policy === "deny-all", "string policies ('deny-all') serialise verbatim");
}

{
  const rejecting = fakeFetch({ ok: false, status: 403, text: "nope" });
  let threw: unknown;
  try {
    await postPolicy(rejecting.fetch, "http://proxy:8080", undefined, { policy: "deny-all" });
  } catch (err) {
    threw = err;
  }
  ok(threw instanceof Error && threw.message.includes("HTTP 403"), "non-2xx response THROWS (fail-closed) and names the status");

  const networkErr: FetchLike = async () => {
    throw new Error("ECONNREFUSED");
  };
  let threw2: unknown;
  try {
    await postPolicy(networkErr, "http://proxy:8080", undefined, { policy: "deny-all" });
  } catch (err) {
    threw2 = err;
  }
  ok(threw2 instanceof Error && threw2.message.includes("network"), "a network error THROWS (fail-closed), not swallowed");
}

function withBackend<T>(kind: SelfHostBackendKind, fn: () => T): T {
  overrideSettingsForTest({ sandbox: { selfHostBackend: kind } });
  try {
    return fn();
  } finally {
    overrideSettingsForTest({ sandbox: { selfHostBackend: "docker" } });
  }
}

{
  const enforced = withBackend("justbash", () => selfHostEgressBootLog("http://proxy:8080"));
  ok(enforced.warn === undefined, "proxy configured → no boot warning");
  ok(enforced.info.includes("ENFORCED"), "proxy configured → info says egress ENFORCED");

  overrideSettingsForTest({ egress: { allowUnenforced: true } });
  const unenforced = selfHostEgressBootLog("");
  ok(unenforced.warn !== undefined && unenforced.warn.includes("UNENFORCED"), "no proxy + hatch → loud UNENFORCED warn");
  ok(unenforced.info.includes("unenforced"), "no proxy + hatch → info says unenforced");
  resetSettingsForTest();

  let willAbort = selfHostEgressBootLog("");
  withEnv({ OE_ALLOW_UNENFORCED_EGRESS: "1", OE_EGRESS_PROXY_URL: "http://proxy:8080" }, () => {
    willAbort = selfHostEgressBootLog();
  });
  ok(willAbort.warn !== undefined && willAbort.warn.includes("ABORT"), "no proxy, no hatch → warn that sessions will ABORT");
  ok(willAbort.info.includes("none"), "no proxy, no hatch → info says posture = none");

  ok(
    willAbort.warn !== undefined && !willAbort.warn.includes("EVERY session"),
    "OPE-1122: the no-proxy warn does NOT claim EVERY session aborts — docker applies a coarse \"deny-all\" and that session boots",
  );
  ok(
    willAbort.warn !== undefined && willAbort.warn.includes("HOST ALLOW-LIST"),
    "OPE-1122: …and it names the condition that DOES abort — a session that resolves a host allow-list (the positive half; without it the check above passes on any wording at all)",
  );
  ok(
    willAbort.warn !== undefined && willAbort.warn.includes("deny-all"),
    "OPE-1122: …and it states the docker case explicitly, so a reader is not left to infer the exception",
  );

  const blankProxy = withProxy("   ", () => selfHostEgressBootLog());
  ok(blankProxy.warn !== undefined, "a blank egress.proxyUrl is treated as no proxy");

  overrideSettingsForTest({ egress: { allowUnenforced: true } });
  const both = withBackend("justbash", () => withProxy("http://proxy:8080", () => selfHostEgressBootLog()));
  resetSettingsForTest();
  ok(both.warn === undefined && both.info.includes("ENFORCED"), "proxy + hatch → still ENFORCED (proxy wins, no warn)");
}

{
  resetSettingsForTest();

  const WIRED_BACKEND_KINDS: Record<SelfHostBackendKind, true> = { docker: true, justbash: true };
  const wired = Object.keys(WIRED_BACKEND_KINDS);
  ok(wired.length === 2, `OPE-955 tripwire: exactly 2 off-Vercel backends are wired (found ${wired.length}: ${wired.join(", ")}). A new one may enforce natively — make the boot log backend-aware before shipping it.`);
  for (const kind of wired) {
    ok(withBackend(kind as SelfHostBackendKind, () => resolveSelfHostBackendKind()) === kind, `${kind} still resolves as a wired off-Vercel backend`);
  }

  for (const candidate of ["microsandbox", "firecracker", "gvisor", "e2b"]) {
    let threw = false;
    try {
      defineSettings({ sandbox: { selfHostBackend: candidate as never } });
    } catch {
      threw = true;
    }
    ok(threw, `OPE-955 tripwire: '${candidate}' is NOT wired, so selfHostEgressBootLog's backend-blind ABORT claim still holds. If this is red, that backend may enforce natively — make the boot log warn about PARTIAL enforcement (credential injection is a measured gap, OPE-917/OPE-954), never go silent.`);
  }

  const underDocker = withBackend("docker", () => selfHostEgressBootLog(""));
  const underJustbash = withBackend("justbash", () => selfHostEgressBootLog(""));
  ok(underDocker.warn !== undefined && underDocker.warn === underJustbash.warn, "the no-proxy ABORT warn is identical across backends (selfHostEgressBootLog reads no backend kind)");
  ok(underDocker.warn !== undefined && underDocker.warn.includes("ABORT"), "…and it is the ABORT warn, not some other posture line (a content pin on the assertion above)");
}

{
  const dockerProxy = withBackend("docker", () => selfHostEgressBootLog("http://proxy:8080"));
  ok(dockerProxy.fatal === DOCKER_BEHIND_PROXY_FATAL, "🔴 docker + egress.proxyUrl → the boot log carries the fatal refusal");
  resetSettingsForTest();
  const defaultProxy = selfHostEgressBootLog("http://proxy:8080");
  ok(defaultProxy.fatal === DOCKER_BEHIND_PROXY_FATAL, "…and so does the SHIPPED default backend (docker) behind the proxy");
  let staleEnv = defaultProxy;
  withEnv({ OE_SANDBOX_BACKEND: "justbash" }, () => {
    staleEnv = withProxy("http://proxy:8080", () => selfHostEgressBootLog());
  });
  ok(staleEnv.fatal === DOCKER_BEHIND_PROXY_FATAL, "🔴 …and the retired OE_SANDBOX_BACKEND=justbash cannot talk it out of the refusal (OPE-2411)");
  ok(!dockerProxy.info.includes("ENFORCED"), "…and no ENFORCED line is printed for it");
  const jbProxy = withBackend("justbash", () => selfHostEgressBootLog("http://proxy:8080"));
  ok(jbProxy.fatal === undefined && jbProxy.info.includes("ENFORCED"), "justbash + proxy → ENFORCED, no refusal");
  const dockerBare = withBackend("docker", () => selfHostEgressBootLog(""));
  ok(dockerBare.fatal === undefined, "docker WITHOUT a proxy boots (the coarse deny-all path, unchanged)");
}

async function withEnvAsync(patch: Record<string, string | undefined>, fn: () => Promise<void>): Promise<void> {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(patch)) saved[k] = process.env[k];
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const GW = "ai-gateway.vercel.sh";
const PROXY_URL = "http://oe-egress-proxy:8080";
const PROXY_TIER = {
  VERCEL: undefined,
  OE_EGRESS_PROXY_TOKEN: "tok-123",
  HTTPS_PROXY: "http://oe-egress-proxy:3128",
  https_proxy: undefined,
  NO_PROXY: "oe-egress-proxy,localhost",
  no_proxy: undefined,
};

interface Seen {
  url: string;
  init?: RequestInit;
}
function recorder(policyStatus = 200): { seen: Seen[]; transport: (input: string | URL | Request, init?: RequestInit) => Promise<Response> } {
  const seen: Seen[] = [];
  return {
    seen,
    transport: async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      seen.push({ url, init });
      if (url.endsWith("/policy")) return new Response(policyStatus === 200 ? "{}" : "nope", { status: policyStatus });
      return new Response("ok", { status: 200 });
    },
  };
}

await (async () => {
  await withEnvAsync({ ...PROXY_TIER }, async () => {
    ok(hostPlaneFetch([GW]) === undefined, "host plane: no egress.proxyUrl → undefined (default transport, byte-identical)");
  });
  overrideSettingsForTest({ egress: { proxyUrl: PROXY_URL } });
  await withEnvAsync({ ...PROXY_TIER, VERCEL: "1" }, async () => {
    ok(hostPlaneFetch([GW]) === undefined, "host plane: on Vercel → undefined");
  });

  ok(JSON.stringify(hostPlanePolicy([" AI-Gateway.vercel.sh ", GW])) === JSON.stringify({ allow: [GW] }), "hostPlanePolicy lowercases, trims and de-duplicates");
  for (const bad of [[], [""], ["*.vercel.sh"]]) {
    let threw = false;
    try {
      hostPlanePolicy(bad);
    } catch {
      threw = true;
    }
    ok(threw, `hostPlanePolicy refuses ${JSON.stringify(bad)}`);
  }

  await withEnvAsync(PROXY_TIER, async () => {
    {
      const r = recorder();
      const f = hostPlaneFetch([GW], r.transport);
      ok(f !== undefined, "host plane: proxy tier → a fetch");
      let threw = false;
      try {
        await f!("https://pastebin.com/raw/x");
      } catch {
        threw = true;
      }
      ok(threw && r.seen.length === 0, "🔴 an undeclared host is refused, and nothing is pushed or sent");
    }
    {
      const r = recorder();
      const f = hostPlaneFetch([GW], r.transport)!;
      await f(`https://${GW}/v4/ai/language-model`, { method: "POST", body: "{}" });
      ok(r.seen.length === 2, "the first call pushes once, then sends");
      const push = r.seen[0];
      ok(push.url === "http://oe-egress-proxy:8080/policy", "the push goes to the control service's /policy");
      ok((push.init?.headers as Record<string, string>).authorization === "Bearer tok-123", "the push carries the control token");
      const pushBody = JSON.parse(String(push.init?.body)) as Record<string, unknown>;
      ok(JSON.stringify(pushBody) === JSON.stringify({ plane: "host", hostPlane: { allow: [GW] } }), "🔴 the push body is the HOST PLANE with the gateway host alone");
      ok(!("policy" in pushBody), "🔴 …and it carries no `policy`: a proxy from before the host plane refuses it (400) instead of storing the gateway as the app IP's SESSION policy");
      const call = r.seen[1];
      ok(call.url === `https://${GW}/v4/ai/language-model`, "the call goes to the gateway");
      ok((call.init as { dispatcher?: unknown }).dispatcher instanceof ProxyAgent, "🔴 the call is dispatched through a ProxyAgent (the credentialed proxy hop)");
      ok(call.init?.method === "POST" && call.init?.body === "{}", "the caller's own init survives");
      await f(`https://${GW}/v4/ai/language-model`);
      ok(r.seen.length === 3 && !r.seen[2].url.endsWith("/policy"), "a second call does not push again");
    }
    {
      const r = recorder(401);
      const f = hostPlaneFetch([GW], r.transport)!;
      let threw = false;
      try {
        await f(`https://${GW}/v1/models`);
      } catch {
        threw = true;
      }
      ok(threw && r.seen.length === 1, "🔴 a refused host-plane push fails the model call; the call is never sent");
      try {
        await f(`https://${GW}/v1/models`);
      } catch {
      }
      ok(r.seen.length === 2 && r.seen[1].url.endsWith("/policy"), "the next call pushes again");
    }
    await withEnvAsync({ OE_EGRESS_PROXY_TOKEN: undefined }, async () => {
      const r = recorder();
      const f = hostPlaneFetch([GW], r.transport)!;
      await f(`https://${GW}/v1/models`);
      await f(`https://${GW}/v1/models`);
      const d = (i: number) => (r.seen[i]!.init as { dispatcher?: unknown }).dispatcher;
      ok(r.seen.length === 3 && d(1) instanceof ProxyAgent && d(2) instanceof ProxyAgent, "no token: two successful calls, each through a ProxyAgent");
      ok(d(1) !== d(2), "🔴 no token: the tokenless agent is NOT reused, so a token stored later reaches the next call");
      process.env.OE_EGRESS_PROXY_TOKEN = "tok-kept";
      await f(`https://${GW}/v1/models`);
      await f(`https://${GW}/v1/models`);
      ok(d(3) === d(4), "negative control: a credentialed agent IS kept across calls");
    });
    await withEnvAsync({ NO_PROXY: `oe-egress-proxy,${GW}` }, async () => {
      const r = recorder();
      const f = hostPlaneFetch([GW], r.transport)!;
      await f(`https://${GW}/v1/models`);
      ok((r.seen[1].init as { dispatcher?: unknown } | undefined)?.dispatcher === undefined, "NO_PROXY exempts the gateway → direct (no ProxyAgent)");
    });
  });

  const seenAuth: Array<string | undefined> = [];
  const proxy = http.createServer((_req, res) => {
    seenAuth.push(_req.headers["proxy-authorization"]);
    res.writeHead(403);
    res.end();
  });
  proxy.on("connect", (req, socket) => {
    seenAuth.push(req.headers["proxy-authorization"]);
    socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const port = (proxy.address() as { port: number }).port;
  try {
    await withEnvAsync({ ...PROXY_TIER, HTTPS_PROXY: `http://127.0.0.1:${port}`, NO_PROXY: "oe-egress-proxy" }, async () => {
      const pushOnly = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const url = input instanceof Request ? input.url : String(input);
        if (url.endsWith("/policy")) return new Response("{}", { status: 200 });
        return await globalThis.fetch(input, init);
      };
      const f = hostPlaneFetch([GW], pushOnly)!;
      let refused = false;
      try {
        await f(`https://${GW}/v1/models`);
      } catch {
        refused = true;
      }
      ok(refused, "the stub proxy refuses the tunnel, and the host-plane fetch surfaces it (fail-closed)");
      ok(seenAuth[0] === "Bearer tok-123", "🔴 ON THE WIRE: the app's CONNECT carries Proxy-Authorization: Bearer <token>");
      const sessionDispatch = await assertSafeFetchUrl(`https://${GW}/v1/models`);
      ok(sessionDispatch.via === "proxy", "the session-side host fetch routes through the same proxy");
      try {
        await globalThis.fetch(`https://${GW}/v1/models`, { dispatcher: sessionDispatch.dispatcher } as RequestInit);
      } catch {
      }
      ok(seenAuth.length === 2 && seenAuth[1] === undefined, "🔴 …and the session-side host fetch (assertSafeFetchUrl's ProxyAgent) carries NO credential");
      delete process.env.OE_EGRESS_PROXY_TOKEN;
      const late = hostPlaneFetch([GW], pushOnly)!;
      const before = seenAuth.length;
      try {
        await late(`https://${GW}/v1/models`);
      } catch {
      }
      ok(seenAuth.length === before + 1 && seenAuth[before] === undefined, "no token yet: the app's CONNECT reaches the proxy and carries no credential");
      process.env.OE_EGRESS_PROXY_TOKEN = "tok-later";
      try {
        await late(`https://${GW}/v1/models`);
      } catch {
      }
      ok(seenAuth.length === before + 2 && seenAuth[before + 1] === "Bearer tok-later", "🔴 a token that appears later reaches the NEXT call on the same host-plane fetch");
    });
  } finally {
    proxy.close();
    overrideSettingsForTest({ egress: { proxyUrl: "" } });
  }
})();

// proves: SET-095, SET-096
{
  const realFetch = globalThis.fetch;
  const seen: { url: string; auth?: string; body: Record<string, unknown> }[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    seen.push({
      url: String(input),
      auth: (init?.headers as Record<string, string> | undefined)?.authorization,
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  const saved = { token: process.env.OE_EGRESS_PROXY_TOKEN, ip: process.env.OE_EGRESS_SOURCE_IP };
  try {
    process.env.OE_EGRESS_PROXY_TOKEN = "tok-push";
    process.env.OE_EGRESS_SOURCE_IP = "198.51.100.99";
    overrideSettingsForTest({ egress: { proxyUrl: "http://proxy.invalid:8080", sourceIp: "203.0.113.7" } });
    await pushEgressPolicy({ allow: ["example.com"] } as unknown as SandboxNetworkPolicy);
    ok(seen.length === 1 && seen[0]!.url === "http://proxy.invalid:8080/policy", "the push goes to the egress.proxyUrl setting's /policy");
    ok(seen[0]!.body.sourceIp === "203.0.113.7", "🔴 the push keys on the egress.sourceIp setting");
    ok(seen[0]!.auth === "Bearer tok-push", "the push presents the operator secret OE_EGRESS_PROXY_TOKEN (its env on-ramp here)");
    overrideSettingsForTest({ egress: { sourceIp: "" } });
    await pushEgressPolicy({ allow: ["example.com"] } as unknown as SandboxNetworkPolicy);
    ok(seen[1]!.body.sourceIp === undefined, "🔴 an empty egress.sourceIp sends no key, and the retired OE_EGRESS_SOURCE_IP is not read");
  } finally {
    globalThis.fetch = realFetch;
    for (const [k, v] of [["OE_EGRESS_PROXY_TOKEN", saved.token], ["OE_EGRESS_SOURCE_IP", saved.ip]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    resetSettingsForTest();
  }
}

console.log(`\n✓ self-host-egress: ${n} assertions passed (switch + push serialisation + fail-closed on push failure + boot posture + OPE-955 backend tripwire + docker-behind-proxy refusal + host plane)\n`);

// proves: AP-MOD-core-access-self-host-egress, AP-MOD-core-sandbox-backend-select, AP-MOD-core-access-host-plane-egress
