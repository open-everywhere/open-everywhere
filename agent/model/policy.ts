import { defineModelPolicy, assertModelPolicyValid, type ModelPolicy } from "@open-everywhere/core/agent/model/policy.js";
import { modelAllowList } from "./models.js";

const policy: ModelPolicy = defineModelPolicy({
  allow: modelAllowList(),

  reasoningCeiling: "medium",

});

assertModelPolicyValid(policy);

export function loadModelPolicy(): ModelPolicy | undefined {
  return policy;
}
