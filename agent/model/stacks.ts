import type { ModelTier } from "@open-everywhere/core/agent/memory/domain.js";

export type ModelRole = "primary" | "utility" | "vision" | "supervisor" | "judge";

export interface ModelRoleSpec {
  readonly id: string;
  readonly tier: ModelTier;
  readonly contextWindowTokens: number;
}

export type ModelStack = Readonly<Record<ModelRole, ModelRoleSpec>>;

export const STACKS = {
  "chinese-open-weights": {
    primary: { id: "deepseek/deepseek-v4-flash-0731", tier: "high", contextWindowTokens: 1_000_000 },
    utility: { id: "deepseek/deepseek-v4-flash-0731", tier: "low", contextWindowTokens: 1_000_000 },
    vision: { id: "alibaba/qwen3-vl-instruct", tier: "low", contextWindowTokens: 131_072 },
    supervisor: { id: "deepseek/deepseek-v4-flash-0731", tier: "low", contextWindowTokens: 1_000_000 },
    judge: { id: "deepseek/deepseek-v4-flash-0731", tier: "low", contextWindowTokens: 1_000_000 },
  },

  "american-closed": {
    primary: { id: "openai/gpt-6-luna", tier: "high", contextWindowTokens: 1_050_000 },
    utility: { id: "openai/gpt-6-luna", tier: "low", contextWindowTokens: 1_050_000 },
    vision: { id: "google/gemini-3.7-flash", tier: "low", contextWindowTokens: 1_000_000 },
    supervisor: { id: "openai/gpt-6-luna", tier: "low", contextWindowTokens: 1_050_000 },
    judge: { id: "openai/gpt-6-luna", tier: "low", contextWindowTokens: 1_050_000 },
  },
} as const satisfies Record<string, ModelStack>;

export type StackAlias = keyof typeof STACKS;

export const STACK_ALIASES: readonly StackAlias[] = (Object.keys(STACKS) as StackAlias[]).sort();

export function stackModelIds(stack: ModelStack): readonly string[] {
  return [...new Set(Object.values(stack).map((s) => s.id))].sort();
}

export function compactionThresholdTokens(contextWindowTokens: number, thresholdPercent: number): number {
  return Math.max(1, Math.floor(contextWindowTokens * thresholdPercent));
}

export const SHIPPED_STACK: StackAlias = "american-closed";

export type StackOverrides = {
  readonly [R in ModelRole]?: Partial<ModelRoleSpec>;
};

export function isStackAlias(alias: string): alias is StackAlias {
  return Object.prototype.hasOwnProperty.call(STACKS, alias);
}

export function resolveStack(alias: string, overrides: StackOverrides = {}): ModelStack {
  if (!isStackAlias(alias)) {
    throw new Error(
      `open-everywhere: unknown model stack "${alias}" — shipped stacks are ${STACK_ALIASES.map((a) => `"${a}"`).join(", ")}. ` +
        `Add one in agent/model/stacks.ts, or set models.stack (env OE_MODEL_STACK) to a shipped alias.`,
    );
  }
  const base = STACKS[alias];
  const out = {} as { -readonly [R in ModelRole]: ModelRoleSpec };
  for (const role of Object.keys(base) as ModelRole[]) {
    out[role] = { ...base[role], ...overrides[role] };
  }
  return out;
}
