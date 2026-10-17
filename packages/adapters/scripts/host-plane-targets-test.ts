import { overrideSettingsForTest } from "@open-everywhere/core/agent/adapter-api.js";

const realFetch = globalThis.fetch;
let n = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  n++;
}

try {
  process.env.OE_EGRESS_PROXY_URL = "http://egress-proxy.invalid:9000";
  for (const k of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "OE_AI_GATEWAY_URL", "VERCEL"]) delete process.env[k];
  overrideSettingsForTest({
    models: {
      targets: {
        gateway: { kind: "vercel-ai-gateway", url: "https://relay.example.invalid/v4/ai" },
        eu: { kind: "vercel-ai-gateway", url: "https://eu-gateway.example.invalid/v4/ai" },
      },
    },
  });
  const pushes: string[][] = [];
  const sends: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith("/policy")) {
      pushes.push((JSON.parse(String(init!.body)) as { hostPlane: { allow: string[] } }).hostPlane.allow);
      return new Response("{}", { status: 200 });
    }
    sends.push(new URL(url).hostname);
    return new Response(JSON.stringify({ text: "ok" }), { status: 200 });
  }) as typeof fetch;

  const { sharedHostPlaneFetch, gatewayTargetHost } = await import("../agent/model/gateway.js");
  const turnFetch = sharedHostPlaneFetch([]);
  ok(turnFetch !== undefined, "on the proxy tier the shared host-plane fetch exists");
  await turnFetch!("https://eu-gateway.example.invalid/v1/x");
  ok(pushes.length === 1, "the first call pushes the host plane once");
  const allow = [...pushes[0]!].sort();
  ok(allow.join() === ["eu-gateway.example.invalid", "relay.example.invalid"].join(), `the first push holds every target's host, a non-gateway target included — got ${allow.join()}`);
  ok(!allow.includes("ai-gateway.vercel.sh"), "a retargeted gateway target does not declare the default gateway host");
  ok(sends.at(-1) === "eu-gateway.example.invalid", "the call to the eu target goes out");
  ok(gatewayTargetHost() === "relay.example.invalid", "the gateway target's host is its url's host");
} finally {
  globalThis.fetch = realFetch;
}

console.log(`✓ host-plane-targets-test: ${n} assertions`);
