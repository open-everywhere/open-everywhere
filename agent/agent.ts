import { defineAgent } from "eve";
import "./lib/register-config.js";
import "./lib/register-adapters.js";
import { gatewayRoutedModel } from "@open-everywhere/adapters/agent/model/gateway.js";
import { registerGatewayDreamJudge } from "@open-everywhere/adapters/agent/model/dream-judge.js";
import { gatewayCatalogPricingSource } from "@open-everywhere/adapters/agent/spend/gateway-pricing.js";
import { registerPricingSource } from "@open-everywhere/core/agent/spend/pricing.js";

const GATEWAY_DEFAULTS = {
  only: ["fireworks"],
  zeroDataRetention: true,
  caching: "auto",
} as const;
const DEFAULT_MODEL = "zai/glm-5.2";

const UTILITY_MODEL = "minimax/minimax-m2.7";
const UTILITY_MODEL_CONTEXT_WINDOW_TOKENS = 196_608;
const UTILITY_GATEWAY_DEFAULTS = {
  caching: "auto",
} as const;

registerGatewayDreamJudge({ id: UTILITY_MODEL, gateway: UTILITY_GATEWAY_DEFAULTS });

registerPricingSource(gatewayCatalogPricingSource());

export default defineAgent({
  model: gatewayRoutedModel("primary", { id: DEFAULT_MODEL, gateway: GATEWAY_DEFAULTS }),
  modelContextWindowTokens: 1_000_000,
  reasoning: "medium",
  compaction: {
    model: gatewayRoutedModel("utility", { id: UTILITY_MODEL, gateway: UTILITY_GATEWAY_DEFAULTS }),
    modelContextWindowTokens: UTILITY_MODEL_CONTEXT_WINDOW_TOKENS,
    thresholdPercent: 0.15,
  },
  modelOptions: {
    providerOptions: {
      gateway: GATEWAY_DEFAULTS,
    },
  },
});
