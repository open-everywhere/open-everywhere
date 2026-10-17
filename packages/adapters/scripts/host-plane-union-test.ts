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
  const pushes: string[][] = [];
  const sends: string[] = [];
  let failNextGatewaySend = false;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith("/policy")) {
      pushes.push((JSON.parse(String(init!.body)) as { hostPlane: { allow: string[] } }).hostPlane.allow);
      return new Response("{}", { status: 200 });
    }
    const host = new URL(url).hostname;
    if (failNextGatewaySend && url.includes("/v1/")) {
      failNextGatewaySend = false;
      throw new Error("proxy refused the tunnel");
    }
    sends.push(host);
    return new Response(JSON.stringify({ text: "ok" }), { status: 200 });
  }) as typeof fetch;

  const { sharedHostPlaneFetch, gatewayTargetHost } = await import("../agent/model/gateway.js");
  const GATEWAY_TARGET_HOST = gatewayTargetHost();
  const { transcribeWithFallback } = await import("../agent/model/transcription-routes.js");

  const turnFetch = sharedHostPlaneFetch([]);
  ok(turnFetch !== undefined, "on the proxy tier the shared host-plane fetch exists");
  await turnFetch!(`https://${GATEWAY_TARGET_HOST}/v1/x`);
  ok(pushes.length === 1 && pushes[0]!.join() === GATEWAY_TARGET_HOST, "a turn before any transcription role pushes the gateway host");

  const run = transcribeWithFallback(
    { primary: { via: "self-hosted", id: "m", baseUrl: "http://qwen3-asr:8000/v1" }, fallback: { via: "self-hosted", id: "m", baseUrl: "http://asr-b:8000/v1" } },
    { warn: () => {} },
  );
  await run({ audio: new Uint8Array([1]), mediaType: "audio/wav" });
  const union = pushes.at(-1)!;
  ok(union.includes(GATEWAY_TARGET_HOST) && union.includes("qwen3-asr") && union.includes("asr-b"), "the transcription call pushes the union: gateway host plus both route hosts");
  ok(sends.includes("qwen3-asr"), "the chunk reaches the primary route's host");

  const before = pushes.length;
  await turnFetch!(`https://${GATEWAY_TARGET_HOST}/v1/y`);
  ok(pushes.length === before, "a later turn uses the same union and pushes nothing that drops the route hosts");

  failNextGatewaySend = true;
  let refused = false;
  await turnFetch!(`https://${GATEWAY_TARGET_HOST}/v1/z`).catch(() => (refused = true));
  ok(refused, "the stubbed proxy refused one turn");
  await turnFetch!(`https://${GATEWAY_TARGET_HOST}/v1/w`);
  const repushed = pushes.at(-1)!;
  ok(pushes.length === before + 1 && repushed.includes("qwen3-asr") && repushed.includes("asr-b"), "the turn's re-push after a failure carries the route hosts too");

  let threw = false;
  try {
    sharedHostPlaneFetch(["*.asr.internal"]);
  } catch {
    threw = true;
  }
  ok(threw, "a wildcard host is refused when it is declared");
  await turnFetch!(`https://${GATEWAY_TARGET_HOST}/v1/v`);
  ok(sends.at(-1) === GATEWAY_TARGET_HOST, "a turn after the refused declaration still goes out");
} finally {
  globalThis.fetch = realFetch;
}

console.log(`✓ host-plane-union-test: ${n} assertions`);
