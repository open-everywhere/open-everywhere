import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { CONTRACT_REQUIREMENT_IDS, contractJsonText, contractProseDrift } from "../packages/core/agent/ops/contract.js";
import { writeFileIfChanged } from "./write-if-changed.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const JSON_PATH = join(REPO_ROOT, "docs", "deploy", "contract.json");
const MD_PATH = join(REPO_ROOT, "docs", "deploy", "contract.md");

const check = process.argv.includes("--check");
const json = contractJsonText();
const failures: string[] = [];

if (check) {
  const actual = existsSync(JSON_PATH) ? readFileSync(JSON_PATH, "utf8") : "";
  if (actual !== json) failures.push("docs/deploy/contract.json is out of date — run `npm run docs:contract`");
} else if (writeFileIfChanged(JSON_PATH, json)) {
  console.log("wrote docs/deploy/contract.json");
}

if (!existsSync(MD_PATH)) {
  failures.push("docs/deploy/contract.md is missing — the contract's prose half is not optional");
} else {
  const { missing, unknown } = contractProseDrift(readFileSync(MD_PATH, "utf8"));
  if (missing.length > 0) failures.push(`docs/deploy/contract.md has no section for: ${missing.join(", ")} (add \`<a id="req-<id>"></a>\`)`);
  if (unknown.length > 0) failures.push(`docs/deploy/contract.md anchors requirement ids the table does not define: ${unknown.join(", ")}`);
}

if (failures.length > 0) {
  for (const f of failures) console.error(`✗ deploy-contract: ${f}`);
  process.exit(1);
}
console.log(`✓ deploy-contract: ${CONTRACT_REQUIREMENT_IDS.length} requirements, json + prose in step`);
