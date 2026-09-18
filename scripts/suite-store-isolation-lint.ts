import { relative } from "node:path";
import { chainLegs, legLabel, REPO_ROOT } from "./chain/_legs.js";
import { suiteStoreReach } from "./suite-store-reach-lib.js";

const AMBIENT_STORE_BY_DESIGN: ReadonlyMap<string, string> = new Map([]);

const problems: string[] = [];
let reaching = 0;
let indirectReaching = 0;

const REMEDY =
  `Call pinSuiteStore("<suite>") from packages/core/scripts/_suite-store.ts (or set OE_SQLITE_PATH ` +
  `yourself) at the top of the file.`;
const SHARING =
  `It shares <package>/.open-everywhere-memory/open-everywhere.sqlite3 with every other unpinned suite in ` +
  `its package, across the shard processes that run at once.`;

for (const leg of chainLegs()) {
  const reach = suiteStoreReach(leg.file);
  if (!reach.direct && reach.indirect.length === 0) continue;
  reaching++;
  if (!reach.direct) indirectReaching++;
  const label = legLabel(leg);
  if (AMBIENT_STORE_BY_DESIGN.has(label)) continue;
  if (reach.pinned) continue;
  if (reach.direct) {
    problems.push(`${label} — ${relative(REPO_ROOT, leg.file)} reaches the operational/audit store but pins no store path. ${SHARING} ${REMEDY}`);
    continue;
  }
  const via = reach.indirect.map((r) => `${r.symbol}() in ${relative(REPO_ROOT, r.module)}`).join(", ");
  problems.push(
    `${label} — ${relative(REPO_ROOT, leg.file)} reaches the operational/audit store THROUGH AN IMPORT it calls ` +
      `(${via}), and pins no store path. Its own text names no store entry point, which is why this was invisible ` +
      `until OPE-1922. ${SHARING} ${REMEDY} Pin it even if the call injects a stub today: the pin costs one line ` +
      `and holds for every future branch of the suite, which an exemption entry measured on today's happy path does not.`,
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

if (indirectReaching === 0) {
  problems.push(
    "the INDIRECT store-reach scan matched no chain suite at all. Suites have reached the store through " +
      "an imported call since OPE-1906, so zero means the import walk, the module resolution or the body " +
      "parse stopped working — never that the repo changed. See scripts/suite-store-reach-lib.ts.",
  );
}

if (problems.length > 0) {
  console.error(`suite store isolation: ${problems.length} problem(s)\n`);
  for (const p of problems) console.error(`  ✗ ${p}\n`);
  process.exit(1);
}

console.log(
  `suite store isolation: ${reaching} chain suites reach the operational store (${indirectReaching} of them only through an imported call), all with a private store path.`,
);
