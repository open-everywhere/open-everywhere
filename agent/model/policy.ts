import { defineModelPolicy, assertModelPolicyValid, type ModelPolicy } from "@open-everywhere/core/agent/model/policy.js";
import { modelAbTestArmed } from "@open-everywhere/core/agent/model/ab-test.js";
import { modelAllowList } from "./models.js";
import { CHALLENGER_STACK, MODEL_AB_TEST } from "./ab-test.js";
import { STACKS } from "./stacks.js";

const abChallengerAllow = modelAbTestArmed(MODEL_AB_TEST) ? [{ id: MODEL_AB_TEST.challenger, tier: STACKS[CHALLENGER_STACK].primary.tier }] : [];

const policy: ModelPolicy = defineModelPolicy({
  allow: modelAllowList(abChallengerAllow),

  reasoningCeiling: "medium",

});

assertModelPolicyValid(policy);

export function loadModelPolicy(): ModelPolicy | undefined {
  return policy;
}
