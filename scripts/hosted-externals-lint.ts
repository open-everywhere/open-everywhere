import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { outputImportFailures } from "./hosted-externals-output-scan.js";
import { computedImportFailures } from "./hosted-externals-source-scan.js";

const OUTPUT_DIR = join(process.cwd(), ".vercel", "output", "functions");

const srcFailures = computedImportFailures(process.cwd());
if (srcFailures.length > 0) {
  console.error("✗ computed dynamic import specifier(s) in runtime source:\n");
  for (const f of srcFailures) console.error(`  ${f}`);
  process.exit(1);
}

if (!existsSync(OUTPUT_DIR)) {
  console.error(
    `✗ no build output at ${OUTPUT_DIR}\n` +
      `  Run the parity build first — this lint checks built artefacts, not sources:\n` +
      `    vercel build --prod --yes --scope <scope>`,
  );
  process.exit(1);
}

const functionDirs = readdirSync(OUTPUT_DIR).filter((name) => name.endsWith(".func"));
if (functionDirs.length === 0) {
  console.error(`✗ ${OUTPUT_DIR} contains no *.func directories — the build output looks wrong.`);
  process.exit(1);
}

const failures: string[] = [];
let checkedImports = 0;
let checkedFiles = 0;
let guardedImports = 0;
const guardedNotes: string[] = [];

for (const dir of functionDirs) {
  const scan = outputImportFailures(join(OUTPUT_DIR, dir), dir);
  failures.push(...scan.failures);
  checkedImports += scan.checkedImports;
  checkedFiles += scan.checkedFiles;
  guardedImports += scan.guardedImports;
  guardedNotes.push(...scan.guardedNotes);
}

for (const n of guardedNotes) console.log(`  note: ${n}`);

if (failures.length > 0) {
  console.error("✗ unresolvable external(s) in hosted build output:\n");
  for (const f of failures) console.error(`  ${f}`);
  console.error(
    `\n  A hosted function ships no node_modules unless eve traces the package in. Declare it:\n` +
      `    agent/agent.ts → build: { externalDependencies: ["<pkg>"] }\n` +
      `  then rebuild and re-run this lint. See OPE-225.`,
  );
  process.exit(1);
}

console.log(
  `✓ ${checkedImports} bare import(s) in ${checkedFiles} module file(s) across ${functionDirs.length} hosted function(s) resolve from their own bundle` +
    (guardedImports > 0 ? `; ${guardedImports} guarded optional load(s) not judged` : ""),
);
