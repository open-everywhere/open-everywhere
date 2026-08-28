import { readFileSync } from "node:fs";
import { SETTINGS } from "@open-everywhere/core/agent/settings/settings.js";
import {
  registerModelPricing,
  selectedStackModelIds,
  routePinnedModelIds,
  unpricedModelIds,
  builtInModelIds,
  deployerPricedModelIds,
  modelPricing,
} from "@open-everywhere/core/agent/spend/pricing.js";
import { stackModelRateBand } from "@open-everywhere/core/agent/spend/stack-pricing.js";
import { SHIPPED_STACK, STACKS, STACK_ALIASES, isStackAlias } from "../agent/model/stacks.js";
import { loadModelPricing } from "../agent/spend/model-pricing.js";
import { loadModelPolicy } from "../agent/model/policy.js";
import { loadRoles } from "../agent/roles/roles.js";
import { loadDomains } from "../agent/memory/config/domains.js";
import { MODEL_ID, PRICE_TABLE, REGISTRY, ruleOneFiles, scanBareModelIds } from "./model-ids-scope.js";

const RESOLVER = "agent/model/models.ts";
const PRICING = "packages/core/agent/spend/pricing.ts";
const CORE_DEFAULT = "packages/core/agent/model/default-model.ts";

const reds: string[] = [];

let scanned = 0;
try {
  const files = ruleOneFiles();
  scanned = files.length;
  for (const hit of scanBareModelIds(files)) {
    reds.push(
      `BARE MODEL ID: ${hit.file}:${hit.line} names "${hit.id}" directly. Import the role const from ` +
        `${RESOLVER} instead (PRIMARY_MODEL / UTILITY_MODEL / VISION_MODEL / SUPERVISOR_MODEL / JUDGE_MODEL), ` +
        `or put the id in a stack in ${REGISTRY} if it is a distinct job or a new stack.`,
    );
  }
} catch (err) {
  reds.push(`UNREADABLE FILE SET: RULE 1 could not list the app tree — ${err instanceof Error ? err.message : String(err)}`);
}

const resolverSrc = readFileSync(RESOLVER, "utf8");
const pricingSrc = readFileSync(PRICING, "utf8");

const shippedPrimary = STACKS[SHIPPED_STACK].primary.id;

