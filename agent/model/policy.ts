import { defineModelPolicy, assertModelPolicyValid, type ModelPolicy } from "@open-everywhere/core/agent/model/policy.js";

const policy: ModelPolicy = defineModelPolicy({
  allow: [
    { id: "zai/glm-5.2", tier: "high" },
    { id: "deepseek/deepseek-v4-flash", tier: "low" },
  ],

  reasoningCeiling: "medium",

});

assertModelPolicyValid(policy);

export function loadModelPolicy(): ModelPolicy | undefined {
  return policy;
}
