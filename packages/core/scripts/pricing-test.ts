import {
  modelPricing,
  estimateCostUsd,
  pricedModelIds,
  soleConfiguredModel,
  registerPricingSource,
  ensurePricingFor,
  _resetPricingCacheForTest,
  _resetPricingSourceForTest,
  type ModelPricing,
  type PricingSource,
} from "../agent/spend/pricing.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

function close(a: number | undefined, b: number): boolean {
  return a !== undefined && Math.abs(a - b) < 1e-9;
}

delete process.env.OE_MODEL_PRICING;
_resetPricingCacheForTest();
const glm = modelPricing("zai/glm-5.2");
ok(glm?.inPerMtok === 1.4 && glm?.outPerMtok === 4.4 && glm?.cachedInPerMtok === 0.26, "built-in: zai/glm-5.2 matches the gateway-billing-verified rate (cache read $0.26)");
ok(modelPricing("some/unknown-model") === undefined, "built-in: an unpriced model returns undefined, never a guess");

ok(close(estimateCostUsd({ inputTokens: 1_000_000, outputTokens: 1_000_000 }, glm), 5.8), "estimateCostUsd: 1M in + 1M out at the built-in rate");
ok(close(estimateCostUsd({ inputTokens: 500_000 }, glm), 0.7), "estimateCostUsd: partial input-only usage scales linearly");
ok(close(estimateCostUsd({ inputTokens: 1_000_000, cacheReadTokens: 1_000_000 }, glm), 0.26), "estimateCostUsd: an all-cached prompt bills ONLY the cache rate (input==cached -> $0 non-cached), no double-count");
ok(close(estimateCostUsd({ inputTokens: 1_000_000, cacheReadTokens: 800_000, outputTokens: 100_000 }, glm), 0.2 * 1.4 + 0.8 * 0.26 + 0.1 * 4.4), "estimateCostUsd: only the NON-cached remainder of input is billed at the input rate (partial-cache, no double-count)");
ok(estimateCostUsd({ inputTokens: 1_000_000 }, undefined) === undefined, "estimateCostUsd: no pricing -> undefined (tokens-only upstream), never fabricated");
const noCacheRate = { inPerMtok: 2, outPerMtok: 6 };
ok(close(estimateCostUsd({ cacheReadTokens: 1_000_000 }, noCacheRate), 2), "estimateCostUsd: a pricing with no cachedInPerMtok bills cache reads at the plain input rate (conservative, non-underestimating)");
ok(estimateCostUsd({}, glm) === 0, "estimateCostUsd: no usage at all -> $0, not undefined (a real zero, e.g. the sandbox usage-event kind)");

process.env.OE_MODEL_PRICING = JSON.stringify({ "zai/glm-5.2": { inPerMtok: 9, outPerMtok: 9 }, "acme/custom": { inPerMtok: 1, outPerMtok: 2, cachedInPerMtok: 0.5 } });
_resetPricingCacheForTest();
ok(modelPricing("zai/glm-5.2")?.inPerMtok === 9, "env override: takes precedence over the built-in table for the same model id");
ok(modelPricing("acme/custom")?.cachedInPerMtok === 0.5, "env override: a deployer can add an arbitrary model id");

process.env.OE_MODEL_PRICING = "{ not json";
_resetPricingCacheForTest();
ok(modelPricing("zai/glm-5.2")?.inPerMtok === 1.4, "env override: malformed JSON is ignored — falls through to the built-in table");

process.env.OE_MODEL_PRICING = "[1,2,3]";
_resetPricingCacheForTest();
ok(modelPricing("zai/glm-5.2")?.inPerMtok === 1.4, "env override: a non-object JSON value is ignored");

process.env.OE_MODEL_PRICING = JSON.stringify({ "acme/bad": { inPerMtok: "nope" }, "acme/good": { inPerMtok: 3, outPerMtok: 4 } });
_resetPricingCacheForTest();
ok(modelPricing("acme/bad") === undefined, "env override: an entry failing shape validation is dropped, not the whole map");
ok(modelPricing("acme/good")?.inPerMtok === 3, "env override: a well-formed sibling entry still resolves");

delete process.env.OE_MODEL_PRICING;
_resetPricingCacheForTest();

_resetPricingSourceForTest();
ok(modelPricing("acme/live-only") === undefined, "no source registered: an id absent from env+built-in is still undefined");
ok(modelPricing("zai/glm-5.2")?.inPerMtok === 1.4, "no source registered: built-in lookup behaves exactly as before this seam existed");