const builtIn = pricingSrc.match(/const BUILT_IN[^=]*=\s*\{([\s\S]*?)\n\};/);
if (!builtIn) {
  reds.push(`UNREADABLE: could not locate the BUILT_IN table in ${PRICING} — this gate needs updating alongside it.`);
} else {
  const ids = [...builtIn[1].matchAll(/["']([^"']+)["']\s*:\s*\{/g)].map((m) => m[1]);
  if (ids.length !== 1) {
    reds.push(
      `BUILT_IN has ${ids.length} entries (${ids.join(", ") || "none"}), must have exactly 1. ` +
        `Two or more make soleConfiguredModel() return undefined, silently disabling the $ fallback ` +
        `for stampless usage rows; zero disables it outright. See the comment in ${PRICING}.`,
    );
  } else if (ids[0] !== shippedPrimary) {
    reds.push(
      `PRICING/DEFAULT MISMATCH: ${PRICING} prices "${ids[0]}" but the shipped stack ` +
        `("${SHIPPED_STACK}", ${REGISTRY}) runs "${shippedPrimary}" as its primary. BUILT_IN doubles as ` +
        `the assumed model for stampless usage rows, so every such row is being priced at the WRONG ` +
        `model's rate. (This is the exact rot that ran from 2026-07-17 to 2026-08-05.)`,
    );
  }
}

const coreLiteral = readFileSync(CORE_DEFAULT, "utf8").match(/registeredDefault\s*\|\|\s*["']([^"']+)["']/)?.[1];
if (coreLiteral === undefined) {
  reds.push(
    `UNREADABLE: could not find core's library default model literal in ${CORE_DEFAULT} ` +
      `(expected the \`registeredDefault || "<id>"\` fallback). This gate needs updating alongside it.`,
  );
} else if (coreLiteral !== shippedPrimary) {
  reds.push(
    `CORE/STACK MISMATCH: ${CORE_DEFAULT} falls back to "${coreLiteral}" but the shipped stack ` +
      `("${SHIPPED_STACK}") runs "${shippedPrimary}". That literal is what a core-only process — the ` +
      `plugin extractor with no app config, a unit test importing one module — resolves to, so a ` +
      `drift here silently gives generated subagents a different model from the deployment.`,
  );
}

const settingShipped = SETTINGS.models.stack.shipped;
if (!isStackAlias(settingShipped)) {
  reds.push(
    `SETTING/STACK MISMATCH: the \`models.stack\` setting ships "${settingShipped}", which is not a ` +
      `stack alias (${REGISTRY} defines ${STACK_ALIASES.map((a) => `"${a}"`).join(", ")}). Every clone ` +
      `would throw at config load.`,
  );
} else if (settingShipped !== SHIPPED_STACK) {
  reds.push(
    `SETTING/STACK MISMATCH: the \`models.stack\` setting ships "${settingShipped}" but ${REGISTRY} ` +
      `declares SHIPPED_STACK = "${SHIPPED_STACK}". The setting is what actually resolves; SHIPPED_STACK ` +
      `is what the pricing table and core's literal are pinned against, so a split makes both of those ` +
      `pins check the wrong thing.`,
  );
}

for (const role of [
  "PRIMARY_MODEL",
  "UTILITY_MODEL",
  "VISION_MODEL",
  "SUPERVISOR_MODEL",
  "JUDGE_MODEL",
  "PRIMARY_MODEL_CONTEXT_WINDOW_TOKENS",
]) {
  if (!new RegExp(`export const ${role}\\b`).test(resolverSrc)) {
    reds.push(`MISSING ROLE EXPORT: ${RESOLVER} no longer exports ${role}, which app config imports.`);
  }
}

for (const [alias, stack] of Object.entries(STACKS)) {
  for (const role of ["primary", "utility", "vision", "supervisor", "judge"] as const) {
    const spec = stack[role];
    if (spec === undefined) {
      reds.push(`INCOMPLETE STACK: "${alias}" does not fill the "${role}" role (${REGISTRY}).`);
      continue;
    }
    if (!MODEL_ID.test(spec.id)) {
      reds.push(
        `MALFORMED ID: stack "${alias}" role "${role}" is "${spec.id}", which is not a <vendor>/<model> ` +
          `id this gate recognises. Add the vendor to VENDORS in scripts/model-ids-scope.ts if it is new.`,
      );
    }
    if (!Number.isInteger(spec.contextWindowTokens) || spec.contextWindowTokens <= 0) {
      reds.push(`BAD WINDOW: stack "${alias}" role "${role}" declares contextWindowTokens ${spec.contextWindowTokens}.`);
    }
  }
}

registerModelPricing(loadModelPricing());
const allowListed = (loadModelPolicy()?.allow ?? []).map((entry) => entry.id);
const selected = [
  ...new Set([
    ...selectedStackModelIds(STACKS),
    ...allowListed,
    ...routePinnedModelIds(loadDomains()),
    ...routePinnedModelIds(loadRoles()),
  ]),
].sort();
for (const id of unpricedModelIds(selected)) {
  reds.push(
    `UNPRICED MODEL: "${id}" is selectable by this config — a shipped stack (${REGISTRY}), the model-policy ` +
      `allow-list (agent/model/policy.ts), or a route pin in agent/memory/config/domains.ts or agent/roles/roles.ts ` +
      `— but no code table prices it. A USD cap counts an unpriced call as $0 ` +
      `— evidence-only, never a guessed rate — so a $ budget over this model would enforce over nothing. ` +
      `FIX: measure the rate (\`npm run probe:models\`; the gateway's public catalog at ` +
      `https://ai-gateway.vercel.sh/v1/models is a research lead, NOT the committed number — it has been wrong ` +
      `for every id measured) and commit the entry in ${PRICE_TABLE} in this PR. ` +
      `Priced today: ${[...builtInModelIds(), ...deployerPricedModelIds()].sort().join(", ")}.`,
  );
}

for (const id of [...new Set([...builtInModelIds(), ...deployerPricedModelIds()])].sort()) {
  const band = stackModelRateBand(id);
  const live = modelPricing(id);
  if (!live) continue;
  if (!band) {
    reds.push(
      `RATE TABLE SPLIT: "${id}" is priced in code but packages/core/agent/spend/stack-pricing.ts has no measured ` +
        `band for it, so \`npm run pricing:stacks\` renders any role running it as UNPRICED and reports a partial ` +
        `total. Add the band there (same measurement, expressed as min/max) in this diff.`,
    );
    continue;
  }
  for (const [field, measured] of [
    ["inPerMtok", band.in.maxPerMtok],
    ["outPerMtok", band.out.maxPerMtok],
  ] as const) {
    const actual = live[field];
    if (actual !== measured) {
      reds.push(
        `RATE TABLE SPLIT: "${id}".${field} is ${actual} in the live pricing table but ${measured} at the top of ` +
          `stack-pricing.ts's measured band. The live number must be the band MAXIMUM — the only direction a cap ` +
          `may err is the one that cannot understate spend. Re-probe once and update BOTH tables in one diff ` +
          `(${PRICE_TABLE} / ${PRICING} and packages/core/agent/spend/stack-pricing.ts).`,
      );
    }
  }
}

if (reds.length > 0) {
  console.error(`✗ model-ids: ${reds.length} drift(s):\n`);
  for (const r of reds) console.error(`  • ${r}`);
  process.exit(1);
}

console.log(
  `✓ model-ids: ${scanned} git-tracked app file(s) — the same set before and after a build — name no ` +
    `model id directly; ${STACK_ALIASES.length} stack(s) complete; ` +
    `BUILT_IN pricing, core's literal and the models.stack default all agree on "${shippedPrimary}" (stack "${SHIPPED_STACK}"); ` +
    `all ${selected.length} selectable model(s) priced in code and consistent with the measured bands`,
);
