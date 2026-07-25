import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { checkConsequenceRegistry, type ToolSource } from "@open-everywhere/core/agent/access/consequence.js";
import { listDeclaredSubagents } from "@open-everywhere/core/agent/subagents/declared.js";
import { readDeclaredSubagents } from "./read-subagents.js";
import { actionKind } from "@open-everywhere/core/agent/approvals/actions.js";
import "@open-everywhere/core/agent/approvals/flow.js";

const require = createRequire(import.meta.url);
const eveRoot = dirname(require.resolve("eve/package.json"));
const { getAllFrameworkToolNames } = (await import(
  pathToFileURL(join(eveRoot, "dist/src/runtime/framework-tools/index.js")).href
)) as { getAllFrameworkToolNames(): ReadonlySet<string> };
const frameworkToolNames = [...getAllFrameworkToolNames(), "connection_search"];

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
  const m = source.match(/export \{ default \} from "@open-everywhere\/([\w-]+)\/(.+)\.js"/u);
  if (m) {
    const pkgDir = m[1].startsWith("provider-") ? join("providers", m[1].slice("provider-".length)) : m[1];
    source = readFileSync(join(root, "packages", pkgDir, `${m[2]}.ts`), "utf8");
  }
  tools.set(name, { name, source });
}

const subagentNames = listDeclaredSubagents(readDeclaredSubagents(root));

const problems = checkConsequenceRegistry(
  [...tools.values()],
  frameworkToolNames,
  (action) => actionKind(action)?.policy,
  undefined,
  subagentNames,
);

if (problems.length > 0) {
  console.error(`✗ consequence-lint: ${problems.length} problem(s):\n` + problems.map((p) => `  - ${p}`).join("\n"));
  process.exit(1);
}
const frameworkOnly = frameworkToolNames.filter((n) => !tools.has(n)).length;
console.log(
  `✓ consequence-lint: total over all mounted agent tools (${tools.size} OE-authored + ${frameworkOnly} eve-framework + ${subagentNames.length} declared subagent), every declaration matching its runtime gate. ` +
    `Connector/MCP operations are a separate, design-deferred plane (§3 grain 2, §7 item 5).`,
);
