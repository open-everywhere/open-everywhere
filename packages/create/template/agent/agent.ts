import { defineAgent } from "eve";
import { defineDynamic } from "eve/tools";
import "./lib/register-config.js";
import "./lib/register-adapters.js";
import "@open-everywhere/core/agent/access/eve-patch-probe-boot.js";
import { gatewayModelResolver } from "@open-everywhere/adapters/agent/model/gateway.js";
import { registerGatewayDreamJudge, registerGatewayFailureFacetJudge } from "@open-everywhere/adapters/agent/model/dream-judge.js";
import { registerGatewayApprovalJudge } from "@open-everywhere/adapters/agent/model/approval-judge.js";
import { registerGatewayImageDescriber } from "@open-everywhere/adapters/agent/model/gateway-vision.js";
import { isModelUsable } from "@open-everywhere/core/agent/model/policy.js";
import {
  JUDGE_MODEL,
  PRIMARY_MODEL,
  PRIMARY_MODEL_CONTEXT_WINDOW_TOKENS,
  UTILITY_MODEL,
  VISION_MODEL,
} from "./model/models.js";
import { loadModelPolicy } from "./model/policy.js";
import { compactionThresholdTokens } from "./model/stacks.js";
import { registerAppInfo } from "@open-everywhere/core/agent/commands/core.js";
import { getSettings } from "@open-everywhere/core/agent/settings/settings.js";
import { EVE_RUNTIME_VERSION } from "@open-everywhere/core/agent/channels/runtime-rotation.js";
import appPackageJson from "../package.json" with { type: "json" };

const GATEWAY_DEFAULTS = { caching: "auto" } as const;

const SESSION_INPUT_TOKEN_BUDGET = getSettings().agent.sessionInputTokenBudget;
const COMPACTION_THRESHOLD_PERCENT = getSettings().agent.compactionThresholdPercent;
const COMPACTION_THRESHOLD_TOKENS = compactionThresholdTokens(PRIMARY_MODEL_CONTEXT_WINDOW_TOKENS, COMPACTION_THRESHOLD_PERCENT);

registerGatewayDreamJudge({ id: UTILITY_MODEL, gateway: GATEWAY_DEFAULTS });
registerGatewayFailureFacetJudge({ id: UTILITY_MODEL, gateway: GATEWAY_DEFAULTS });
registerGatewayApprovalJudge({ id: JUDGE_MODEL, gateway: GATEWAY_DEFAULTS });

if (!isModelUsable(VISION_MODEL, loadModelPolicy())) {
  throw new Error(
    `open-everywhere: vision model "${VISION_MODEL}" is not allowed by the org model policy — ` +
      "check agent/model/policy.ts, or re-point the `vision` role in agent/model/stacks.ts.",
  );
}
registerGatewayImageDescriber({ id: VISION_MODEL });

function readAppVersion(): string {
  const version = appPackageJson.version;
  return typeof version === "string" && version.length > 0 ? version : "unknown";
}

function readDeploymentSha(): string {
  const sha = (process.env.VERCEL_GIT_COMMIT_SHA ?? "").trim();
  return sha.length > 0 ? sha : "unknown";
}

function readEvePin(): string {
  const version = EVE_RUNTIME_VERSION.trim();
  return version.length > 0 ? version : "unknown";
}

registerAppInfo({
  version: readAppVersion(),
  primaryModel: PRIMARY_MODEL,
  utilityModel: UTILITY_MODEL,
  contextWindowTokens: PRIMARY_MODEL_CONTEXT_WINDOW_TOKENS,
  compactionThresholdTokens: COMPACTION_THRESHOLD_TOKENS,
  deploymentSha: readDeploymentSha(),
  evePin: readEvePin(),
});

function primaryModelSelection<TModel>(model: TModel): {
  readonly model: TModel;
  readonly modelContextWindowTokens: number;
  readonly modelOptions: { readonly providerOptions: { readonly gateway: typeof GATEWAY_DEFAULTS } };
} {
  return {
    model,
    modelContextWindowTokens: PRIMARY_MODEL_CONTEXT_WINDOW_TOKENS,
    modelOptions: { providerOptions: { gateway: GATEWAY_DEFAULTS } },
  };
}

export default defineAgent({
  build: { externalDependencies: ["just-bash"] },
  model: defineDynamic({
    events: {
      "step.started": (() => {
        const resolve = gatewayModelResolver({ id: PRIMARY_MODEL, gateway: GATEWAY_DEFAULTS });
        return async (event: unknown, ctx: unknown) => primaryModelSelection(await resolve(event, ctx));
      })(),
    },
  }),
  reasoning: "medium",
  limits: { maxInputTokensPerSession: SESSION_INPUT_TOKEN_BUDGET, sessionTimeoutMs: false },
  compaction: { thresholdPercent: COMPACTION_THRESHOLD_PERCENT },
});
