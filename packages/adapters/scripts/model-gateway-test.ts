import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { applyGatewayOptions, gatewayModelBackend, gatewayHost, DEFAULT_GATEWAY_HOST } from "../agent/model/gateway.js";
import type { RoutedCallOptions } from "@open-everywhere/core/agent/adapter-api.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

const DEFAULT_ID = "openai/gpt-6-luna";
const IDS_SAME = { id: DEFAULT_ID, defaultId: DEFAULT_ID };
const IDS_CHANGED = { id: "anthropic/claude-sonnet-5", defaultId: DEFAULT_ID };
const STATIC_GATEWAY = { only: ["fireworks"], zeroDataRetention: true, caching: "auto" };
const turnCall: RoutedCallOptions = {
  prompt: [],
  providerOptions: { gateway: { ...STATIC_GATEWAY } },
};
type AnyOpts = Record<string, unknown>;
const gw = (o: RoutedCallOptions): AnyOpts => (o.providerOptions as AnyOpts).gateway as AnyOpts;

{
  const o = applyGatewayOptions({}, turnCall, IDS_SAME);
  ok(JSON.stringify(gw(o).only) === JSON.stringify(["fireworks"]) && gw(o).zeroDataRetention === true, "empty route → call options untouched");
}

{
  const o = applyGatewayOptions({ id: IDS_CHANGED.id }, turnCall, IDS_CHANGED);
  ok(gw(o).only === undefined && gw(o).order === undefined, "id change strips the pin keys (only/order)");
  ok(gw(o).zeroDataRetention === true && gw(o).caching === "auto", "every non-pin key survives an id change (no key allow-list)");
}

{
  const o = applyGatewayOptions({ id: IDS_CHANGED.id, providerOrder: ["anthropic"] }, turnCall, IDS_CHANGED);
  ok(JSON.stringify(gw(o).order) === JSON.stringify(["anthropic"]), "route providerOrder → gateway `order` pin");
}

{
  const o = applyGatewayOptions({ providerOrder: ["zai"] }, turnCall, IDS_SAME);
  ok(JSON.stringify(gw(o).order) === JSON.stringify(["zai"]) && gw(o).only === undefined, "providers route sets `order` and strips the inherited `only` on the default model");
}

{
  const bare: RoutedCallOptions = { prompt: [] };
  const o = applyGatewayOptions({}, bare, IDS_SAME, { ...STATIC_GATEWAY });
  ok(JSON.stringify(gw(o).only) === JSON.stringify(["fireworks"]), "bare call → static defaults backfilled (compaction keeps the pin)");
}

{
  const bare: RoutedCallOptions = { prompt: [] };
  const o = applyGatewayOptions({}, bare, IDS_SAME);
  ok(o.providerOptions === undefined, "no gateway options anywhere → options untouched");
}

{
  applyGatewayOptions({ providerOrder: ["zai"] }, turnCall, IDS_SAME);
  ok(JSON.stringify(gw(turnCall).only) === JSON.stringify(["fireworks"]), "input options not mutated");
}

{
  const backend = gatewayModelBackend({ ...STATIC_GATEWAY });
  const o = backend.applyOptions({ providerOrder: ["zai"] }, { prompt: [] }, IDS_SAME);
  ok(JSON.stringify(gw(o).order) === JSON.stringify(["zai"]), "backend.applyOptions applies the gateway mapping with its defaults");
  const m = backend.model(DEFAULT_ID);
  ok(m.modelId === DEFAULT_ID && typeof m.doStream === "function", "backend.model resolves a gateway model");
}

{
  const require = createRequire(import.meta.url);
  const gatewayDist = join(dirname(require.resolve("@ai-sdk/gateway/package.json")), "dist", "index.js");
  const defaults = [...new Set(readFileSync(gatewayDist, "utf8").match(/https:\/\/[a-z0-9.-]+\/v\d+\/ai/g) ?? [])];
  ok(defaults.length === 1, `@ai-sdk/gateway names exactly one default base URL (${defaults.join(", ")})`);
  ok(new URL(defaults[0]).hostname === DEFAULT_GATEWAY_HOST, "🔴 DEFAULT_GATEWAY_HOST is the host the installed @ai-sdk/gateway calls by default");
  ok(gatewayHost(undefined) === DEFAULT_GATEWAY_HOST, "no OE_AI_GATEWAY_URL → the default gateway host");
  ok(gatewayHost("https://relay.example.invalid/v4/ai") === "relay.example.invalid", "OE_AI_GATEWAY_URL → its own host, alone");
  ok(gatewayHost("not a url") === DEFAULT_GATEWAY_HOST, "an unparseable retarget → the default host");
}

console.log(`model-gateway: ${passed} assertions passed`);
