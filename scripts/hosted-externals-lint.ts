import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

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

const RUNTIME_SRC_DIRS = [
  "packages/core/agent",
  "packages/adapters/agent",
  "agent",
  ...readdirSync(join(process.cwd(), "packages", "providers"), { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => join("packages", "providers", e.name, "agent")),
].filter((d) => existsSync(join(process.cwd(), d)));

function walkTs(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walkTs(p));
    else if (e.name.endsWith(".ts") && !e.name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

const srcFailures: string[] = [];
for (const dir of RUNTIME_SRC_DIRS) {
  for (const file of walkTs(join(process.cwd(), dir))) {
    const lines = readFileSync(file, "utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      const trimmed = line.trimStart();
      if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) continue;
      if (!/\bimport\s*\(\s*[^"'`\s)]/.test(line)) continue;
      const context = [lines[i - 3], lines[i - 2], lines[i - 1], line].filter((l) => l !== undefined).join("\n");
      if (context.includes("hosted-inline-exempt:")) continue;
      srcFailures.push(
        `${file.slice(process.cwd().length + 1)}:${i + 1}: computed dynamic import — the bundler cannot inline what it cannot see; if this package is needed hosted this is a cold-start-class crash. Inline a literal specifier, or add \`// hosted-inline-exempt: <why>\`.`,
      );
    }
  }
}
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
