import type { ModelTier } from "@open-everywhere/core/agent/memory/domain.js";
import type { ModelPolicyAllowEntry } from "@open-everywhere/core/agent/model/policy.js";
import { defaultAgentModelId } from "@open-everywhere/core/agent/model/default-model.js";

export interface ModelRoleSpec {
  readonly id: string;
  readonly tier: ModelTier;
}

export const MODELS = {
  primary: { id: defaultAgentModelId(), tier: "high" },
  utility: { id: "deepseek/deepseek-v4-flash-0731", tier: "low" },
  vision: { id: "alibaba/qwen3-vl-instruct", tier: "low" },
  supervisor: { id: "deepseek/deepseek-v4-flash-0731", tier: "low" },
  judge: { id: "openai/gpt-5.6-luna", tier: "low" },
} as const satisfies Record<string, ModelRoleSpec>;

export const PRIMARY_MODEL = MODELS.primary.id;
export const UTILITY_MODEL = MODELS.utility.id;
export const VISION_MODEL = MODELS.vision.id;
export const SUPERVISOR_MODEL = MODELS.supervisor.id;
export const JUDGE_MODEL = MODELS.judge.id;

export function modelAllowList(extra: readonly ModelPolicyAllowEntry[] = []): ModelPolicyAllowEntry[] {
  const out: ModelPolicyAllowEntry[] = [];
  const seen = new Set<string>();
  for (const { id, tier } of [...Object.values(MODELS), ...extra]) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, tier });
  }
  return out;
}
