import { readdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { codeOnly } from "./tidy/test-runner-inventory.js";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

function agentTrees(): string[] {
  const trees = [join(REPO, "agent")];
  for (const base of ["packages", join("packages", "providers")]) {
    const dir = join(REPO, base);
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry === "providers") continue;
      const tree = join(dir, entry, "agent");
      if (existsSync(tree)) trees.push(tree);
    }
  }
  return trees;
}

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, out);
    else if (entry.name.endsWith(".ts")) out.push(path);
  }
}

const TOOLS_IMPORT = /import\s*\{[^}]*\bdefineDynamic\b[^}]*\}\s*from\s*"eve\/tools"/;
const REGISTERS = /\bpreRegisterDynamicEntry\s*\(|\bpreRegisterDynamicVariants\s*\(|\bregisterDynamicVariant\s*\(/;

const problems: string[] = [];
let inScope = 0;

for (const tree of agentTrees()) {
  const files: string[] = [];
  walk(tree, files);
  for (const file of files) {
    const raw = readFileSync(file, "utf8");
    if (!TOOLS_IMPORT.test(raw)) continue;
    const source = codeOnly(raw);
    const dynamicAt = source.indexOf("defineDynamic(");
    if (dynamicAt === -1) continue;
    inScope++;
    const name = relative(REPO, file);

    if (source.slice(dynamicAt).includes("defineTool(")) {
      problems.push(
        `${name} writes a \`defineTool(\` at or after its \`defineDynamic(\` call. An entry authored there rides ` +
          `eve's build-order-counter transform, so the durable step id shifts across deploys and a resumed session ` +
          `binds a DIFFERENT tool's execute. Declare the entry as a top-level const ABOVE the \`defineDynamic(\` ` +
          `call and pre-register it — the position is the requirement this rule can check.`,
      );
    }

    if (source.includes("defineTool(") && !REGISTERS.test(source)) {
      problems.push(
        `${name} authors a \`defineTool\` entry for a dynamic tool but calls none of ` +
          `preRegisterDynamicEntry / preRegisterDynamicVariants / registerDynamicVariant. An unregistered entry ` +
          `leaves its mounted name unclaimed, which is what the replay doctrine at ` +
          `packages/core/agent/access/window-gated.ts exists to prevent.`,
      );
    }
  }
}

if (inScope === 0) {
  problems.push(
    'the scan found NO file importing `defineDynamic` from "eve/tools". That is a broken pattern, not a clean ' +
      "tree — check TOOLS_IMPORT against how the tools import it today.",
  );
}

if (problems.length > 0) {
  console.error(`dynamic replay doctrine: ${problems.length} problem(s)\n`);
  for (const p of problems) console.error(`  ✗ ${p}\n`);
  process.exit(1);
}

console.log(`dynamic replay doctrine: ${inScope} dynamic-tool files, all factored and all registered.`);
