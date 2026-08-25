import { defineModelPricing, assertModelPricingValid, type ModelPricingTable } from "@open-everywhere/core/agent/spend/pricing.js";

const pricing: ModelPricingTable = defineModelPricing({
  "deepseek/deepseek-v4-flash-0731": { inPerMtok: 0.14, outPerMtok: 0.28 },

  "alibaba/qwen3-vl-instruct": { inPerMtok: 0.2, outPerMtok: 0.88 },

  "google/gemini-3.7-flash": { inPerMtok: 0.75, outPerMtok: 3.75 },
});

assertModelPricingValid(pricing);

export function loadModelPricing(): ModelPricingTable {
  return pricing;
}
