// proves: egress.hostside.deny

import assert from "node:assert/strict";
import { Agent, ProxyAgent } from "undici";
import { _setDeploymentIdentityForTest } from "../agent/identity/deployment-identity.js";

import { pinSuiteStore } from "./_suite-store.js";
pinSuiteStore("host-egress-proxy");

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

_setDeploymentIdentityForTest({ org: "acme-org", workspace: "ws1", surface: "c1" });

const PROXY_VARS = ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy"] as const;
const clearProxyEnv = (): void => {
  for (const k of PROXY_VARS) delete process.env[k];
};
clearProxyEnv();

await import("./_register-test-config.js");

const { assertSafeFetchUrl, oeFetch, resolveEgressRoute, setHostEgressLookup } = await import("../agent/access/host-egress.js");
const { getOperationalStore, registerOperationalStore, resetOperationalStore } = await import("../agent/operational/provider.js");

type BindableContext = import("../agent/identity/binding.js").BindableContext;
type OperationalStore = import("../agent/operational/store.js").OperationalStore;

const CTX = {} as BindableContext;
const PROXY = "http://oe-egress-proxy:3128";

async function refusal(fn: () => unknown): Promise<string> {
  try {
    await Promise.resolve(fn());
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  throw new Error("expected a refusal, got none");
}

function stubLookup(addresses: readonly string[]): { calls: number } {
  const c = { calls: 0 };
  setHostEgressLookup(async () => {
    c.calls++;
    return addresses;
  });
  return c;
}

{
  const https = new URL("https://raw.githubusercontent.com/o/r/main/README.md");
  const http = new URL("http://plain.acme.test/x");

  ok(resolveEgressRoute(https, {}).via === "direct", "no proxy env at all ⇒ DIRECT (this is the Vercel path, and it must not change)");
  ok(resolveEgressRoute(https, { HTTPS_PROXY: "" }).via === "direct", "an EMPTY proxy var is not a proxy (a blank env is how compose unsets one)");

  const proxied = resolveEgressRoute(https, { HTTPS_PROXY: PROXY });
  ok(proxied.via === "proxy" && proxied.proxyUrl === PROXY, "🔴 HTTPS_PROXY set ⇒ the https destination routes through THAT proxy — the docker-tier fix");

  ok(resolveEgressRoute(http, { HTTPS_PROXY: PROXY }).via === "direct", "HTTPS_PROXY does not capture an http:// destination");
  ok(resolveEgressRoute(http, { HTTP_PROXY: PROXY }).via === "proxy", "…HTTP_PROXY does");
  ok(resolveEgressRoute(https, { HTTP_PROXY: PROXY }).via === "direct", "…and HTTP_PROXY does not capture an https:// destination");

  const lower = resolveEgressRoute(https, { https_proxy: "http://lower:3128", HTTPS_PROXY: "http://upper:3128" });
  ok(lower.via === "proxy" && lower.proxyUrl === "http://lower:3128", "lowercase `https_proxy` wins when both are set");
  const upper = resolveEgressRoute(https, { https_proxy: "", HTTPS_PROXY: "http://upper:3128" });
  ok(upper.via === "proxy" && upper.proxyUrl === "http://upper:3128", "…and an empty lowercase falls through to the uppercase one (not to direct)");

  const noProxy = (value: string, url = https) => resolveEgressRoute(url, { HTTPS_PROXY: PROXY, NO_PROXY: value }).via;
  ok(noProxy("raw.githubusercontent.com") === "direct", "NO_PROXY exempts an exact host");
  ok(noProxy("githubusercontent.com") === "direct", "…and a bare parent domain exempts its subdomains");
  ok(noProxy(".githubusercontent.com") === "direct", "…with or without the leading dot");
  ok(noProxy("*") === "direct", "…and `*` exempts everything");
  ok(noProxy("other.test, elsewhere.test") === "proxy", "a NO_PROXY that does not match leaves the destination PROXIED (no accidental blanket bypass)");
  ok(noProxy("ubusercontent.com") === "proxy", "🔴 NO_PROXY matches on a DOT boundary — a bare suffix of the hostname does NOT exempt it");
  ok(noProxy("raw.githubusercontent.com:443") === "direct", "a port-qualified entry matches when the (implicit) port agrees");
  ok(noProxy("raw.githubusercontent.com:8443") === "proxy", "…and does NOT match when it disagrees");
  ok(resolveEgressRoute(new URL("https://raw.githubusercontent.com:8443/x"), { HTTPS_PROXY: PROXY, NO_PROXY: "raw.githubusercontent.com:8443" }).via === "direct", "…an explicit port on the URL is what it is compared against");

  const COMPOSE_NO_PROXY = "oe-egress-proxy,localhost,127.0.0.1";
  ok(noProxy(COMPOSE_NO_PROXY) === "proxy", "🔴 under the SHIPPED NO_PROXY, an ordinary allow-listed destination still routes through the proxy");
  ok(resolveEgressRoute(new URL("http://oe-egress-proxy:8080/policy"), { HTTP_PROXY: PROXY, NO_PROXY: COMPOSE_NO_PROXY }).via === "direct", "…while the control-plane push to the proxy container itself stays direct, as compose intends");

  const bad = await refusal(() => resolveEgressRoute(https, { HTTPS_PROXY: "oe-egress-proxy:3128" }, "describe_image"));
  ok(bad.startsWith("describe_image:") && bad.includes("HTTPS_PROXY"), "🔴 a malformed proxy env REFUSES, naming the tool and the variable…");
  ok(bad.includes("refusing to fall back to an unproxied request"), "…and says why: silently going direct is the exact failure this fix was");
  ok((await refusal(() => resolveEgressRoute(https, { HTTPS_PROXY: "::::" }))).includes("not a valid http(s) proxy URL"), "…an unparseable value refuses the same way");
  ok((await refusal(() => resolveEgressRoute(https, { HTTPS_PROXY: "socks5://box:1080" }))).includes("not a valid http(s) proxy URL"), "…and so does a non-http(s) scheme we do not speak (a SOCKS proxy is not a forward HTTP proxy)");
}

{
  process.env.HTTPS_PROXY = PROXY;
  try {
    const lookups = stubLookup(["93.184.216.34"]);
    const d = await assertSafeFetchUrl("https://raw.githubusercontent.com/o/r/main/README.md", "describe_image");
    ok(d.via === "proxy", "with HTTPS_PROXY set the dispatch is routed via the proxy");
    ok(d.dispatcher instanceof ProxyAgent, "🔴 …the dispatcher is an undici ProxyAgent — NOT the explicit direct Agent that overrode NODE_USE_ENV_PROXY and died `Network unreachable`");
    ok(!(d.dispatcher instanceof Agent), "…and is not a plain Agent (ProxyAgent is a sibling, so the check cannot pass by inheritance)");
    ok(lookups.calls === 0, "🔴 the local DNS resolution is SKIPPED entirely on this path — the proxy resolves the CONNECT target itself, and on an internal-only network we could not resolve it anyway");
    ok(d.antiRebind === "proxy-acl", "🔴 …and the DELEGATION is recorded on the dispatch, so no caller can report the stronger posture it did not get");
    ok(d.url.hostname === "raw.githubusercontent.com", "the hostname is handed to the proxy unchanged (the proxy ACL matches on the NAME)");
    await d.dispatcher.close();

    const rebind = stubLookup(["169.254.169.254"]);
    const still = await assertSafeFetchUrl("https://raw.githubusercontent.com/o/r/main/README.md", "describe_image");
    ok(still.via === "proxy" && rebind.calls === 0, "🔴 a hostname that WOULD trip the rebind guard is still dispatched on the proxy path — anti-rebind is delegated to the proxy's default-deny ACL (documented trade, host-egress.ts §proxy routing)");
    await still.dispatcher.close();

    const meta = await refusal(() => assertSafeFetchUrl("http://169.254.169.254/latest/meta-data/", "describe_image"));
    ok(meta.includes("internal/loopback/link-local host"), "🔴 the PRE-DNS literal-host reject still fires on the proxy path (a bare metadata IP is refused, proxy or no proxy)");
    const loop = await refusal(() => assertSafeFetchUrl("http://localhost:8080/admin", "describe_image"));
    ok(loop.includes("internal/loopback/link-local host"), "…including the loopback aliases");
    const scheme = await refusal(() => assertSafeFetchUrl("file:///etc/passwd", "describe_image"));
    ok(scheme.includes("only http(s) URLs"), "…and the scheme check, which never depended on the transport at all");
  } finally {
    clearProxyEnv();
    setHostEgressLookup(undefined);
  }
}

{
  try {
    const lookups = stubLookup(["93.184.216.34"]);
    const d = await assertSafeFetchUrl("https://raw.githubusercontent.com/o/r/main/README.md", "describe_image");
    ok(d.via === "direct" && d.antiRebind === "ip-pin", "🔴 with NO proxy env the dispatch stays DIRECT and the IP-pin is what holds anti-rebind (the Vercel path, untouched)");
    ok(d.dispatcher instanceof Agent && !(d.dispatcher instanceof ProxyAgent), "…on a plain undici Agent");
    ok(lookups.calls === 1, "…and the host WAS resolved locally (resolve-then-check-then-pin still runs)");
    await (d.dispatcher as Agent).close();

    stubLookup(["169.254.169.254"]);
    const rebind = await refusal(() => assertSafeFetchUrl("https://raw.githubusercontent.com/o/r/main/README.md", "describe_image"));
    ok(rebind.includes("DNS-rebinding guard") && rebind.includes("169.254.169.254"), "🔴 …so a rebinding host is still refused on the direct path, naming the address it resolved to");

    stubLookup(["93.184.216.34", "10.0.0.7"]);
    const mixed = await refusal(() => assertSafeFetchUrl("https://raw.githubusercontent.com/x", "describe_image"));
    ok(mixed.includes("10.0.0.7"), "…and ANY denied address in a multi-record answer refuses the whole fetch");
  } finally {
    setHostEgressLookup(undefined);
  }
}

{
  const realFetch = globalThis.fetch;
  const live = getOperationalStore();
  const rows: { action: string; detail?: Record<string, unknown> }[] = [];
  const calls: { url: string; init: Record<string, unknown> }[] = [];
  globalThis.fetch = (async (input: unknown, init: unknown) => {
    calls.push({ url: String(input), init: (init ?? {}) as Record<string, unknown> });
    return new Response("stub", { status: 200 });
  }) as typeof globalThis.fetch;
  const fake = { ...live, appendAudit: async (r: { action: string; detail?: Record<string, unknown> }) => void rows.push(r) } as unknown as OperationalStore;
  registerOperationalStore(fake);
  resetOperationalStore();

  try {
    process.env.HTTPS_PROXY = PROXY;
    const proxyLookups = stubLookup(["93.184.216.34"]);
    await oeFetch(CTX, "https://raw.githubusercontent.com/o/r/main/README.md", { tool: "describe_image" });
    const pcall = calls.at(-1)!;
    ok(pcall.init.dispatcher instanceof ProxyAgent, "🔴 oeFetch hands fetch() a ProxyAgent when the stack is proxied — the whole point of OPE-322");
    ok(pcall.init.redirect === "error" && JSON.stringify(pcall.init.headers) === "{}", "…without weakening the other two invariants: no redirect follow, and NO credentials on a model-supplied URL");
    ok(proxyLookups.calls === 0, "…and with no local resolution behind it");
    const pallow = rows.filter((r) => r.action === "egress.hostside.allow").at(-1);
    ok(pallow?.detail?.route === "proxy" && pallow?.detail?.antiRebind === "proxy-acl", "🔴 the audit ALLOW row records the route and the delegated anti-rebind posture — the trail must not imply the pin held when it did not");
    await (pcall.init.dispatcher as ProxyAgent).close();

    const before = calls.length;
    const denied = await refusal(() => oeFetch(CTX, "https://api.github.com/user", { tool: "describe_image" }));
    ok(denied.includes('"api.github.com"') && denied.includes("egress allow-list"), "🔴 a NON-allow-listed host is refused on the proxy path exactly as on the direct one");
    ok(calls.length === before, "…and never reaches fetch(), so the proxy is never even asked");
    ok(rows.at(-1)?.action === "egress.hostside.deny", "…with the deny on the record");

    clearProxyEnv();
    const directLookups = stubLookup(["93.184.216.34"]);
    await oeFetch(CTX, "https://raw.githubusercontent.com/o/r/main/README.md", { tool: "describe_image" });
    const dcall = calls.at(-1)!;
    ok(dcall.init.dispatcher instanceof Agent && !(dcall.init.dispatcher instanceof ProxyAgent), "🔴 with the proxy env gone the SAME call reverts to the pinned direct Agent — the fork is decided per-call by env, not baked at import");
    ok(directLookups.calls === 1, "…and resolves locally again");
    const dallow = rows.filter((r) => r.action === "egress.hostside.allow").at(-1);
    ok(dallow?.detail?.route === "direct" && dallow?.detail?.antiRebind === "ip-pin", "…and the audit row says the pin is what held");
    await (dcall.init.dispatcher as Agent).close();
  } finally {
    clearProxyEnv();
    setHostEgressLookup(undefined);
    globalThis.fetch = realFetch;
    registerOperationalStore(live);
    resetOperationalStore();
  }
}

console.log(`\n✓ host-egress-proxy: ${n} assertions passed (routing decision + proxy dispatch with delegated anti-rebind + direct path unchanged + oeFetch dispatcher/audit fork)\n`);

// proves: AP-MOD-core-access-host-egress