const fakeSource: PricingSource = {
  priceFor(modelId: string): ModelPricing | undefined {
    const table: Record<string, ModelPricing> = {
      "zai/glm-5.2": { inPerMtok: 999, outPerMtok: 999, cachedInPerMtok: 999 },
      "minimax/minimax-m2.7": { inPerMtok: 0.3, outPerMtok: 1.2, cachedInPerMtok: 0.06 },
    };
    return table[modelId];
  },
};
registerPricingSource(fakeSource);
ok(modelPricing("zai/glm-5.2")?.inPerMtok === 1.4, "registered source: the built-in table's entry wins over the source's for the same id (hand-verified beats fetched)");
ok(modelPricing("minimax/minimax-m2.7")?.inPerMtok === 0.3, "registered source: fills a gap the built-in table + env override leave open");
ok(modelPricing("totally/unknown") === undefined, "registered source: an id the source also doesn't have stays undefined, not a guess");

process.env.OE_MODEL_PRICING = JSON.stringify({ "minimax/minimax-m2.7": { inPerMtok: 7, outPerMtok: 7 } });
_resetPricingCacheForTest();
ok(modelPricing("minimax/minimax-m2.7")?.inPerMtok === 7, "registered source: an env override for the same id also wins over the source");
delete process.env.OE_MODEL_PRICING;
_resetPricingCacheForTest();

ok(pricedModelIds().length === 1 && pricedModelIds()[0] === "zai/glm-5.2", "pricedModelIds: registered source's extra ids are NOT folded in");
ok(soleConfiguredModel() === "zai/glm-5.2", "soleConfiguredModel: still resolves from built-in/env only, unaffected by a many-model live source");

registerPricingSource({
  priceFor(): ModelPricing | undefined {
    throw new Error("catalog fetch exploded");
  },
});
let threw = false;
try {
  modelPricing("minimax/minimax-m2.7");
} catch {
  threw = true;
}
ok(!threw, "registered source: a throwing priceFor() is caught — modelPricing never propagates it");
ok(modelPricing("minimax/minimax-m2.7") === undefined, "registered source: a throwing source's id is treated as unpriced, not a crash");
ok(modelPricing("zai/glm-5.2")?.inPerMtok === 1.4, "registered source: a throwing source doesn't disturb built-in lookups for OTHER ids");

_resetPricingSourceForTest();

{
  await ensurePricingFor(["acme/live-only"]);
  ok(true, "ensurePricingFor: no source registered resolves without error");

  registerPricingSource({ priceFor: () => undefined });
  await ensurePricingFor(["acme/live-only"]);
  ok(true, "ensurePricingFor: a source without ensureReady resolves without error");

  let ensureCalls = 0;
  registerPricingSource({
    priceFor: () => undefined,
    ensureReady: async () => {
      ensureCalls++;
    },
  });
  await ensurePricingFor(["zai/glm-5.2", undefined]);
  ok(ensureCalls === 0, "ensurePricingFor: skipped when every id is priced by env/built-in (undefined = unstamped, ignored)");

  let readyResolved = false;
  registerPricingSource({
    priceFor: () => undefined,
    ensureReady: async () => {
      await new Promise((r) => setTimeout(r, 10));
      readyResolved = true;
    },
  });
  await ensurePricingFor(["acme/live-only"]);
  ok(readyResolved, "ensurePricingFor: awaits ensureReady for an id only the source could price");

  registerPricingSource({
    priceFor: () => undefined,
    ensureReady: () => new Promise<void>(() => {}),
  });
  const t0 = Date.now();
  await ensurePricingFor(["acme/live-only"], 30);
  ok(Date.now() - t0 < 5_000, "ensurePricingFor: a hung ensureReady is abandoned at the timeout, never blocks the read");

  registerPricingSource({
    priceFor: () => undefined,
    ensureReady: async () => {
      throw new Error("catalog exploded");
    },
  });
  let ensureThrew = false;
  try {
    await ensurePricingFor(["acme/live-only"]);
  } catch {
    ensureThrew = true;
  }
  ok(!ensureThrew, "ensurePricingFor: a rejecting ensureReady never propagates (fail-soft, same contract as priceFor)");
  _resetPricingSourceForTest();
}

console.log(`✓ pricing: ${passed} assertions passed`);
