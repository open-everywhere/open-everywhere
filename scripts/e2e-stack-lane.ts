import { spawnSync } from "node:child_process";
import { STACKS, STACK_ALIASES, resolveStack, stackModelIds, type ModelRole, type StackAlias } from "../agent/model/stacks.js";
import { allowListForStack } from "../agent/model/models.js";
import { isModelUsable } from "@open-everywhere/core/agent/model/policy.js";
import { wireNeonOperationalStore } from "../packages/core/scripts/e2e/rotate-window-lib.js";

const DEFAULT_SCENARIOS = ["S20", "J1", "F-ART"] as const;

const REQUIRED_ROLES: readonly ModelRole[] = ["primary", "vision"];

const PINNED_JUDGE_MODEL = "openai/gpt-5.6-luna";

const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const alias = argv.find((a) => !a.startsWith("--"));

if (alias === undefined) {
  console.error(`usage: npm run e2e:stack -- <alias> [--only ID,ID] [--dry-run]`);
  console.error(`       shipped stacks: ${STACK_ALIASES.join(", ")}`);
  process.exit(2);
}
if (!STACK_ALIASES.includes(alias as StackAlias)) {
  console.error(`✗ unknown stack "${alias}" — shipped: ${STACK_ALIASES.join(", ")} (agent/model/stacks.ts)`);
  process.exit(2);
}

const stack = STACKS[alias as StackAlias];
const allIds = stackModelIds(stack);
const requiredIds = [...new Set(REQUIRED_ROLES.map((r) => stack[r].id))].sort();

const onlyIdx = argv.indexOf("--only");
const scenarios = onlyIdx === -1 ? [...DEFAULT_SCENARIOS] : (argv[onlyIdx + 1] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
if (scenarios.length === 0) {
  console.error(`✗ --only was given with no scenario ids.`);
  process.exit(2);
}

console.log(`── per-stack e2e lane ────────────────────────────────────────────────`);
console.log(`  stack        ${alias}`);
for (const [role, spec] of Object.entries(stack)) console.log(`    ${role.padEnd(11)}${spec.id}`);
console.log(`  scenarios    ${scenarios.join(", ")}`);
console.log(`  expect only  ${allIds.join(", ")}`);
console.log(`  require      ${requiredIds.join(", ")}`);
console.log(`  judge (pin)  ${PINNED_JUDGE_MODEL}  ← the GRADER, held fixed across stacks`);
console.log(`──────────────────────────────────────────────────────────────────────`);
console.log(
  `  ⚠️ The deployment under test must ALREADY be running this stack: set OE_MODEL_STACK=${alias}\n` +
    `     on the target and deploy before running. This driver cannot flip it — the value is read\n` +
    `     by the deployed process at config load. A target on the wrong stack fails the required\n` +
    `     pin below rather than silently proving nothing.\n`,
);

const missing = ["E2E_TARGET_URL", "E2E_CONTROL_READ_TOKEN", "E2E_USAGE_WORKSPACES"].filter(
  (v) => (process.env[v] ?? "").trim() === "",
);
if (missing.length > 0 && !dryRun) {
  console.error(
    `✗ the lane needs the usage read to prove which models ran, and ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} unset.\n` +
      `  Source the e2e env first (\`set -a && . ./.env.e2e && set +a\`). Without it the model pins are\n` +
      `  skipped entirely and the run would pass without evidence — which is the failure this lane closes.`,
  );
  process.exit(2);
}

const ORG = process.env["E2E_ORG"] ?? "default";
const dbUrl = (process.env["DATABASE_URL"] ?? "").trim();
if (dbUrl === "") {
  console.warn(
    `  ⚠️ PREFLIGHT SKIPPED — DATABASE_URL is unset, so the runtime domain-model picks could not be read.\n` +
      `     A pick set on the target (set_domain_model, or an eval harness that pinned one and did not\n` +
      `     restore) silently overrides routing for its domain and would defeat the switch this lane\n` +
      `     exists to prove. Source the e2e env to arm this check.\n`,
  );
} else {
  const envelope = { allow: allowListForStack(resolveStack(alias)) };
  const store = await wireNeonOperationalStore(dbUrl);
  const rows = await store.domainModels(ORG);
  const picks = rows.flatMap((r) => (r.modelId === undefined ? [] : [{ ...r, modelId: r.modelId }]));
  const outside = picks.filter((r) => !isModelUsable(r.modelId, envelope));
  if (outside.length > 0) {
    console.error(
      `✗ PREFLIGHT: ${outside.length} runtime domain pick(s) in org "${ORG}" sit OUTSIDE stack "${alias}":\n` +
        outside.map((r) => `    domain "${r.domain}" → "${r.modelId}"  (set by ${r.setBy ?? "unknown"}, ${r.updatedAt})`).join("\n") +
        `\n  Those domains route to that model regardless of OE_MODEL_STACK, so this run would not prove the\n` +
        `  switch. Clear them first (\`clear_domain_model\`), then re-run.`,
    );
    process.exit(2);
  }
  console.log(
    `  preflight    ${picks.length} runtime domain pick(s) in org "${ORG}", all inside stack "${alias}"` +
      (picks.length > 0 ? ` (${picks.map((r) => `${r.domain}→${r.modelId}`).join(", ")})` : "") +
      `\n`,
  );
}

if (dryRun) {
  console.log(`(--dry-run: nothing executed)`);
  process.exit(0);
}

const result = spawnSync(
  "npm",
  ["run", "e2e:driver", "--workspace", "@open-everywhere/core", "--", "--only", scenarios.join(",")],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      E2E_EXPECT_MODELS: allIds.join(","),
      E2E_EXPECT_MODELS_REQUIRED: requiredIds.join(","),
      E2E_JUDGE_MODEL: PINNED_JUDGE_MODEL,
      E2E_INCLUDE_OPTIONAL: process.env["E2E_INCLUDE_OPTIONAL"] ?? "1",
    },
  },
);

process.exit(result.status ?? 1);
