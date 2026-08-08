import { defineAgent } from "eve";
import { defineDynamic } from "eve/tools";
import "./lib/register-config.js";
import "./lib/register-adapters.js";
import { gatewayModelResolver, gatewayRoutedCompactionModel } from "@open-everywhere/adapters/agent/model/gateway.js";
import { registerGatewayDreamJudge, registerGatewayFailureFacetJudge, registerGatewayHandoffCompletion } from "@open-everywhere/adapters/agent/model/dream-judge.js";
import { registerGatewayApprovalJudge } from "@open-everywhere/adapters/agent/model/approval-judge.js";
import { registerGatewayImageDescriber } from "@open-everywhere/adapters/agent/model/gateway-vision.js";
import { gatewayCatalogPricingSource } from "@open-everywhere/adapters/agent/spend/gateway-pricing.js";
import { registerPricingSource } from "@open-everywhere/core/agent/spend/pricing.js";
import { isModelUsable } from "@open-everywhere/core/agent/model/policy.js";
import { JUDGE_MODEL, PRIMARY_MODEL, UTILITY_MODEL, VISION_MODEL } from "./model/models.js";
import { loadModelPolicy } from "./model/policy.js";
import { registerAppInfo } from "@open-everywhere/core/agent/commands/core.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const GATEWAY_DEFAULTS = {
  caching: "auto",
} as const;
const DEFAULT_MODEL = PRIMARY_MODEL;

const UTILITY_MODEL_CONTEXT_WINDOW_TOKENS = 1_000_000;
const UTILITY_GATEWAY_DEFAULTS = {
  caching: "auto",
} as const;

const SESSION_INPUT_TOKEN_BUDGET = Number(process.env.OE_SESSION_INPUT_TOKEN_BUDGET) || 30_000_000;

registerGatewayDreamJudge({ id: UTILITY_MODEL, gateway: UTILITY_GATEWAY_DEFAULTS });

registerGatewayFailureFacetJudge({ id: UTILITY_MODEL, gateway: UTILITY_GATEWAY_DEFAULTS });

registerGatewayHandoffCompletion({ id: UTILITY_MODEL, gateway: UTILITY_GATEWAY_DEFAULTS });

registerGatewayApprovalJudge({ id: JUDGE_MODEL, gateway: { caching: "auto" } });

if (!isModelUsable(VISION_MODEL, loadModelPolicy())) {
  throw new Error(
    `open-everywhere: vision model "${VISION_MODEL}" is not allowed by the org model policy — ` +
      "check providerDeny in agent/model/policy.ts, or re-point the `vision` role in agent/model/models.ts.",
  );
}
registerGatewayImageDescriber({ id: VISION_MODEL });

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
  build: { externalDependencies: ["just-bash"] },

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
  limits: { maxInputTokensPerSession: SESSION_INPUT_TOKEN_BUDGET },
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
