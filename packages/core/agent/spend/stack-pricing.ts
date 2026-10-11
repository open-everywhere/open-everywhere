export interface RateBand {
  readonly minPerMtok: number;
  readonly maxPerMtok: number;
}

export interface LongContextBand {
  readonly thresholdInputTokens: number;
  readonly in: RateBand;
  readonly out: RateBand;
}

export interface ModelRateBand {
  readonly in: RateBand;
  readonly out: RateBand;
  readonly longContext?: LongContextBand;
}

function point(ratePerMtok: number): RateBand {
  return { minPerMtok: ratePerMtok, maxPerMtok: ratePerMtok };
}

const STACK_RATES: Readonly<Record<string, ModelRateBand>> = {
  "openai/gpt-6-luna": {
    in: point(0.125),
    out: point(0.5),
    longContext: { thresholdInputTokens: 272_001, in: point(0.25), out: point(0.75) },
  },
  "alibaba/qwen3-vl-instruct": { in: point(0.2), out: point(0.88) },
  "google/gemini-3.8-flash": { in: point(0.75), out: point(3.75) },
  "deepseek/deepseek-v4-flash-0731": {
    in: { minPerMtok: 0.09, maxPerMtok: 0.14 },
    out: { minPerMtok: 0.18, maxPerMtok: 0.28 },
  },
};

export function stackModelRateBand(modelId: string): ModelRateBand | undefined {
  return STACK_RATES[modelId];
}

export function stackPricedModelIds(): readonly string[] {
  return Object.keys(STACK_RATES);
}

export interface RoleTokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export type TokenProfile = Readonly<Record<string, RoleTokenUsage>>;

export interface StackRoleRef {
  readonly id: string;
}

export type StackRoleMap = Readonly<Record<string, StackRoleRef>>;

export interface RoleCostEstimate {
  readonly role: string;
  readonly modelId: string;
  readonly minUsd: number;
  readonly maxUsd: number;
  readonly unpriced: boolean;
}

export interface StackCostEstimate {
  readonly roles: readonly RoleCostEstimate[];
  readonly totalMinUsd: number;
  readonly totalMaxUsd: number;
  readonly partial: boolean;
}

export function estimateStackCostUsd(stack: StackRoleMap, profile: TokenProfile): StackCostEstimate {
  const roles: RoleCostEstimate[] = [];
  let totalMinUsd = 0;
  let totalMaxUsd = 0;
  let partial = false;

  for (const [role, spec] of Object.entries(stack)) {
    const usage: RoleTokenUsage = profile[role] ?? { inputTokens: 0, outputTokens: 0 };
    const band = stackModelRateBand(spec.id);
    if (!band) {
      roles.push({ role, modelId: spec.id, minUsd: 0, maxUsd: 0, unpriced: true });
      partial = true;
      continue;
    }
    const minUsd = (usage.inputTokens * band.in.minPerMtok + usage.outputTokens * band.out.minPerMtok) / 1_000_000;
    const maxUsd = (usage.inputTokens * band.in.maxPerMtok + usage.outputTokens * band.out.maxPerMtok) / 1_000_000;
    roles.push({ role, modelId: spec.id, minUsd, maxUsd, unpriced: false });
    totalMinUsd += minUsd;
    totalMaxUsd += maxUsd;
  }

  return { roles, totalMinUsd, totalMaxUsd, partial };
}
