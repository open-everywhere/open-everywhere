import {
  modelPricing,
  estimateCostUsd,
  soleConfiguredModel,
  registerModelPricing,
  _resetModelPricingForTest,
  deployerPricedModelIds,
  assertModelPricingValid,
  selectedStackModelIds,
  routePinnedModelIds,
  unpricedModelIds,
  type ModelPricing,
  builtInModelIds,
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

_resetModelPricingForTest();
const BUILT_IN_ID = builtInModelIds()[0];
const priced = modelPricing(BUILT_IN_ID);
ok(priced?.inPerMtok === 0.125 && priced?.outPerMtok === 0.5 && priced?.cachedInPerMtok === 0.01, `built-in: ${BUILT_IN_ID} matches the gateway-billing-MEASURED rate ($0.125/$0.50, cache read $0.01)`);
ok(modelPricing("some/unknown-model") === undefined, "built-in: an unpriced model returns undefined, never a guess");
for (const junk of ["constructor", "toString", "__proto__", "valueOf", "hasOwnProperty"]) {
  ok(modelPricing(junk) === undefined, `built-in: "${junk}" resolves UNPRICED, never an Object.prototype member`);
}

ok(close(estimateCostUsd({ inputTokens: 1_000_000, outputTokens: 1_000_000 }, priced), 0.125 + 0.5), "estimateCostUsd: 1M in + 1M out at the built-in rate");
ok(close(estimateCostUsd({ inputTokens: 500_000 }, priced), 0.125 / 2), "estimateCostUsd: partial input-only usage scales linearly");
ok(close(estimateCostUsd({ inputTokens: 1_000_000, cacheReadTokens: 1_000_000 }, priced), 0.01), "estimateCostUsd: an all-cached prompt bills ONLY the cache rate (input==cached -> $0 non-cached), no double-count");
ok(close(estimateCostUsd({ inputTokens: 1_000_000, cacheReadTokens: 800_000, outputTokens: 100_000 }, priced), 0.2 * priced!.inPerMtok + 0.8 * priced!.cachedInPerMtok! + 0.1 * priced!.outPerMtok), "estimateCostUsd: only the NON-cached remainder of input is billed at the input rate (partial-cache, no double-count)");
ok(estimateCostUsd({ inputTokens: 1_000_000 }, undefined) === undefined, "estimateCostUsd: no pricing -> undefined (tokens-only upstream), never fabricated");
const noCacheRate = { inPerMtok: 2, outPerMtok: 6 };
ok(close(estimateCostUsd({ cacheReadTokens: 1_000_000 }, noCacheRate), 2), "estimateCostUsd: a pricing with no cachedInPerMtok bills cache reads at the plain input rate (conservative, non-underestimating)");
ok(estimateCostUsd({}, priced) === 0, "estimateCostUsd: no usage at all -> $0, not undefined (a real zero, e.g. the sandbox usage-event kind)");

_resetModelPricingForTest();
ok(modelPricing("acme/deployer-only") === undefined, "no deployer table: an id BUILT_IN doesn't name is undefined, never a guess");
ok(modelPricing(BUILT_IN_ID)?.inPerMtok === 0.125, "no deployer table: BUILT_IN lookup behaves exactly as before this seam existed");
ok(deployerPricedModelIds().length === 0, "no deployer table: deployerPricedModelIds is empty");

registerModelPricing({
  [BUILT_IN_ID]: { inPerMtok: 9, outPerMtok: 9 },
  "acme/deployer-only": { inPerMtok: 1, outPerMtok: 2, cachedInPerMtok: 0.5 },
});
ok(modelPricing(BUILT_IN_ID)?.inPerMtok === 9, "deployer table: wins over BUILT_IN for the same model id (the deployer's own committed rate is deliberate)");
ok(modelPricing("acme/deployer-only")?.cachedInPerMtok === 0.5, "deployer table: adds an id BUILT_IN does not name");
ok(modelPricing("totally/unknown") === undefined, "deployer table: an id neither table names stays undefined");
ok(deployerPricedModelIds().join() === [BUILT_IN_ID, "acme/deployer-only"].join(), "deployerPricedModelIds: reports exactly the registered keys");

registerModelPricing({ "acme/other": { inPerMtok: 4, outPerMtok: 5 } });
ok(modelPricing("acme/deployer-only") === undefined, "deployer table: a later register REPLACES the previous table, never merges into it");
ok(modelPricing(BUILT_IN_ID)?.inPerMtok === 0.125, "deployer table: dropping an override restores the BUILT_IN rate for that id");

registerModelPricing({ "acme/one": { inPerMtok: 1, outPerMtok: 1 }, "acme/two": { inPerMtok: 1, outPerMtok: 1 } });
ok(builtInModelIds().length === 1 && builtInModelIds()[0] === BUILT_IN_ID, "builtInModelIds: the deployer table's extra ids are NOT folded in");
ok(soleConfiguredModel() === BUILT_IN_ID, "soleConfiguredModel: unaffected by a many-model deployer table");
_resetModelPricingForTest();

{
  const { registerDefaultAgentModelId, _resetDefaultAgentModelIdForTest } = await import("../agent/model/default-model.js");
  const prevForce = process.env.OE_FORCE_MODEL;
  const prevPrimary = process.env.OE_PRIMARY_MODEL;
  delete process.env.OE_FORCE_MODEL;
  delete process.env.OE_PRIMARY_MODEL;

  _resetDefaultAgentModelIdForTest();
  ok(soleConfiguredModel() === BUILT_IN_ID, "soleConfiguredModel: assumes the built-in entry when nothing has re-pointed the primary (the shipped case — the negative control for the two below)");

  registerDefaultAgentModelId("acme/other-stack-primary");
  ok(soleConfiguredModel() === undefined, "soleConfiguredModel: DECLINES when the app resolved a primary the built-in table does not name (a stack switch) — tokens-only beats a permanently wrong rate");

  _resetDefaultAgentModelIdForTest();
  process.env.OE_PRIMARY_MODEL = "acme/env-pinned";
  ok(soleConfiguredModel() === undefined, "soleConfiguredModel: DECLINES under an OE_PRIMARY_MODEL pin too — the env knobs move the primary with every lint green");
  delete process.env.OE_PRIMARY_MODEL;

  process.env.OE_FORCE_MODEL = "acme/force-pinned";
  ok(soleConfiguredModel() === undefined, "soleConfiguredModel: DECLINES under an OE_FORCE_MODEL hard pin");
  delete process.env.OE_FORCE_MODEL;

  ok(soleConfiguredModel() === BUILT_IN_ID, "soleConfiguredModel: assumes again once the pins are cleared (proves the three declines above are the pins, not a stuck state)");

  if (prevForce !== undefined) process.env.OE_FORCE_MODEL = prevForce;
  if (prevPrimary !== undefined) process.env.OE_PRIMARY_MODEL = prevPrimary;
}

function refuses(table: Record<string, ModelPricing>, label: string): void {
  let threw = false;
  try {
    assertModelPricingValid(table);
  } catch {
    threw = true;
  }
  ok(threw, label);
}
function accepts(table: Record<string, ModelPricing>): boolean {
  try {
    assertModelPricingValid(table);
    return true;
  } catch {
    return false;
  }
}
ok(accepts({ "acme/fine": { inPerMtok: 1, outPerMtok: 2 } }), "assertModelPricingValid: a well-formed table passes");
ok(accepts({ "acme/fine": { inPerMtok: 1, outPerMtok: 2, cachedInPerMtok: 0.5 } }), "assertModelPricingValid: an optional cachedInPerMtok passes");
refuses({ "acme/zero": { inPerMtok: 0, outPerMtok: 2 } }, "assertModelPricingValid: refuses a $0 rate — $0 is how this module says UNPRICED, and an entry saying it would defeat the coverage lint");
refuses({ "acme/neg": { inPerMtok: -1, outPerMtok: 2 } }, "assertModelPricingValid: refuses a negative rate");
refuses({ "acme/nan": { inPerMtok: Number.NaN, outPerMtok: 2 } }, "assertModelPricingValid: refuses a non-finite rate");
refuses({ "acme/missing": { inPerMtok: 1 } as unknown as ModelPricing }, "assertModelPricingValid: refuses a missing outPerMtok");
refuses({ "acme/str": { inPerMtok: "3" as unknown as number, outPerMtok: 2 } }, "assertModelPricingValid: refuses a string rate");
refuses({ "acme/typo": { inPerMtok: 1, outPerMtok: 2, inPerMTok: 3 } as unknown as ModelPricing }, "assertModelPricingValid: refuses a typo'd field name rather than silently ignoring it");
refuses({ "bare-id": { inPerMtok: 1, outPerMtok: 2 } }, "assertModelPricingValid: refuses a key that is not a <vendor>/<model> id");
refuses({ "acme/badcache": { inPerMtok: 1, outPerMtok: 2, cachedInPerMtok: 0 } }, "assertModelPricingValid: refuses a $0 cachedInPerMtok — omit the field instead");
refuses({ "acme/null": null as unknown as ModelPricing }, "assertModelPricingValid: refuses a null entry with a clear message rather than throwing a TypeError");

registerModelPricing({ "acme/one": { inPerMtok: 1, outPerMtok: 2 } });
ok(modelPricing("constructor") === undefined, "deployer table: a prototype member is still UNPRICED once a table is registered");
_resetModelPricingForTest();

const FIXTURE_STACKS = {
  "fixture-a": {
    primary: { id: "acme/one" },
    utility: { id: "acme/one" },
    vision: { id: "acme/two" },
    supervisor: { id: "acme/one" },
    judge: { id: "acme/one" },
  },
  "fixture-b": {
    primary: { id: "acme/three" },
    utility: { id: "acme/three" },
    vision: { id: "acme/two" },
    supervisor: { id: "acme/three" },
    judge: { id: "acme/three" },
  },
};
ok(
  selectedStackModelIds(FIXTURE_STACKS).join() === "acme/one,acme/three,acme/two",
  "selectedStackModelIds: every role of EVERY stack, deduped and sorted — the second stack's ids are covered too",
);
ok(selectedStackModelIds({ solo: { primary: { id: "acme/only" } } }).join() === "acme/only", "selectedStackModelIds: a one-role stack yields exactly its id");

ok(
  routePinnedModelIds([
    { name: "eng", models: { primary: { id: "acme/pinned-a" }, supervisor: { id: "acme/pinned-b" } } },
    { name: "qa", models: { primary: { id: "acme/pinned-a" } } },
  ]).join() === "acme/pinned-a,acme/pinned-b",
  "routePinnedModelIds: collects every concrete route pin across layers, deduped and sorted",
);
ok(routePinnedModelIds([{ name: "tiered", models: { primary: {} } }]).length === 0, "routePinnedModelIds: a route with no concrete id (a tier-only pin) contributes nothing — tiers resolve through the allow-list, enumerated separately");
ok(routePinnedModelIds([{ name: "bare" }, { name: "empty", models: {} }]).length === 0, "routePinnedModelIds: a layer with no models, or an empty models map, contributes nothing");
ok(routePinnedModelIds([{ name: "blank", models: { primary: { id: "" } } }]).length === 0, "routePinnedModelIds: a blank id is not a pin");

_resetModelPricingForTest();
registerModelPricing({ "acme/one": { inPerMtok: 1, outPerMtok: 2 }, "acme/two": { inPerMtok: 1, outPerMtok: 2 } });
ok(
  unpricedModelIds(selectedStackModelIds(FIXTURE_STACKS)).join() === "acme/three",
  "unpricedModelIds: RED — names the one selected model with no committed rate, and only that one",
);
registerModelPricing({
  "acme/one": { inPerMtok: 1, outPerMtok: 2 },
  "acme/two": { inPerMtok: 1, outPerMtok: 2 },
  "acme/three": { inPerMtok: 1, outPerMtok: 2 },
});
ok(unpricedModelIds(selectedStackModelIds(FIXTURE_STACKS)).length === 0, "unpricedModelIds: GREEN once every selected model is priced");
_resetModelPricingForTest();
ok(unpricedModelIds([BUILT_IN_ID]).length === 0, "unpricedModelIds: a BUILT_IN-priced id counts as covered with no deployer entry");
ok(unpricedModelIds(["acme/x", "acme/x"]).join() === "acme/x", "unpricedModelIds: dedupes — one red per id, not one per selection site");

console.log(`✓ pricing: ${passed} assertions passed`);
