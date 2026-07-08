import {
  defineModelPolicy,
  assertModelPolicyValid,
  assertRoutesWithinPolicy,
  applyModelPolicyToRoute,
  clampReasoning,
  isModelUsable,
  isProviderDenied,
  pickTierModel,
  safeFallbackModel,
  reasoningRank,
  type ModelPolicy,
} from "../agent/model/policy.js";
import { defineDomain, reasoningCeilingFor, type Domain, type NamedKnobLayer } from "../agent/memory/domain.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exitCode = 1;
    return;
  }
  passed++;
}
function throws(fn: () => unknown, label: string): void {
  try {
    fn();
    console.error(`✗ ${label} (expected throw, got none)`);
    process.exitCode = 1;
  } catch {
    passed++;
  }
}

const POLICY: ModelPolicy = defineModelPolicy({
  allow: [
    { id: "zai/glm-5.2", tier: "high" },
    { id: "zai/glm-4.5-air", tier: "medium" },
    { id: "deepseek/deepseek-v4-flash", tier: "low" },
  ],
  reasoningCeiling: "medium",
});

assertModelPolicyValid(POLICY);
passed++;
throws(() => assertModelPolicyValid({ allow: [{ id: "a/b", tier: "high" }, { id: "a/b", tier: "low" }] }), "validator: duplicate allow-list id throws");
throws(() => assertModelPolicyValid({ allow: [{ id: "a/b", tier: "mega" as never }] }), "validator: unknown tier throws");
throws(() => assertModelPolicyValid({ reasoningCeiling: "ludicrous" as never }), "validator: bad reasoningCeiling throws");
throws(() => assertModelPolicyValid({ allow: [{ id: "zai/glm-5.2", tier: "high" }], providerDeny: ["zai"] }), "validator: allow-listed model whose own vendor is denied throws (contradiction)");
throws(() => assertModelPolicyValid({ allow: [{ id: "  ", tier: "low" }] }), "validator: blank id throws");

ok(isModelUsable("zai/glm-5.2", POLICY), "usable: allow-listed id passes");
ok(!isModelUsable("openai/gpt-6", POLICY), "usable: non-allow-listed id fails");
ok(isModelUsable("anything/at-all", undefined), "usable: no policy → everything usable (backward-compat)");
const DENY: ModelPolicy = defineModelPolicy({ allow: [{ id: "deepseek/deepseek-v4-flash", tier: "low" }], providerDeny: ["zai"] });
ok(isProviderDenied("zai/glm-5.2", DENY), "deny: vendor prefix matched");
ok(!isProviderDenied("deepseek/deepseek-v4-flash", DENY), "deny: non-denied vendor passes");
ok(!isModelUsable("zai/glm-5.2", DENY), "usable: denied-vendor model is unusable even if it were allow-listed");
ok(pickTierModel("high", POLICY) === "zai/glm-5.2", "tier: high → the high-tier allow entry");
ok(pickTierModel("low", POLICY) === "deepseek/deepseek-v4-flash", "tier: low → the low-tier allow entry");
ok(safeFallbackModel(POLICY, "fallback/default") === "deepseek/deepseek-v4-flash", "fallback: cheapest usable allow entry (low tier first)");
ok(safeFallbackModel(undefined, "fallback/default") === "fallback/default", "fallback: no policy → the agent static default");

ok(reasoningRank("high") > reasoningRank("medium") && reasoningRank("xhigh") > reasoningRank("high"), "rank: ascending effort order");
ok(clampReasoning("high", "medium") === "medium", "clamp: high under a medium ceiling → medium");
ok(clampReasoning("xhigh", "medium") === "medium", "clamp: xhigh under a medium ceiling → medium");
ok(clampReasoning("low", "medium") === "low", "clamp: below-ceiling request passes through");
ok(clampReasoning(undefined, "medium") === undefined, "clamp: no request stays undefined (never manufactures one)");
ok(clampReasoning("high", "xhigh") === "high", "clamp: request at/under a raised ceiling passes");

