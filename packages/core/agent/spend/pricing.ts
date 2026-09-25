export interface LongContextTier {
  readonly thresholdInputTokens: number;
  readonly inPerMtok: number;
  readonly outPerMtok: number;
  readonly cachedInPerMtok?: number;
}

export interface ModelPricing {
  readonly inPerMtok: number;
  readonly outPerMtok: number;
  readonly cachedInPerMtok?: number;
  readonly longContext?: LongContextTier;
}

import { defaultAgentModelId } from "../model/default-model.js";

export type ModelPricingTable = Readonly<Record<string, ModelPricing>>;

export type UsageShape = "one-call" | "aggregate";

const BUILT_IN: ModelPricingTable = {
  "openai/gpt-6-luna": {
    inPerMtok: 0.125,
    outPerMtok: 0.5,
    cachedInPerMtok: 0.01,
    longContext: { thresholdInputTokens: 272_001, inPerMtok: 0.25, outPerMtok: 0.75, cachedInPerMtok: 0.02 },
  },
};

let deployerTable: ModelPricingTable = {};

let builtIn: ModelPricingTable = BUILT_IN;

export function _setBuiltInForTest(table: ModelPricingTable | null): void {
  builtIn = table ?? BUILT_IN;
}

export function registerModelPricing(table: ModelPricingTable): void {
  deployerTable = table;
}

export function _resetModelPricingForTest(): void {
  deployerTable = {};
}

export function deployerPricedModelIds(): readonly string[] {
  return Object.keys(deployerTable);
}

export function defineModelPricing(table: ModelPricingTable): ModelPricingTable {
  return table;
}

export function assertModelPricingValid(table: ModelPricingTable): void {
  const bad: string[] = [];
  for (const [modelId, rates] of Object.entries(table)) {
    if (!/^[^/\s]+\/[^/\s]+$/.test(modelId)) {
      bad.push(`  "${modelId}" is not a <vendor>/<model> gateway model id`);
    }
    if (typeof rates !== "object" || rates === null) {
      bad.push(`  "${modelId}" is ${JSON.stringify(rates)} — must be an object of rates`);
      continue;
    }
    const known = new Set(["inPerMtok", "outPerMtok", "cachedInPerMtok", "longContext"]);
    for (const field of Object.keys(rates)) {
      if (!known.has(field)) bad.push(`  "${modelId}" has unknown field "${field}"`);
    }
    for (const field of ["inPerMtok", "outPerMtok"] as const) {
      const v = rates[field];
      if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
        bad.push(`  "${modelId}".${field} is ${JSON.stringify(v)} — must be a finite number > 0`);
      }
    }
    const cached = rates.cachedInPerMtok;
    if (cached !== undefined && (!Number.isFinite(cached) || cached <= 0)) {
      bad.push(`  "${modelId}".cachedInPerMtok is ${JSON.stringify(cached)} — omit it, or give a finite number > 0`);
    }
    if (rates.longContext !== undefined) {
      const tier = rates.longContext;
      if (typeof tier !== "object" || tier === null) {
        bad.push(`  "${modelId}".longContext is ${JSON.stringify(tier)} — omit it, or give an object of tier rates`);
      } else {
        const tierKnown = new Set(["thresholdInputTokens", "inPerMtok", "outPerMtok", "cachedInPerMtok"]);
        for (const field of Object.keys(tier)) {
          if (!tierKnown.has(field)) bad.push(`  "${modelId}".longContext has unknown field "${field}"`);
        }
        const threshold = tier.thresholdInputTokens;
        if (typeof threshold !== "number" || !Number.isInteger(threshold) || threshold <= 0) {
          bad.push(
            `  "${modelId}".longContext.thresholdInputTokens is ${JSON.stringify(threshold)} — must be a whole number of tokens > 0`,
          );
        }
        for (const field of ["inPerMtok", "outPerMtok"] as const) {
          const v = tier[field];
          if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
            bad.push(`  "${modelId}".longContext.${field} is ${JSON.stringify(v)} — must be a finite number > 0`);
          }
        }
        const tierCached = tier.cachedInPerMtok;
        if (tierCached !== undefined && (typeof tierCached !== "number" || !Number.isFinite(tierCached) || tierCached <= 0)) {
          bad.push(
            `  "${modelId}".longContext.cachedInPerMtok is ${JSON.stringify(tierCached)} — omit it, or give a finite number > 0`,
          );
        }
      }
    }
  }
  if (bad.length > 0) {
    throw new Error(
      "open-everywhere: invalid model pricing table:\n" + bad.join("\n") +
        "\n(agent/spend/model-pricing.ts / docs/security/spend-and-cost.md)",
    );
  }
}

