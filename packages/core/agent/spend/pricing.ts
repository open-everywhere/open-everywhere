export interface ModelPricing {
  readonly inPerMtok: number;
  readonly outPerMtok: number;
  readonly cachedInPerMtok?: number;
}

const BUILT_IN: Readonly<Record<string, ModelPricing>> = {
  "openai/gpt-5.6-luna": { inPerMtok: 0.25, outPerMtok: 1.2, cachedInPerMtok: 0.02 },
};

let envTable: Readonly<Record<string, ModelPricing>> | null | undefined;

function isModelPricing(v: unknown): v is ModelPricing {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.inPerMtok === "number" &&
    typeof o.outPerMtok === "number" &&
    (o.cachedInPerMtok === undefined || typeof o.cachedInPerMtok === "number")
  );
}

function envPricingTable(): Readonly<Record<string, ModelPricing>> {
  if (envTable !== undefined) return envTable ?? {};
  const raw = process.env.OE_MODEL_PRICING;
  if (!raw) {
    envTable = null;
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) throw new Error("not an object");
    const out: Record<string, ModelPricing> = {};
    for (const [modelId, val] of Object.entries(parsed as Record<string, unknown>)) {
      if (isModelPricing(val)) out[modelId] = val;
    }
    envTable = out;
  } catch (err) {
    console.warn(`[open-everywhere:pricing] OE_MODEL_PRICING ignored (malformed JSON): ${String(err)}`);
    envTable = null;
  }
  return envTable ?? {};
}

export function _resetPricingCacheForTest(): void {
  envTable = undefined;
}

export interface PricingSource {
  priceFor(modelId: string): ModelPricing | undefined;
  ensureReady?(): Promise<void>;
}

let pricingSource: PricingSource | null = null;

export function registerPricingSource(source: PricingSource): void {
  pricingSource = source;
}

export function _resetPricingSourceForTest(): void {
  pricingSource = null;
}

const ENSURE_READY_TIMEOUT_MS = 3_000;

export async function ensurePricingFor(modelIds: readonly (string | undefined)[], timeoutMs: number = ENSURE_READY_TIMEOUT_MS): Promise<void> {
  const source = pricingSource;
  if (!source?.ensureReady) return;
  const needsSource = modelIds.some((id) => id !== undefined && !envPricingTable()[id] && !BUILT_IN[id]);
  if (!needsSource) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      source.ensureReady(),
      new Promise<void>((resolveRace) => {
        timer = setTimeout(resolveRace, timeoutMs);
      }),
    ]);
  } catch (err) {
    console.warn(`[open-everywhere:pricing] PricingSource ensureReady failed — affected models will show unpriced: ${String(err)}`);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function modelPricing(modelId: string): ModelPricing | undefined {
  const configured = envPricingTable()[modelId] ?? BUILT_IN[modelId];
  if (configured) return configured;
  if (!pricingSource) return undefined;
  try {
    return pricingSource.priceFor(modelId) ?? undefined;
  } catch (err) {
    console.warn(`[open-everywhere:pricing] registered PricingSource threw for "${modelId}" — treating as unpriced: ${String(err)}`);
    return undefined;
  }
}

export function pricedModelIds(): string[] {
  return [...new Set([...Object.keys(BUILT_IN), ...Object.keys(envPricingTable())])];
}

export function builtInModelIds(): readonly string[] {
  return Object.keys(BUILT_IN);
}

export function soleConfiguredModel(): string | undefined {
  const ids = pricedModelIds();
  return ids.length === 1 ? ids[0] : undefined;
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
  const cost = estimateCostUsd(usage, pricing);
  return cost === undefined ? 0 : Math.round(cost * 1_000_000);
}

export function estimateCostUsd(usage: UsageTokens, pricing: ModelPricing | undefined): number | undefined {
  if (!pricing) return undefined;
  const input = usage.inputTokens ?? 0;
  const output = usage.outputTokens ?? 0;
  const cachedIn = usage.cacheReadTokens ?? 0;
  const nonCachedIn = Math.max(0, input - cachedIn);
  const cachedRate = pricing.cachedInPerMtok ?? pricing.inPerMtok;
  const cost = (nonCachedIn * pricing.inPerMtok + cachedIn * cachedRate + output * pricing.outPerMtok) / 1_000_000;
  return cost;
}
