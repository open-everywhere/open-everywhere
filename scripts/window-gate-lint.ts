import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { checkWindowGateManifest, classifyFrameworkTools, type WindowToolSource } from "@open-everywhere/core/agent/access/window-gate-manifest.js";
import { readEveFrameworkTools } from "../packages/core/scripts/eve-framework-tools.js";
import { listDeclaredSubagents } from "@open-everywhere/core/agent/subagents/declared.js";
import { readDeclaredSubagents } from "./read-subagents.js";

const eveFrameworkTools = await readEveFrameworkTools();
if (eveFrameworkTools.optInDrift !== undefined) console.warn(`  ! eve mount sets: ${eveFrameworkTools.optInDrift}`);
const frameworkToolNames = eveFrameworkTools.all;
const frameworkTools = classifyFrameworkTools(frameworkToolNames, eveFrameworkTools.defaultMounted, eveFrameworkTools.optIn);

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const coreToolsDir = join(root, "packages", "core", "agent", "tools");
const appToolsDir = join(root, "agent", "tools");

const coreTools: WindowToolSource[] = [];
for (const f of readdirSync(coreToolsDir).filter((f) => f.endsWith(".ts") && !f.startsWith("_"))) {
  coreTools.push({ name: f.replace(/\.ts$/u, ""), source: readFileSync(join(coreToolsDir, f), "utf8") });
}

const appShims = new Map<string, string>();
for (const f of readdirSync(appToolsDir).filter((f) => f.endsWith(".ts") && !f.startsWith("_"))) {
  appShims.set(f.replace(/\.ts$/u, ""), readFileSync(join(appToolsDir, f), "utf8"));
}

const subagentNames = listDeclaredSubagents(readDeclaredSubagents(root));

const problems = checkWindowGateManifest(coreTools, appShims, frameworkTools, undefined, undefined, undefined, subagentNames);

if (problems.length > 0) {
  console.error(`✗ window-gate-lint: ${problems.length} problem(s):\n` + problems.map((p) => `  - ${p}`).join("\n"));
  process.exit(1);
}
console.log(
  `✓ window-gate-lint: every tool over the runtime surface (${coreTools.length} core-authored + ${appShims.size} deploy shims + ${frameworkToolNames.length} eve-framework names + ${subagentNames.length} declared subagents) carries exactly one declared grain posture, ` +
    `the grain-scoping invariants hold, and every gated tool's source carries its gate.`,
);
