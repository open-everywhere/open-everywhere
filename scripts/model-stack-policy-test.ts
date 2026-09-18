import {
  SHIPPED_STACK,
  STACKS,
  STACK_ALIASES,
  compactionThresholdTokens,
  isStackAlias,
  resolveStack,
  stackModelIds,
  type ModelRole,
  type ModelStack,
  type StackAlias,
} from "../agent/model/stacks.js";
import {
  JUDGE_MODEL,
  MODELS,
  MODEL_STACK,
  PRIMARY_MODEL,
  PRIMARY_MODEL_CONTEXT_WINDOW_TOKENS,
  SUPERVISOR_MODEL,
  UTILITY_MODEL,
  VISION_MODEL,
  allowListForStack,
  modelAllowList,
} from "../agent/model/models.js";
import { loadModelPolicy } from "../agent/model/policy.js";
import { SETTINGS_OVERRIDES } from "../agent/settings/settings.js";
import { getSettings } from "@open-everywhere/core/agent/settings/settings.js";
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
    defineDomain({ name: "gate", reach: [CHANNEL] }),
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

{
  const percent = getSettings(process.env, SETTINGS_OVERRIDES).agent.compactionThresholdPercent;
  const shippedPercent = getSettings(process.env, {}).agent.compactionThresholdPercent;

  const resolvedPrimaryWindow = resolveStack(MODEL_STACK).primary.contextWindowTokens;
  ok(
    PRIMARY_MODEL_CONTEXT_WINDOW_TOKENS === resolvedPrimaryWindow,
    `PRIMARY_MODEL_CONTEXT_WINDOW_TOKENS is ${PRIMARY_MODEL_CONTEXT_WINDOW_TOKENS}, but the resolved stack ` +
      `"${MODEL_STACK}" declares a primary window of ${resolvedPrimaryWindow}. The window eve takes the compaction ` +
      `fraction of MUST come from the registry entry for the active stack's primary (agent/model/models.ts), never ` +
      `from a literal — a literal is right for today's stacks and wrong for the first small-window one.`,
  );

  ok(
    shippedPercent === 0.5 && percent === shippedPercent,
    `this deployment resolves compactionThresholdPercent to ${percent} against a shipped ${shippedPercent}; both must be ` +
      `0.5 — the OPE-672 exercise override was retired by OPE-794 and nothing should re-introduce one here.`,
  );
  ok(
    getSettings(process.env, {}).window.topology === false && getSettings(process.env, SETTINGS_OVERRIDES).window.topology === true,
    `the override-is-respected control needs a row this deployment genuinely overrides: window.topology resolves ` +
      `${getSettings(process.env, SETTINGS_OVERRIDES).window.topology} against a shipped ${getSettings(process.env, {}).window.topology}, expected true against false.`,
  );

  ok(SHIPPED_STACK === "american-closed", `SHIPPED_STACK is "${SHIPPED_STACK}", expected "american-closed" — pin (c) below names it.`);
  const luna = resolveStack("american-closed");
  ok(
    luna.primary.contextWindowTokens === 1_050_000,
    `the american-closed primary declares a ${luna.primary.contextWindowTokens}-token window, expected 1050000.`,
  );
  const lunaThreshold = compactionThresholdTokens(luna.primary.contextWindowTokens, percent);
  ok(
    lunaThreshold === 525_000,
    `american-closed compacts at ${lunaThreshold} tokens, expected 525000 (1050000 × 0.5).`,
  );

  const contextSizeTrigger = getSettings(process.env, SETTINGS_OVERRIDES).rotation.contextSizeTokens;
  ok(
    contextSizeTrigger < lunaThreshold,
    `the context-size rotation trigger is ${contextSizeTrigger} tokens and compaction fires at ${lunaThreshold} — the trigger ` +
      `MUST be lower, or a standing seat compacts before it rotates and never re-mints with a tail (OPE-794).`,
  );

  const SMALL_WINDOW = 272_000;
  const small = resolveStack("american-closed", { primary: { contextWindowTokens: SMALL_WINDOW } });
  const smallThreshold = compactionThresholdTokens(small.primary.contextWindowTokens, percent);
  ok(
    smallThreshold === 136_000,
    `a ${SMALL_WINDOW}-token primary compacts at ${smallThreshold}, expected 136000 (${SMALL_WINDOW} × ${percent}).`,
  );
  ok(
    smallThreshold < lunaThreshold,
    `a ${SMALL_WINDOW}-token primary compacts at ${smallThreshold}, which is NOT below the 1050000-token primary's ` +
      `${lunaThreshold}. The threshold must track the window, or a small-window stack overruns its context.`,
  );
  ok(
    Math.abs(smallThreshold / SMALL_WINDOW - lunaThreshold / 1_050_000) < 1e-9,
    `the two stacks compact at different FRACTIONS of their windows (${smallThreshold / SMALL_WINDOW} vs ` +
      `${lunaThreshold / 1_050_000}). One ratio governs every stack; an absolute per family is what OPE-715 refused.`,
  );
  ok(
    compactionThresholdTokens(1_000_000, percent) !== smallThreshold,
    `a hard-coded 1M window and the ${SMALL_WINDOW}-token stack yield the SAME threshold, so (d) cannot tell a ` +
      `derived window from a fixed one.`,
  );

  for (const alias of Object.keys(STACKS) as StackAlias[]) {
    const stack = resolveStack(alias);
    const w = stack.primary.contextWindowTokens;
    const t = compactionThresholdTokens(w, percent);
    ok(
      t > 0 && t < w,
      `[${alias}] compacts at ${t} tokens against a ${w}-token primary window — a threshold must be strictly ` +
        `between 0 and the window.`,
    );
  }

  ok(compactionThresholdTokens(1, 0.2) === 1, `a 1-token window must floor to a threshold of 1, got ${compactionThresholdTokens(1, 0.2)}.`);
}

