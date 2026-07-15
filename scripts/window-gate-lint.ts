import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { checkWindowGateManifest, type WindowToolSource } from "@open-everywhere/core/agent/access/window-gate-manifest.js";

const require = createRequire(import.meta.url);
const eveRoot = dirname(require.resolve("eve/package.json"));
const { getAllFrameworkToolNames } = (await import(
  pathToFileURL(join(eveRoot, "dist/src/runtime/framework-tools/index.js")).href
)) as { getAllFrameworkToolNames(): ReadonlySet<string> };
const frameworkToolNames = [...getAllFrameworkToolNames(), "connection_search"];

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

const workerToolsDir = join(root, "agent", "subagents", "worker", "tools");
const workerShims = new Map<string, string>();
try {
  for (const f of readdirSync(workerToolsDir).filter((f) => f.endsWith(".ts") && !f.startsWith("_"))) {
    workerShims.set(f.replace(/\.ts$/u, ""), readFileSync(join(workerToolsDir, f), "utf8"));
  }
} catch {
}

const problems = checkWindowGateManifest(coreTools, appShims, frameworkToolNames, undefined, undefined, workerShims);

if (problems.length > 0) {
  console.error(`✗ window-gate-lint: ${problems.length} problem(s):\n` + problems.map((p) => `  - ${p}`).join("\n"));
  process.exit(1);
}
console.log(
  `✓ window-gate-lint: every tool over the runtime surface (${coreTools.length} core-authored + ${appShims.size} deploy shims + ${frameworkToolNames.length} eve-framework names + ${workerShims.size} worker shims) carries exactly one declared grain posture, ` +
    `the grain-scoping invariants hold, every gated tool's source carries its gate, and the worker surface matches WORKER_KIT.`,
);
