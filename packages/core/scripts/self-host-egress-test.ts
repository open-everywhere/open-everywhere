import assert from "node:assert/strict";
import {
  useSelfHostEgress,
  onVercel,
  egressProxyUrl,
  postPolicy,
  selfHostEgressBootLog,
  type FetchLike,
  type PushPolicyBody,
} from "../agent/access/self-host-egress.js";
import type { SandboxNetworkPolicy } from "eve/sandbox";
import { overrideSettingsForTest, resetSettingsForTest } from "../agent/settings/settings.js";
import { resolveSelfHostBackendKind, type SelfHostBackendKind } from "../agent/sandbox/backend-select.js";

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

{
  withEnv({ VERCEL: undefined, OE_EGRESS_PROXY_URL: "http://proxy:8080" }, () => {
    ok(!onVercel(), "onVercel() false when VERCEL unset");
    ok(egressProxyUrl() === "http://proxy:8080", "egressProxyUrl reads OE_EGRESS_PROXY_URL");
    ok(useSelfHostEgress(), "off Vercel + proxy URL → self-host push path");
  });
  withEnv({ VERCEL: "1", OE_EGRESS_PROXY_URL: "http://proxy:8080" }, () => {
    ok(onVercel(), "onVercel() true when VERCEL set");
    ok(!useSelfHostEgress(), "ON Vercel → NEVER the self-host push path (use setNetworkPolicy)");
  });
  withEnv({ VERCEL: undefined, OE_EGRESS_PROXY_URL: undefined }, () => {
    ok(!useSelfHostEgress(), "off Vercel but NO proxy URL → legacy setNetworkPolicy path");
  });
  withEnv({ VERCEL: undefined, OE_EGRESS_PROXY_URL: "   " }, () => {
    ok(!useSelfHostEgress(), "blank proxy URL is treated as unset");
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

{
  const enforced = selfHostEgressBootLog({ OE_EGRESS_PROXY_URL: "http://proxy:8080" } as NodeJS.ProcessEnv);
  ok(enforced.warn === undefined, "proxy configured → no boot warning");
  ok(enforced.info.includes("ENFORCED"), "proxy configured → info says egress ENFORCED");

  overrideSettingsForTest({ egress: { allowUnenforced: true } });
  const unenforced = selfHostEgressBootLog({} as NodeJS.ProcessEnv);
  ok(unenforced.warn !== undefined && unenforced.warn.includes("UNENFORCED"), "no proxy + hatch → loud UNENFORCED warn");
  ok(unenforced.info.includes("unenforced"), "no proxy + hatch → info says unenforced");
  ok(
    selfHostEgressBootLog({ OE_ALLOW_UNENFORCED_EGRESS: "1" } as NodeJS.ProcessEnv).warn?.includes("ABORT") !== true,
    "…and the hatch is read from the SETTINGS, so the reading above was not an accident of the env argument",
  );
  resetSettingsForTest();

  const willAbort = selfHostEgressBootLog({ OE_ALLOW_UNENFORCED_EGRESS: "1" } as NodeJS.ProcessEnv);
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

  const blankProxy = selfHostEgressBootLog({ OE_EGRESS_PROXY_URL: "   " } as NodeJS.ProcessEnv);
  ok(blankProxy.warn !== undefined, "blank OE_EGRESS_PROXY_URL is treated as no proxy");

  const both = selfHostEgressBootLog({ OE_EGRESS_PROXY_URL: "http://proxy:8080", OE_ALLOW_UNENFORCED_EGRESS: "1" } as NodeJS.ProcessEnv);
  ok(both.warn === undefined && both.info.includes("ENFORCED"), "proxy + hatch → still ENFORCED (proxy wins, no warn)");
}

{
  resetSettingsForTest();

  const WIRED_BACKEND_KINDS: Record<SelfHostBackendKind, true> = { docker: true, justbash: true };
  const wired = Object.keys(WIRED_BACKEND_KINDS);
  ok(wired.length === 2, `OPE-955 tripwire: exactly 2 off-Vercel backends are wired (found ${wired.length}: ${wired.join(", ")}). A new one may enforce natively — make the boot log backend-aware before shipping it.`);
  for (const kind of wired) {
    ok(resolveSelfHostBackendKind({ OE_SANDBOX_BACKEND: kind } as NodeJS.ProcessEnv) === kind, `${kind} still resolves as a wired off-Vercel backend`);
  }

  for (const candidate of ["microsandbox", "firecracker", "gvisor", "e2b"]) {
    let threw = false;
    try {
      resolveSelfHostBackendKind({ OE_SANDBOX_BACKEND: candidate } as NodeJS.ProcessEnv);
    } catch {
      threw = true;
    }
    ok(threw, `OPE-955 tripwire: '${candidate}' is NOT wired, so selfHostEgressBootLog's backend-blind ABORT claim still holds. If this is red, that backend may enforce natively — make the boot log warn about PARTIAL enforcement (credential injection is a measured gap, OPE-917/OPE-954), never go silent.`);
  }

  const underDocker = selfHostEgressBootLog({ OE_SANDBOX_BACKEND: "docker" } as NodeJS.ProcessEnv);
  const underJustbash = selfHostEgressBootLog({ OE_SANDBOX_BACKEND: "justbash" } as NodeJS.ProcessEnv);
  ok(underDocker.warn !== undefined && underDocker.warn === underJustbash.warn, "the no-proxy ABORT warn is identical across backends (selfHostEgressBootLog reads no backend kind)");
  ok(underDocker.warn !== undefined && underDocker.warn.includes("ABORT"), "…and it is the ABORT warn, not some other posture line (a content pin on the assertion above)");
}

console.log(`\n✓ self-host-egress: ${n} assertions passed (switch + push serialisation + fail-closed on push failure + boot posture + OPE-955 backend tripwire)\n`);