{
  const r = applyModelPolicyToRoute({ id: "anything/goes", reasoning: "xhigh" }, undefined, "def/model");
  ok(r.id === "anything/goes" && r.reasoning === "xhigh" && r.warnings.length === 0, "envelope: policy ABSENT → route passes through unchanged (backward-compat)");
}
{
  const r = applyModelPolicyToRoute({ tier: "high" }, POLICY, "def/model");
  ok(r.id === "zai/glm-5.2", "envelope: a tier resolves to the org's model for that tier");
  const r2 = applyModelPolicyToRoute({ id: "deepseek/deepseek-v4-flash", tier: "high" }, POLICY, "def/model");
  ok(r2.id === "deepseek/deepseek-v4-flash", "envelope: a concrete id wins over a tier on the same route");
}
{
  const r = applyModelPolicyToRoute({ id: "openai/gpt-6" }, POLICY, "def/model");
  ok(r.id === "deepseek/deepseek-v4-flash" && r.warnings.length === 1, "envelope: an unusable id fails soft to a safe allow-listed model + warns");
}
{
  const r = applyModelPolicyToRoute({}, POLICY, "def/model");
  ok(r.id === undefined, "envelope: an unrouted call ({}) is never forced an id");
}
{
  const r = applyModelPolicyToRoute({ reasoning: "xhigh" }, POLICY, "def/model", "high");
  ok(r.reasoning === "high" && r.warnings.length === 1, "envelope: reasoning clamps to the passed effectiveCeiling (high), not the policy default (medium)");
  const r2 = applyModelPolicyToRoute({ reasoning: "high" }, POLICY, "def/model");
  ok(r2.reasoning === "medium", "envelope: with no effectiveCeiling, reasoning clamps to the policy default (medium)");
}

{
  const domains: Domain[] = [
    defineDomain({ name: "org", match: "org" }),
    defineDomain({ name: "engineering", channels: ["slack/T1/C_ENG"], reasoningCeiling: "high" }),
    defineDomain({ name: "finance", channels: ["slack/T1/C_FIN"], reasoningCeiling: "low" }),
    defineDomain({ name: "support", channels: ["slack/T1/C_SUP"] }),
  ];
  const roles: NamedKnobLayer[] = [];
  ok(reasoningCeilingFor("slack/T1/C_ENG", domains, roles, undefined, "medium") === "high", "ceiling: engineering domain RAISES medium → high");
  ok(reasoningCeilingFor("slack/T1/C_FIN", domains, roles, undefined, "medium") === "low", "ceiling: finance domain LOWERS medium → low");
  ok(reasoningCeilingFor("slack/T1/C_SUP", domains, roles, undefined, "medium") === "medium", "ceiling: a domain setting nothing inherits the base default");
  ok(reasoningCeilingFor("slack/T1/C_UNKNOWN", domains, roles, undefined, "medium") === "medium", "ceiling: an unassigned channel gets the base default");
}

{
  const good: Domain[] = [defineDomain({ name: "a", channels: ["slack/T1/Ca"], models: { primary: { id: "zai/glm-5.2" } } })];
  assertRoutesWithinPolicy(good, [], POLICY);
  passed++;
  const badId: Domain[] = [defineDomain({ name: "b", channels: ["slack/T1/Cb"], models: { primary: { id: "openai/gpt-6" } } })];
  throws(() => assertRoutesWithinPolicy(badId, [], POLICY), "routes: a domain naming a non-allow-listed concrete model throws at config load");
  const badTier: Domain[] = [defineDomain({ name: "c", channels: ["slack/T1/Cc"], models: { primary: { tier: "high" } } })];
  const noHighPolicy: ModelPolicy = defineModelPolicy({ allow: [{ id: "deepseek/deepseek-v4-flash", tier: "low" }] });
  throws(() => assertRoutesWithinPolicy(badTier, [], noHighPolicy), "routes: a domain asking a tier the allow-list can't fulfil throws");
  assertRoutesWithinPolicy(badId, [], undefined);
  passed++;
  const badRole: NamedKnobLayer[] = [{ name: "r", models: { primary: { id: "openai/gpt-6" } } }];
  throws(() => assertRoutesWithinPolicy([], badRole, POLICY), "routes: a ROLE naming a non-allow-listed model throws too");
}

console.log(`model-policy: ${passed} assertions passed`);
