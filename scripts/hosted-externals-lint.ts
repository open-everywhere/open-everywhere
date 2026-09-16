import { existsSync, readFileSync, readdirSync } from "node:fs";
import { isBuiltin } from "node:module";
import { join } from "node:path";

import { computedImportFailures } from "./hosted-externals-source-scan.js";

const OUTPUT_DIR = join(process.cwd(), ".vercel", "output", "functions");

const BARE_IMPORT = /^\s*(?:import|export)[^;]*?from\s*"([a-z@][^"]*)"/gm;
const SIDE_EFFECT_IMPORT = /(?:^\s*import\s*|\bimport\s*\(\s*)"([a-z@][^"]*)"/gm;

function packageNameOf(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? specifier);
}

function bareImportsOf(source: string): Set<string> {
  const found = new Set<string>();
  for (const re of [BARE_IMPORT, SIDE_EFFECT_IMPORT]) {
    re.lastIndex = 0;
    for (let m = re.exec(source); m !== null; m = re.exec(source)) {
      const spec = m[1];
      if (spec === undefined || spec.startsWith("node:")) continue;
      found.add(spec);
    }
  }
  return found;
}

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

for (const dir of functionDirs) {
  const funcDir = join(OUTPUT_DIR, dir);
  const entry = join(funcDir, "index.mjs");
  if (!existsSync(entry)) {
    failures.push(`${dir}: no index.mjs`);
    continue;
  }

  for (const spec of bareImportsOf(readFileSync(entry, "utf8"))) {
    checkedImports += 1;
    if (isBuiltin(spec)) continue;
    if (existsSync(join(funcDir, "node_modules", packageNameOf(spec)))) continue;
    failures.push(
      `${dir}: "${spec}" is imported but not present in ${dir}/node_modules — cold-start crash.`,
    );
  }
}

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
  `✓ ${checkedImports} bare import(s) across ${functionDirs.length} hosted function(s) resolve from their own bundle`,
);