export function modelPricing(modelId: string): ModelPricing | undefined {
  return own(deployerTable, modelId) ?? own(builtIn, modelId);
}

function own(table: ModelPricingTable, modelId: string): ModelPricing | undefined {
  return Object.prototype.hasOwnProperty.call(table, modelId) ? table[modelId] : undefined;
}

export function builtInModelIds(): readonly string[] {
  return Object.keys(builtIn);
}

export function soleConfiguredModel(): string | undefined {
  const ids = builtInModelIds();
  if (ids.length !== 1) return undefined;
  return ids[0] === defaultAgentModelId() ? ids[0] : undefined;
}

export interface PricedRoleRef {
  readonly id: string;
}

export function selectedStackModelIds(stacks: Readonly<Record<string, Readonly<Record<string, PricedRoleRef>>>>): readonly string[] {
  const ids = new Set<string>();
  for (const stack of Object.values(stacks)) {
    for (const role of Object.values(stack)) ids.add(role.id);
  }
  return [...ids].sort();
}

export interface RoutePinnedLayer {
  readonly name?: string;
  readonly models?: {
    readonly primary?: { readonly id?: string };
    readonly utility?: { readonly id?: string };
    readonly supervisor?: { readonly id?: string };
  };
}

export function routePinnedModelIds(layers: readonly RoutePinnedLayer[]): readonly string[] {
  const ids = new Set<string>();
  for (const layer of layers) {
    for (const route of Object.values(layer.models ?? {}) as ReadonlyArray<{ readonly id?: string } | undefined>) {
      if (typeof route?.id === "string" && route.id.length > 0) ids.add(route.id);
    }
  }
  return [...ids].sort();
}

export function unpricedModelIds(modelIds: readonly string[]): readonly string[] {
  return [...new Set(modelIds)].filter((id) => modelPricing(id) === undefined).sort();
}

export interface UsageTokens {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
}

export function usdMicrosAtWrite(usage: UsageTokens, model?: string): number {
  const pricing = model ? modelPricing(model) : ((): ModelPricing | undefined => {
    const sole = soleConfiguredModel();
    return sole ? modelPricing(sole) : undefined;
  })();
  const cost = estimateCostUsd(usage, pricing, "one-call");
  return cost === undefined ? 0 : Math.round(cost * 1_000_000);
}

export function estimateCostUsd(
  usage: UsageTokens,
  pricing: ModelPricing | undefined,
  shape: UsageShape = "aggregate",
): number | undefined {
  if (!pricing) return undefined;
  const input = usage.inputTokens ?? 0;
  const output = usage.outputTokens ?? 0;
  const cachedIn = usage.cacheReadTokens ?? 0;
  const nonCachedIn = Math.max(0, input - cachedIn);
  const rates = ratesForPromptSize(pricing, shape === "one-call" ? input : 0);
  const cost = (nonCachedIn * rates.inPerMtok + cachedIn * rates.cachedInPerMtok + output * rates.outPerMtok) / 1_000_000;
  return cost;
}

function ratesForPromptSize(
  pricing: ModelPricing,
  inputTokens: number,
): { inPerMtok: number; outPerMtok: number; cachedInPerMtok: number } {
  const tier = pricing.longContext;
  if (tier !== undefined && inputTokens >= tier.thresholdInputTokens) {
    return {
      inPerMtok: tier.inPerMtok,
      outPerMtok: tier.outPerMtok,
      cachedInPerMtok: tier.cachedInPerMtok ?? tier.inPerMtok,
    };
  }
  return {
    inPerMtok: pricing.inPerMtok,
    outPerMtok: pricing.outPerMtok,
    cachedInPerMtok: pricing.cachedInPerMtok ?? pricing.inPerMtok,
  };
}
