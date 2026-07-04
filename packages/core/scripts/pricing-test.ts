import { modelPricing, estimateCostUsd, _resetPricingCacheForTest } from "../agent/spend/pricing.js";

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
ok(glm?.inPerMtok === 1.4 && glm?.outPerMtok === 4.4 && glm?.cachedInPerMtok === 0.14, "built-in: zai/glm-5.2 matches the verified Fireworks serverless rate");
ok(modelPricing("some/unknown-model") === undefined, "built-in: an unpriced model returns undefined, never a guess");

ok(close(estimateCostUsd({ inputTokens: 1_000_000, outputTokens: 1_000_000 }, glm), 5.8), "estimateCostUsd: 1M in + 1M out at the built-in rate");
ok(close(estimateCostUsd({ inputTokens: 500_000 }, glm), 0.7), "estimateCostUsd: partial input-only usage scales linearly");
ok(close(estimateCostUsd({ inputTokens: 1_000_000, cacheReadTokens: 1_000_000 }, glm), 1.54), "estimateCostUsd: cached input tokens billed at cachedInPerMtok");
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
console.log(`✓ pricing: ${passed} assertions passed`);
