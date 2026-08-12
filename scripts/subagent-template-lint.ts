import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { readAllTemplateTrees, TEMPLATE_TREES } from "../packages/core/agent/scaffold/templates.js";

const APP_ROOT = process.cwd();
const reds: string[] = [];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const shipped = readAllTemplateTrees();
if (shipped.length === 0) reds.push("no template files were read from the package — the templates/ tree is empty or unresolvable");

for (const file of shipped) {
  const onDisk = join(APP_ROOT, file.path);
  if (!existsSync(onDisk)) reds.push(`${file.path}: shipped by @open-everywhere/core but MISSING from the app tree`);
  else if (readFileSync(onDisk, "utf8") !== file.content) reds.push(`${file.path}: app tree DIFFERS from the shipped template bytes`);
}

const shippedPaths = new Set(shipped.map((f) => f.path));
for (const dest of Object.values(TEMPLATE_TREES)) {
  const destDir = join(APP_ROOT, dest);
  if (!existsSync(destDir)) {
    reds.push(`${dest}: destination tree is missing from the app`);
    continue;
  }
  for (const abs of walk(destDir)) {
    const rel = `${dest}/${relative(destDir, abs).split("\\").join("/")}`;
    if (!shippedPaths.has(rel)) reds.push(`${rel}: present in the app tree but NOT shipped by @open-everywhere/core`);
  }
}

if (reds.length > 0) {
  console.error("✗ subagent template drift:");
  for (const r of reds) console.error(`  - ${r}`);
  console.error("\n  Canonical bytes live in packages/core/templates/. Copy the app tree over it (or vice versa) so they match.");
  process.exit(1);
}
console.log(`✓ subagent templates: ${shipped.length} file(s) byte-identical between @open-everywhere/core and the app tree.`);
