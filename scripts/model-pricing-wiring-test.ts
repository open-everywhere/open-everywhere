import { modelPricing, selectedStackModelIds, unpricedModelIds } from "@open-everywhere/core/agent/spend/pricing.js";
import { STACKS } from "../agent/model/stacks.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

const selected = selectedStackModelIds(STACKS);
ok(selected.length > 0, "the shipped stacks select at least one model (otherwise every assertion below is vacuous)");

const unpricedBefore = unpricedModelIds(selected);
ok(
  unpricedBefore.length > 0,
  `before registration at least one selected model is unpriced by BUILT_IN alone (got none — is BUILT_IN pricing every role? that would break lint:model-ids RULE 2)`,
);

await import("../agent/lib/register-config.js");

const unpricedAfter = unpricedModelIds(selected);
ok(
  unpricedAfter.length === 0,
  `after importing agent/lib/register-config.js every selected model resolves a rate — still unpriced: ${unpricedAfter.join(", ")}`,
);
for (const id of unpricedBefore) {
  const rates = modelPricing(id);
  ok(
    rates !== undefined && rates.inPerMtok > 0 && rates.outPerMtok > 0,
    `"${id}" resolves positive in/out rates from the registered deployer table`,
  );
}

console.log(`✓ model-pricing wiring: ${passed} assertions passed (${selected.length} selected model(s) priced after boot registration)`);
