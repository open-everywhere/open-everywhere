import type { ModelPolicyAllowEntry } from "@open-everywhere/core/agent/model/policy.js";
import {
  defaultAgentModelId,
  registerDefaultAgentModelId,
} from "@open-everywhere/core/agent/model/default-model.js";
import { getSettings } from "@open-everywhere/core/agent/settings/settings.js";
import { SETTINGS_OVERRIDES } from "../settings/settings.js";
import { resolveStack, type ModelRoleSpec, type ModelStack } from "./stacks.js";

export type { ModelRole, ModelRoleSpec, ModelStack, StackAlias } from "./stacks.js";

const STACK_ALIAS = getSettings({ ...process.env }, SETTINGS_OVERRIDES).models.stack;

const STACK: ModelStack = resolveStack(STACK_ALIAS, {});

registerDefaultAgentModelId(STACK.primary.id);

export const MODELS = {
  primary: { ...STACK.primary, id: defaultAgentModelId() },
  utility: STACK.utility,
  vision: STACK.vision,
  supervisor: STACK.supervisor,
  judge: STACK.judge,
} as const satisfies Record<string, ModelRoleSpec>;

export const MODEL_STACK = STACK_ALIAS;

export const PRIMARY_MODEL = MODELS.primary.id;
export const UTILITY_MODEL = MODELS.utility.id;
export const VISION_MODEL = MODELS.vision.id;
export const SUPERVISOR_MODEL = MODELS.supervisor.id;
export const JUDGE_MODEL = MODELS.judge.id;

export const PRIMARY_MODEL_CONTEXT_WINDOW_TOKENS = MODELS.primary.contextWindowTokens;
export const UTILITY_MODEL_CONTEXT_WINDOW_TOKENS = MODELS.utility.contextWindowTokens;

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
