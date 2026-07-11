import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { checkConsequenceRegistry, type ToolSource } from "@open-everywhere/core/agent/access/consequence.js";
import { actionKind } from "@open-everywhere/core/agent/approvals/actions.js";
import "@open-everywhere/core/agent/approvals/flow.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const coreToolsDir = join(root, "packages", "core", "agent", "tools");
const appToolsDir = join(root, "agent", "tools");

const tools = new Map<string, ToolSource>();

for (const f of readdirSync(coreToolsDir).filter((f) => f.endsWith(".ts") && !f.startsWith("_"))) {
  const name = f.replace(/\.ts$/u, "");
  tools.set(name, { name, source: readFileSync(join(coreToolsDir, f), "utf8") });
}

for (const f of readdirSync(appToolsDir).filter((f) => f.endsWith(".ts") && !f.startsWith("_"))) {
  const name = f.replace(/\.ts$/u, "");
  if (tools.has(name)) continue;
  let source = readFileSync(join(appToolsDir, f), "utf8");
  const m = source.match(/export \{ default \} from "@open-everywhere\/(\w+)\/(.+)\.js"/u);
  if (m) source = readFileSync(join(root, "packages", m[1], `${m[2]}.ts`), "utf8");
  tools.set(name, { name, source });
}

const problems = checkConsequenceRegistry([...tools.values()], (action) => actionKind(action)?.policy);

if (problems.length > 0) {
  console.error(`✗ consequence-lint: ${problems.length} problem(s):\n` + problems.map((p) => `  - ${p}`).join("\n"));
  process.exit(1);
}
console.log(`✓ consequence-lint: ${tools.size} tool(s), every declaration total and matching its runtime gate`);
