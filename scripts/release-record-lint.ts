import { readFileSync } from "node:fs";
import { loadAllReleaseRecords } from "./release-record/store.js";
import { structuralProblems } from "./release-record/structural.js";

const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { scripts?: Record<string, string> };
const knownScripts = new Set(Object.keys(pkg.scripts ?? {}));

const loaded = loadAllReleaseRecords();
if (loaded.length === 0) {
  console.log("✓ lint:release-records: no releases/*/migration.json yet — nothing to check.");
  process.exit(0);
}

const problems: string[] = [];
for (const l of loaded) {
  problems.push(...l.problems);
  if (l.record) problems.push(...structuralProblems(l.dirName, l.record, knownScripts));
}

if (problems.length > 0) {
  console.error(`✗ lint:release-records: ${problems.length} problem(s) across ${loaded.length} record(s)\n`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`✓ lint:release-records: ${loaded.length} record(s) valid.`);
