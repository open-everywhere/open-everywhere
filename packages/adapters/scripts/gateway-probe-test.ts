import assert from "node:assert/strict";

import {
  GATEWAY_CATALOG_URL,
  GATEWAY_PROBE_TIMEOUT_MS,
  gatewayCatalogUrl,
  probeGatewayRoute,
} from "../agent/model/gateway-probe.js";

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};

function fetchStub(reply: { ok: boolean; status: number } | Error): { impl: typeof globalThis.fetch; urls: string[] } {
  const urls: string[] = [];
  const impl = (async (url: string | URL) => {
    urls.push(String(url));
    if (reply instanceof Error) throw reply;
    return { ok: reply.ok, status: reply.status } as Response;
  }) as unknown as typeof globalThis.fetch;
  return { impl, urls };
}

{
  const noKey = fetchStub({ ok: true, status: 200 });
  const refused = await probeGatewayRoute({ env: {}, vercel: false, fetchImpl: noKey.impl });
  ok(refused.met === "no", "off Vercel with no AI_GATEWAY_API_KEY the probe answers no");
  ok(refused.detail.includes("AI_GATEWAY_API_KEY"), "…and names the variable to set");
  ok(noKey.urls.length === 0, "…without making a request it already knows the answer to");

  const onVercel = fetchStub({ ok: true, status: 200 });
  const oidc = await probeGatewayRoute({ env: {}, vercel: true, fetchImpl: onVercel.impl });
  ok(oidc.met === "yes", "on Vercel the platform's OIDC satisfies the credential posture with no key");
  ok(oidc.detail.includes("OIDC"), "…and the detail names the posture it measured");
  ok(onVercel.urls.length === 1, "…and it does probe reachability");
}

{
  const env = { AI_GATEWAY_API_KEY: "gw-test-key" };
  const good = await probeGatewayRoute({ env, vercel: false, fetchImpl: fetchStub({ ok: true, status: 200 }).impl });
  ok(good.met === "yes", "a 200 from the catalog is yes");
  const bad = await probeGatewayRoute({ env, vercel: false, fetchImpl: fetchStub({ ok: false, status: 503 }).impl });
  ok(bad.met === "no", "a 503 is no");
  ok(bad.detail.includes("503"), "…and the detail carries the status, which is the operator's next clue");
  const dead = await probeGatewayRoute({ env, vercel: false, fetchImpl: fetchStub(new Error("ECONNREFUSED 10.0.0.1:443")).impl });
  ok(dead.met === "no", "a throwing fetch is no, never a thrown probe");
  ok(dead.detail.includes(String(GATEWAY_PROBE_TIMEOUT_MS)), "…and names the bound it waited");
}

{
  const answer = await probeGatewayRoute({
    env: { AI_GATEWAY_API_KEY: "gw-test-key" },
    vercel: false,
    fetchImpl: fetchStub({ ok: true, status: 200 }).impl,
  });
  ok(
    answer.detail.includes("does not prove"),
    "a yes says in as many words that it does NOT prove an inference call is authorised",
  );
  ok(!/authorised to|authenticated successfully|credential is valid/i.test(answer.detail), "…and claims no successful authentication");
}

{
  const key = "gw-s3cr3t-DO-NOT-PUBLISH";
  const vendorError = new Error(`getaddrinfo ENOTFOUND gateway-internal.acme.invalid (key ${key})`);
  for (const reply of [{ ok: false, status: 401 } as const, vendorError]) {
    const answer = await probeGatewayRoute({
      env: { AI_GATEWAY_API_KEY: key, OE_AI_GATEWAY_URL: `https://gateway-internal.acme.invalid/v4/ai` },
      vercel: false,
      fetchImpl: fetchStub(reply).impl,
    });
    const wire = JSON.stringify(answer);
    ok(!wire.includes(key), "the credential's bytes never reach the answer");
    ok(!wire.includes("acme.invalid"), "…and neither does the configured gateway host");
    ok(!wire.includes("ENOTFOUND"), "…and neither does the vendor's own error text");
  }
}

{
  ok(gatewayCatalogUrl({}) === GATEWAY_CATALOG_URL, "no override ⇒ the shipped public catalog endpoint");
  ok(
    gatewayCatalogUrl({ OE_AI_GATEWAY_URL: "https://relay.example.invalid/v4/ai" }) === "https://relay.example.invalid/v1/models/catalog",
    "an override is taken from its ORIGIN — it names the chat base, not the catalog",
  );
  ok(
    gatewayCatalogUrl({ OE_AI_GATEWAY_URL: "not a url" }) === GATEWAY_CATALOG_URL,
    "an unparseable override falls back to the default rather than answering a misleading unreachable",
  );
  const probed = fetchStub({ ok: true, status: 200 });
  await probeGatewayRoute({ env: { AI_GATEWAY_API_KEY: "k", OE_AI_GATEWAY_URL: "https://relay.example.invalid/v4/ai" }, vercel: false, fetchImpl: probed.impl });
  ok(probed.urls[0] === "https://relay.example.invalid/v1/models/catalog", "…and the probe really requests the retargeted URL");
}

{
  const relay = { OE_AI_GATEWAY_URL: "https://relay.example.invalid/v4/ai" };
  const keyless = await probeGatewayRoute({ env: relay, vercel: false, fetchImpl: fetchStub({ ok: true, status: 200 }).impl });
  ok(keyless.met === "unknown", "a retargeted gateway with no AI_GATEWAY_API_KEY is NOT MEASURED — a relay may need none");
  ok(keyless.detail.includes("not measured"), "…and the detail says so");
  for (const status of [404, 405] as const) {
    const noCatalog = await probeGatewayRoute({ env: { ...relay, AI_GATEWAY_API_KEY: "k" }, vercel: false, fetchImpl: fetchStub({ ok: false, status }).impl });
    ok(noCatalog.met === "unknown", `a retargeted gateway that does not serve a catalog (HTTP ${status}) is NOT MEASURED`);
  }
  const broken = await probeGatewayRoute({ env: { ...relay, AI_GATEWAY_API_KEY: "k" }, vercel: false, fetchImpl: fetchStub({ ok: false, status: 502 }).impl });
  ok(broken.met === "no", "a retargeted gateway answering 502 is a real no");
  const defaultGateway = await probeGatewayRoute({ env: { AI_GATEWAY_API_KEY: "k" }, vercel: false, fetchImpl: fetchStub({ ok: false, status: 404 }).impl });
  ok(defaultGateway.met === "no", "the DEFAULT gateway answering 404 is a real no (the retarget arm does not widen to it)");
  const keylessDefault = await probeGatewayRoute({ env: {}, vercel: false, fetchImpl: fetchStub({ ok: true, status: 200 }).impl });
  ok(keylessDefault.met === "no", "…and a keyless deployment on the DEFAULT gateway is still a real no");
}

console.log(`✓ gateway-probe: ${n} assertions passed`);
