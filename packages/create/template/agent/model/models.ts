import type { ModelPolicyAllowEntry } from "@open-everywhere/core/agent/model/policy.js";
import {
  defaultAgentModelId,
  registerDefaultAgentModelId,
} from "@open-everywhere/core/agent/model/default-model.js";
import { getSettings } from "@open-everywhere/core/agent/settings/settings.js";
import { viaProblem, type ModelTargets } from "@open-everywhere/core/agent/model/targets.js";
import { SETTINGS_OVERRIDES } from "../settings/settings.js";
import { resolveStack, resolveTranscription, type ModelRole, type ModelRoleSpec, type ModelStack } from "./stacks.js";

export type { ModelRoleSpec, ModelStack } from "./stacks.js";

const MODEL_SETTINGS = getSettings(SETTINGS_OVERRIDES).models;
const STACK_ALIAS = MODEL_SETTINGS.stack;
const STACK: ModelStack = resolveStack(STACK_ALIAS, {});

assertStackVia(STACK, MODEL_SETTINGS.targets);

registerDefaultAgentModelId(STACK.primary.id);

export const MODELS = {
  primary: { ...STACK.primary, id: defaultAgentModelId(MODEL_SETTINGS) },
  utility: STACK.utility,
  vision: STACK.vision,
  supervisor: STACK.supervisor,
  judge: STACK.judge,
} as const satisfies Record<string, ModelRoleSpec>;

export const MODEL_STACK = STACK_ALIAS;
export const TRANSCRIPTION_ROLE = resolveTranscription(STACK_ALIAS);

export const PRIMARY_MODEL = MODELS.primary.id;
export const UTILITY_MODEL = MODELS.utility.id;
export const VISION_MODEL = MODELS.vision.id;
export const SUPERVISOR_MODEL = MODELS.supervisor.id;
export const SUPERVISOR_VIA = MODELS.supervisor.via;
export const JUDGE_MODEL = MODELS.judge.id;
export const PRIMARY_MODEL_CONTEXT_WINDOW_TOKENS = MODELS.primary.contextWindowTokens;

export function allowListForStack(stack: ModelStack, extra: readonly ModelPolicyAllowEntry[] = []): ModelPolicyAllowEntry[] {
  const out: ModelPolicyAllowEntry[] = [];
  const seen = new Set<string>();
  for (const [role, spec] of Object.entries(stack) as [ModelRole, ModelRoleSpec][]) {
    if (seen.has(spec.id)) continue;
    seen.add(spec.id);
    out.push(role === "vision" ? { id: spec.id, tier: spec.tier, selectable: false } : { id: spec.id, tier: spec.tier });
  }
  for (const entry of extra) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    out.push(entry);
  }
  return out;
}

export function modelAllowList(extra: readonly ModelPolicyAllowEntry[] = []): ModelPolicyAllowEntry[] {
  return allowListForStack(MODELS, extra);
}

export function assertStackVia(stack: ModelStack, targets: ModelTargets): void {
  const bad = (Object.keys(stack) as ModelRole[]).flatMap((role) => viaProblem(stack[role].via, targets, `stack role "${role}"`) ?? []);
  if (bad.length > 0) throw new Error(`open-everywhere: ${bad.join("; ")}`);
}
