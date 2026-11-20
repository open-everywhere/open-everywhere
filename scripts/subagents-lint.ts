import { readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readEveFrameworkTools } from "../packages/core/scripts/eve-framework-tools.js";
import { checkDeclaredSubagents } from "@open-everywhere/core/agent/subagents/declared.js";
import { readDeclaredSubagents, subagentsDir } from "./read-subagents.js";

const eveFrameworkTools = await readEveFrameworkTools();
const disableableFrameworkTools = [...eveFrameworkTools.defaultMounted].sort();
const reservedFrameworkTools = [...eveFrameworkTools.reserved].sort();

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
const problems = checkDeclaredSubagents(subagents, disableableFrameworkTools, toolNames, reservedFrameworkTools);

if (problems.length > 0) {
  console.error(`✗ subagents-lint: ${problems.length} problem(s):\n` + problems.map((p) => `  - ${p}`).join("\n"));
  process.exit(1);
}
console.log(
  subagents.length === 0
    ? `✓ subagents-lint: no declared subagents under ${subagentsDir(root)} (nothing to check).`
    : `✓ subagents-lint: ${subagents.length} declared subagent(s) (${subagents.map((s) => s.name).join(", ")}) — the root agent's model, no authored outputSchema, own instructions, zero hands (${disableableFrameworkTools.filter((n) => !reservedFrameworkTools.includes(n)).length} framework tools disabled each${reservedFrameworkTools.length === 0 ? "" : `; eve reserves ${reservedFrameworkTools.join(", ")}, which take no file at all`}), own spend hook.`,
);
