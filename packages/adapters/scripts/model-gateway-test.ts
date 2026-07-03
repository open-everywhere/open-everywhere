import { applyGatewayOptions, gatewayModelBackend } from "../agent/model/gateway.js";
import type { RoutedCallOptions } from "@open-everywhere/core/agent/model/routing.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

const DEFAULT_ID = "zai/glm-5.2";
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
  ok(gw(o).zeroDataRetention === true && gw(o).caching === "auto", "posture keys (zdr/caching) survive an id change");
}

{
  const o = applyGatewayOptions({ id: IDS_CHANGED.id, providers: ["anthropic"] }, turnCall, IDS_CHANGED);
  ok(JSON.stringify(gw(o).only) === JSON.stringify(["anthropic"]), "route providers → gateway `only` pin");
}

{
  const o = applyGatewayOptions({ providers: ["zai"] }, turnCall, IDS_SAME);
  ok(JSON.stringify(gw(o).only) === JSON.stringify(["zai"]), "pin-only route replaces the pin on the default model");
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
  applyGatewayOptions({ providers: ["zai"] }, turnCall, IDS_SAME);
  ok(JSON.stringify(gw(turnCall).only) === JSON.stringify(["fireworks"]), "input options not mutated");
}

{
  const backend = gatewayModelBackend({ ...STATIC_GATEWAY });
  const o = backend.applyOptions({ providers: ["zai"] }, { prompt: [] }, IDS_SAME);
  ok(JSON.stringify(gw(o).only) === JSON.stringify(["zai"]), "backend.applyOptions applies the gateway mapping with its defaults");
  const m = backend.model(DEFAULT_ID);
  ok(m.modelId === DEFAULT_ID && typeof m.doStream === "function", "backend.model resolves a gateway model");
}

console.log(`model-gateway: ${passed} assertions passed`);
