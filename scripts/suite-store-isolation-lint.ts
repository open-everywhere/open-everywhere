import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { chainLegs, legLabel, REPO_ROOT } from "./chain/_legs.js";
import { codeOnly } from "./tidy/test-runner-inventory.js";

const STORE_REACH = /(?<![.\w$])(?:readAudit|appendAudit|getOperationalStore|registerOperationalStore)\s*\(/;

const PINNED = /\bpinSuiteStore\s*\(|\bOE_SQLITE_PATH\b|\bOE_MEMORY_DIR\b/;

const AMBIENT_STORE_BY_DESIGN: ReadonlyMap<string, string> = new Map([]);

const problems: string[] = [];
let reaching = 0;

for (const leg of chainLegs()) {
  const source = readFileSync(leg.file, "utf8");
  if (!STORE_REACH.test(codeOnly(source))) continue;
  reaching++;
  const label = legLabel(leg);
  if (AMBIENT_STORE_BY_DESIGN.has(label)) continue;
  if (PINNED.test(codeOnly(source))) continue;
  problems.push(
    `${label} — ${relative(REPO_ROOT, leg.file)} reaches the operational/audit store but pins no store path. ` +
      `It shares <package>/.open-everywhere-memory/open-everywhere.sqlite3 with every other unpinned suite in ` +
      `its package, across the shard processes that run at once. Call pinSuiteStore("<suite>") from ` +
      `packages/core/scripts/_suite-store.ts (or set OE_SQLITE_PATH yourself) at the top of the file.`,
  );
}

const labels = new Set(chainLegs().map(legLabel));
for (const [label, reason] of AMBIENT_STORE_BY_DESIGN) {
  if (!labels.has(label)) problems.push(`AMBIENT_STORE_BY_DESIGN names "${label}", which the chain does not run.`);
  if (reason.length <= 20) problems.push(`AMBIENT_STORE_BY_DESIGN entry "${label}" carries no reason.`);
}

if (reaching === 0) {
  problems.push(
    "the store-reach scan matched NO chain suite. That is a broken pattern, not a clean tree — " +
      "check STORE_REACH against the current store entry-point names.",
  );
}

if (problems.length > 0) {
  console.error(`suite store isolation: ${problems.length} problem(s)\n`);
  for (const p of problems) console.error(`  ✗ ${p}\n`);
  process.exit(1);
}

console.log(`suite store isolation: ${reaching} chain suites reach the operational store, all with a private store path.`);
