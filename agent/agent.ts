import { defineAgent } from "eve";
import "./lib/register-config.js";
import "./lib/register-adapters.js";
import { gatewayRoutedModel } from "@open-everywhere/adapters/agent/model/gateway.js";

const GATEWAY_DEFAULTS = {
  only: ["fireworks"],
  zeroDataRetention: true,
  caching: "auto",
} as const;
const DEFAULT_MODEL = "zai/glm-5.2";

export default defineAgent({
  model: gatewayRoutedModel("primary", { id: DEFAULT_MODEL, gateway: GATEWAY_DEFAULTS }),
  modelContextWindowTokens: 1_000_000,
  reasoning: "medium",
  compaction: {
    model: gatewayRoutedModel("utility", { id: DEFAULT_MODEL, gateway: GATEWAY_DEFAULTS }),
    modelContextWindowTokens: 1_000_000,
  },
  modelOptions: {
    providerOptions: {
      gateway: GATEWAY_DEFAULTS,
    },
  },
});
