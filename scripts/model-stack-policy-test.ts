import { STACKS, resolveStack, type ModelRole, type ModelStack, type StackAlias } from "../agent/model/stacks.js";
import { allowListForStack } from "../agent/model/models.js";
import {
  assertModelPolicyValid,
  defineModelPolicy,
  isModelUsable,
  pickTierModel,
  safeFallbackModel,
  type ModelPolicy,
} from "@open-everywhere/core/agent/model/policy.js";
import { resolveRoute, type ModelBackend, type RoutingDeps } from "@open-everywhere/core/agent/model/routing.js";
import { defineDomain, type Domain, type ModelTier } from "@open-everywhere/core/agent/memory/domain.js";

delete process.env.OE_FORCE_MODEL;

let passed = 0;
const reds: string[] = [];
function ok(cond: boolean, label: string): void {
  if (cond) passed++;
  else reds.push(label);
}

const TEXT_ROLES = ["primary", "utility", "supervisor", "judge"] as const;
const ALL_TIERS: readonly ModelTier[] = ["high", "medium", "low"];

const UNSET_DEFAULT = "nostack/no-static-default";
const STALE_PICK = "nostack/a-model-the-envelope-never-heard-of";

function policyFor(stack: ModelStack): ModelPolicy {
  return defineModelPolicy({ allow: allowListForStack(stack), reasoningCeiling: "medium" });
}

const CHANNEL = "slack/T1/C_GATE";

function deps(policy: ModelPolicy, pickedId: string | undefined): RoutingDeps {
  const domains: Domain[] = [
    defineDomain({ name: "org", match: "org" }),
    defineDomain({ name: "gate", channels: [CHANNEL] }),
  ];
  const backend: ModelBackend = {
    model: (id) => ({ specificationVersion: "v4", provider: "gate", modelId: id, supportedUrls: {}, doGenerate: async () => ({}), doStream: async () => ({}) }),
    applyOptions: (_r, o) => o,
  };
  return {
    domains: () => domains,
    roles: () => [],
    modelPolicy: () => policy,
    domainModelPick: async () => (pickedId === undefined ? null : { modelId: pickedId }),
    backend,
  };
}

for (const alias of Object.keys(STACKS) as StackAlias[]) {
  const stack = resolveStack(alias);
  const policy = policyFor(stack);
  const textIds = new Set(TEXT_ROLES.map((r) => stack[r].id));
  const visionIsAlsoText = textIds.has(stack.vision.id);

  try {
    assertModelPolicyValid(policy);
    passed++;
  } catch (e) {
    reds.push(`[${alias}] the derived allow-list is not a valid policy: ${(e as Error).message}`);
  }

  for (const role of ["primary", "utility"] as const) {
    const got = safeFallbackModel(policy, UNSET_DEFAULT, stack[role].id);
    ok(
      got === stack[role].id,
      `[${alias}] safeFallbackModel for the ${role} slot resolved "${got}", expected the stack's ${role} "${stack[role].id}" — ` +
        `a substitution must stay on the role's own model, not fall to whatever the allow-list lists cheapest.`,
    );
  }

  for (const tier of ALL_TIERS) {
    const picked = pickTierModel(tier, policy);
    ok(
      visionIsAlsoText || picked !== stack.vision.id,
      `[${alias}] tier "${tier}" resolves to "${picked}", which is the VISION role's model. A tier pick puts that ` +
        `model on a conversational turn, where a describe-only model answers badly instead of erroring — mark the ` +
        `vision entry \`selectable: false\` (agent/model/models.ts allowListForStack).`,
    );
  }

  for (const role of [...TEXT_ROLES, "vision"] as readonly ModelRole[]) {
    ok(
      isModelUsable(stack[role].id, policy),
      `[${alias}] role "${role}" runs "${stack[role].id}", which its OWN stack's derived allow-list rejects. ` +
        `Every role's id is allow-listed by construction; if this fails the derivation dropped an entry.`,
    );
  }

  for (const role of ["primary", "utility", "supervisor"] as const) {
    const roleDefault = stack[role].id;
    const route = await resolveRoute(role, CHANNEL, undefined, roleDefault, deps(policy, STALE_PICK));
    const got = route.id;
    ok(
      got !== undefined && textIds.has(got),
      `[${alias}] an out-of-envelope domain pick on the "${role}" route was substituted with "${got}", which is not a ` +
        `TEXT role of this stack (${[...textIds].join(", ")}). A stale \`domain_model\` row must fail soft onto a turn ` +
        `model, never onto the describer.`,
    );
    ok(
      got === roleDefault,
      `[${alias}] the "${role}" route's out-of-envelope pick resolved to "${got}", expected its role default "${roleDefault}".`,
    );
  }
}

if (reds.length > 0) {
  console.error(`✗ model-stacks: ${reds.length} failure(s) across ${Object.keys(STACKS).length} stack(s):\n`);
  for (const r of reds) console.error(`  • ${r}`);
  process.exit(1);
}

console.log(
  `✓ model-stacks: ${passed} assertions passed across ${Object.keys(STACKS).length} shipped stack(s) ` +
    `(${Object.keys(STACKS).join(", ")}) — role-default fallback, no tier selects the describer, every role usable, ` +
    `and a stale domain pick fails soft onto the role's own model.`,
);
