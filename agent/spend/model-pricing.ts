import { defineModelPricing, assertModelPricingValid, type ModelPricingTable } from "@open-everywhere/core/agent/spend/pricing.js";

const pricing: ModelPricingTable = defineModelPricing({

  "deepseek/deepseek-v4.1-flash": { inPerMtok: 0.3, outPerMtok: 1.2 },

  "alibaba/qwen3-vl-instruct": { inPerMtok: 0.2, outPerMtok: 0.88 },

  "google/gemini-3.8-flash": { inPerMtok: 0.75, outPerMtok: 3.75 },

  "mistral/mistral-small": { inPerMtok: 0.15, outPerMtok: 0.6 },
});

assertModelPricingValid(pricing);

export function loadModelPricing(): ModelPricingTable {
  return pricing;
}