{
  ok([...STACK_ALIASES].sort().join(",") === Object.keys(STACKS).sort().join(","), `STACK_ALIASES enumerates exactly the shipped stacks (got ${STACK_ALIASES.join(", ")})`);
  ok([...STACK_ALIASES].join(",") === [...STACK_ALIASES].sort().join(","), "…sorted, so the error message and the docs table read the same way every run");
  for (const alias of STACK_ALIASES) ok(isStackAlias(alias), `isStackAlias accepts the shipped alias ${alias}`);
  ok(!isStackAlias("american-close"), "isStackAlias refuses a near-miss typo (the failure the alias exists to catch)");
  ok(!isStackAlias("toString"), "…and an inherited Object property, which a bare `in` check would admit");
  ok(isStackAlias(SHIPPED_STACK), "SHIPPED_STACK names a shipped stack");

  for (const [alias, stack] of Object.entries(STACKS)) {
    const ids = stackModelIds(stack);
    ok(new Set(ids).size === ids.length, `${alias}: stackModelIds dedupes (got ${ids.join(", ")})`);
    ok([...ids].sort().join(",") === ids.join(","), `${alias}: stackModelIds is sorted`);
    for (const role of Object.values(stack)) ok(ids.includes(role.id), `${alias}: stackModelIds carries every role's id (missing ${role.id})`);
  }

  const resolved = resolveStack(MODEL_STACK, {});
  ok(isStackAlias(MODEL_STACK), `MODEL_STACK is a shipped alias (got ${MODEL_STACK})`);
  ok(MODEL_STACK === getSettings(process.env, SETTINGS_OVERRIDES).models.stack, "MODEL_STACK is the alias the settings schema resolved — one source, not a second copy");
  ok(MODELS.utility.id === resolved.utility.id, `UTILITY_MODEL/MODELS.utility is the stack's utility id (got ${MODELS.utility.id}, want ${resolved.utility.id})`);
  ok(UTILITY_MODEL === MODELS.utility.id, "UTILITY_MODEL re-exports MODELS.utility.id");
  ok(VISION_MODEL === resolved.vision.id, `VISION_MODEL is the stack's vision id (got ${VISION_MODEL}, want ${resolved.vision.id})`);
  ok(SUPERVISOR_MODEL === resolved.supervisor.id, `SUPERVISOR_MODEL is the stack's supervisor id (got ${SUPERVISOR_MODEL}, want ${resolved.supervisor.id})`);
  ok(JUDGE_MODEL === resolved.judge.id, `JUDGE_MODEL is the stack's judge id (got ${JUDGE_MODEL}, want ${resolved.judge.id})`);
  ok(PRIMARY_MODEL === MODELS.primary.id, "PRIMARY_MODEL re-exports MODELS.primary.id");
  ok(PRIMARY_MODEL_CONTEXT_WINDOW_TOKENS === MODELS.primary.contextWindowTokens, "the exported primary window is the primary role's own, never a literal beside it");
  ok(VISION_MODEL !== PRIMARY_MODEL, "🔴 the describer is NOT the conversational model — a text turn on a vision model answers badly instead of erroring");

  const mine = modelAllowList();
  ok(mine.map((e) => e.id).join(",") === allowListForStack(MODELS).map((e) => e.id).join(","), "modelAllowList() is allowListForStack over the roles this process resolved");
  const appPolicy = loadModelPolicy();
  ok(appPolicy !== undefined, "loadModelPolicy() returns this deployment's declared envelope");
  if (appPolicy !== undefined) {
    assertModelPolicyValid(appPolicy);
    const declaredAllow = appPolicy.allow ?? [];
    ok(declaredAllow.map((e) => e.id).sort().join(",") === mine.map((e) => e.id).sort().join(","), "…and its allow-list is the derived one, not a hand-copied list that can drift");
    for (const id of stackModelIds(resolved)) ok(isModelUsable(id, appPolicy), `…every role id of the resolved stack is usable under it (${id})`);
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
    `a stale domain pick fails soft onto the role's own model, and the compaction threshold is derived from each ` +
    `stack's primary window.`,
);
