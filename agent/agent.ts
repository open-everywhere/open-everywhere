import { defineAgent } from "eve";
import { defineDynamic } from "eve/tools";
import "./lib/register-config.js";
import "./lib/register-adapters.js";
import { gatewayModelResolver } from "@open-everywhere/adapters/agent/model/gateway.js";
import { registerGatewayDreamJudge, registerGatewayFailureFacetJudge } from "@open-everywhere/adapters/agent/model/dream-judge.js";
import { registerGatewayApprovalJudge } from "@open-everywhere/adapters/agent/model/approval-judge.js";
import { registerGatewayImageDescriber } from "@open-everywhere/adapters/agent/model/gateway-vision.js";
import { gatewayCatalogPricingSource } from "@open-everywhere/adapters/agent/spend/gateway-pricing.js";
import { registerPricingSource } from "@open-everywhere/core/agent/spend/pricing.js";
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
import { scriptedModelFor } from "./model/scripted-resolve.js";
import { registerAppInfo } from "@open-everywhere/core/agent/commands/core.js";
import { backgroundTasksAtBuild, getSettings } from "@open-everywhere/core/agent/settings/settings.js";
import { SETTINGS_OVERRIDES } from "./settings/settings.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const GATEWAY_DEFAULTS = {
  caching: "auto",
} as const;
const DEFAULT_MODEL = PRIMARY_MODEL;

const UTILITY_GATEWAY_DEFAULTS = {
  caching: "auto",
} as const;

const SESSION_INPUT_TOKEN_BUDGET = getSettings().agent.sessionInputTokenBudget;

const BACKGROUND_TASKS = backgroundTasksAtBuild(SETTINGS_OVERRIDES);

const COMPACTION_THRESHOLD_PERCENT = getSettings().agent.compactionThresholdPercent;

const COMPACTION_THRESHOLD_TOKENS = compactionThresholdTokens(PRIMARY_MODEL_CONTEXT_WINDOW_TOKENS, COMPACTION_THRESHOLD_PERCENT);

registerGatewayDreamJudge({ id: UTILITY_MODEL, gateway: UTILITY_GATEWAY_DEFAULTS });

registerGatewayFailureFacetJudge({ id: UTILITY_MODEL, gateway: UTILITY_GATEWAY_DEFAULTS });

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

function readDeploymentSha(): string {
  const sha = (process.env.VERCEL_GIT_COMMIT_SHA ?? "").trim();
  return sha.length > 0 ? sha : "unknown";
}

function readEvePin(): string {
  try {
    const require = createRequire(import.meta.url);
    const path = require.resolve("eve/package.json");
    const pkg = JSON.parse(readFileSync(path, "utf8")) as { version?: unknown };
    return typeof pkg.version === "string" && pkg.version.length > 0 ? pkg.version : "unknown";
  } catch {
    return "unknown";
  }
}

registerAppInfo({
  version: readAppVersion(),
  primaryModel: DEFAULT_MODEL,
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

function selectingResolver<TModel>(
  resolve: (event: unknown, ctx: unknown) => Promise<TModel>,
): (event: unknown, ctx: unknown) => Promise<ReturnType<typeof primaryModelSelection<TModel>>> {
  return async (event, ctx) => primaryModelSelection(await resolve(event, ctx));
}

export default defineAgent({
  build: { externalDependencies: ["just-bash"] },

  model: defineDynamic({
    events: {
      "step.started": (() => {
        const gatewayResolve = gatewayModelResolver({ id: DEFAULT_MODEL, gateway: GATEWAY_DEFAULTS });
        return selectingResolver(async (event, ctx) => scriptedModelFor(event, ctx) ?? (await gatewayResolve(event, ctx)));
      })(),
    },
  }),
  reasoning: "medium",
  limits: { maxInputTokensPerSession: SESSION_INPUT_TOKEN_BUDGET, sessionTimeoutMs: false },
  experimental: { tasks: BACKGROUND_TASKS },
  compaction: {
    thresholdPercent: COMPACTION_THRESHOLD_PERCENT,
  },
});
