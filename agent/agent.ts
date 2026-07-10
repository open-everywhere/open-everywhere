import { defineAgent } from "eve";
import { defineDynamic } from "eve/tools";
import "./lib/register-config.js";
import "./lib/register-adapters.js";
import { gatewayModelResolver, gatewayRoutedCompactionModel } from "@open-everywhere/adapters/agent/model/gateway.js";
import { registerGatewayDreamJudge, registerGatewayFailureFacetJudge } from "@open-everywhere/adapters/agent/model/dream-judge.js";
import { registerGatewayImageDescriber } from "@open-everywhere/adapters/agent/model/gateway-vision.js";
import { gatewayCatalogPricingSource } from "@open-everywhere/adapters/agent/spend/gateway-pricing.js";
import { registerPricingSource } from "@open-everywhere/core/agent/spend/pricing.js";
import { isModelUsable } from "@open-everywhere/core/agent/model/policy.js";
import { loadModelPolicy } from "./model/policy.js";
import { registerAppInfo } from "@open-everywhere/core/agent/commands/core.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const GATEWAY_DEFAULTS = {
  zeroDataRetention: true,
  caching: "auto",
} as const;
const DEFAULT_MODEL = "zai/glm-5.2";

const UTILITY_MODEL = "deepseek/deepseek-v4-flash";
const UTILITY_MODEL_CONTEXT_WINDOW_TOKENS = 1_000_000;
const UTILITY_GATEWAY_DEFAULTS = {
  caching: "auto",
} as const;

registerGatewayDreamJudge({ id: UTILITY_MODEL, gateway: UTILITY_GATEWAY_DEFAULTS });

registerGatewayFailureFacetJudge({ id: UTILITY_MODEL, gateway: UTILITY_GATEWAY_DEFAULTS });

const VISION_MODEL = "alibaba/qwen3-vl-instruct";
if (!isModelUsable(VISION_MODEL, loadModelPolicy())) {
  throw new Error(
    `open-everywhere: vision model "${VISION_MODEL}" is not allowed by the org model policy — ` +
      "add it to agent/model/policy.ts's allow-list (or point VISION_MODEL at an allow-listed model).",
  );
}
registerGatewayImageDescriber({ id: VISION_MODEL, gateway: { zeroDataRetention: true } });

registerPricingSource(gatewayCatalogPricingSource());

function readAppVersion(): string {
  try {
    const path = fileURLToPath(new URL("../package.json", import.meta.url));
    const pkg = JSON.parse(readFileSync(path, "utf8")) as { version?: unknown };
    return typeof pkg.version === "string" && pkg.version.length > 0 ? pkg.version : "unknown";
  } catch {
    return "unknown";
  }
}
registerAppInfo({ version: readAppVersion(), primaryModel: DEFAULT_MODEL, utilityModel: UTILITY_MODEL });

export default defineAgent({
  model: defineDynamic({
    fallback: DEFAULT_MODEL,
    events: {
      "step.started": gatewayModelResolver(
        { id: DEFAULT_MODEL, gateway: GATEWAY_DEFAULTS },
        { id: UTILITY_MODEL, gateway: UTILITY_GATEWAY_DEFAULTS },
      ),
    },
  }),
  modelContextWindowTokens: 1_000_000,
  reasoning: "medium",
  compaction: {
    model: gatewayRoutedCompactionModel({ id: UTILITY_MODEL, gateway: UTILITY_GATEWAY_DEFAULTS }),
    modelContextWindowTokens: UTILITY_MODEL_CONTEXT_WINDOW_TOKENS,
    thresholdPercent: 0.5,
  },
  modelOptions: {
    providerOptions: {
      gateway: GATEWAY_DEFAULTS,
    },
  },
});
