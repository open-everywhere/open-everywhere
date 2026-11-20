import { defineAgent } from "eve";
import { defineDynamic, type DynamicModelContext } from "eve/models";
import "./lib/register-config.js";
import "./lib/register-adapters.js";
import "@open-everywhere/core/agent/access/eve-patch-probe-boot.js";
import { gatewayModelResolver } from "@open-everywhere/adapters/agent/model/gateway.js";
import { registerGatewayDreamJudge, registerGatewayFailureFacetJudge } from "@open-everywhere/adapters/agent/model/dream-judge.js";
import { registerGatewayMeetingModels } from "@open-everywhere/adapters/agent/model/meeting-gateway.js";
import { registerGatewayApprovalJudge } from "@open-everywhere/adapters/agent/model/approval-judge.js";
import { registerGatewayImageDescriber } from "@open-everywhere/adapters/agent/model/gateway-vision.js";
import { registerModelConfigCheck } from "@open-everywhere/adapters/agent/model/gateway-probe.js";
import { getConfig } from "@open-everywhere/core/agent/access/config.js";
import { resolvableModels } from "@open-everywhere/core/agent/model/targets.js";
import { isModelUsable } from "@open-everywhere/core/agent/model/policy.js";
import {
  JUDGE_MODEL,
  MODELS,
  PRIMARY_MODEL,
  PRIMARY_MODEL_CONTEXT_WINDOW_TOKENS,
  TRANSCRIPTION_ROLE,
  UTILITY_MODEL,
  VISION_MODEL,
} from "./model/models.js";
import { loadModelPolicy } from "./model/policy.js";
import { compactionThresholdTokens } from "./model/stacks.js";
import { registerAppInfo } from "@open-everywhere/core/agent/commands/core.js";
import { getSettings } from "@open-everywhere/core/agent/settings/settings.js";
import { sessionUsageLimit } from "@open-everywhere/core/agent/model/session-usage.js";
import { taskContinuationApproval } from "@open-everywhere/core/agent/access/worker-continuation.js";
import { EVE_RUNTIME_VERSION } from "@open-everywhere/core/agent/channels/runtime-rotation.js";
import appPackageJson from "../package.json" with { type: "json" };

const GATEWAY_DEFAULTS = { caching: "auto" } as const;

const SESSION_INPUT_TOKEN_BUDGET = getSettings().agent.sessionInputTokenBudget;
const COMPACTION_THRESHOLD = getSettings().agent.compactionThresholdPercent;
const COMPACTION_THRESHOLD_TOKENS = compactionThresholdTokens(PRIMARY_MODEL_CONTEXT_WINDOW_TOKENS, COMPACTION_THRESHOLD);

registerGatewayDreamJudge({ id: UTILITY_MODEL, via: MODELS.utility.via, gateway: GATEWAY_DEFAULTS });
registerGatewayFailureFacetJudge({ id: UTILITY_MODEL, via: MODELS.utility.via, gateway: GATEWAY_DEFAULTS });

registerGatewayMeetingModels({ id: UTILITY_MODEL, via: MODELS.utility.via, gateway: GATEWAY_DEFAULTS }, TRANSCRIPTION_ROLE);
registerGatewayApprovalJudge({ id: JUDGE_MODEL, via: MODELS.judge.via, gateway: GATEWAY_DEFAULTS });

if (!isModelUsable(VISION_MODEL, loadModelPolicy())) {
  throw new Error(
    `open-everywhere: vision model "${VISION_MODEL}" is not allowed by the org model policy — ` +
      "check agent/model/policy.ts, or re-point the `vision` role in agent/model/stacks.ts.",
  );
}
registerGatewayImageDescriber({ id: VISION_MODEL, via: MODELS.vision.via });

registerModelConfigCheck(() =>
  resolvableModels(
    [...Object.values(MODELS), ...[TRANSCRIPTION_ROLE.primary, TRANSCRIPTION_ROLE.fallback].flatMap((r) => (r?.via === "gateway" ? [{ id: r.id }] : []))],
    getConfig().loadDomains(),
    getConfig().loadRoles?.() ?? [],
    getSettings().models.force,
  ),
);

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
  model: defineDynamic(
    (() => {
      const resolve = gatewayModelResolver({ id: PRIMARY_MODEL, via: MODELS.primary.via, gateway: GATEWAY_DEFAULTS });
      return async (ctx: DynamicModelContext) => primaryModelSelection(await resolve(undefined, ctx));
    })(),
  ),
  reasoning: "medium",
  limits: { sessionUsage: sessionUsageLimit(SESSION_INPUT_TOKEN_BUDGET), sessionTimeoutMs: false },
  approval: taskContinuationApproval,
  compaction: { threshold: COMPACTION_THRESHOLD },
});
