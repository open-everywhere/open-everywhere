import { readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { checkDeclaredSubagents } from "@open-everywhere/core/agent/subagents/declared.js";
import { readDeclaredSubagents, subagentsDir } from "./read-subagents.js";

const require = createRequire(import.meta.url);
const eveRoot = dirname(require.resolve("eve/package.json"));
const { getAllFrameworkToolNames } = (await import(
  pathToFileURL(join(eveRoot, "dist/src/runtime/framework-tools/index.js")).href
)) as { getAllFrameworkToolNames(): ReadonlySet<string> };
const disableableFrameworkTools = [...getAllFrameworkToolNames()].filter((n) => n !== "agent").sort();

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const coreToolsDir = join(root, "packages", "core", "agent", "tools");
const appToolsDir = join(root, "agent", "tools");
const toolNames = [
  ...new Set(
    [coreToolsDir, appToolsDir]
      .filter((d) => existsSync(d))
      .flatMap((d) => readdirSync(d).filter((f) => f.endsWith(".ts") && !f.startsWith("_")).map((f) => f.replace(/\.ts$/u, ""))),
  ),
];

const subagents = readDeclaredSubagents(root);
const problems = checkDeclaredSubagents(subagents, disableableFrameworkTools, toolNames);

if (problems.length > 0) {
  console.error(`✗ subagents-lint: ${problems.length} problem(s):\n` + problems.map((p) => `  - ${p}`).join("\n"));
  process.exit(1);
}
console.log(
  subagents.length === 0
    ? `✓ subagents-lint: no declared subagents under ${subagentsDir(root)} (nothing to check).`
    : `✓ subagents-lint: ${subagents.length} declared subagent(s) (${subagents.map((s) => s.name).join(", ")}) — typed outputSchema, own instructions, zero hands (${disableableFrameworkTools.length} framework tools disabled each), own spend hook.`,
);
