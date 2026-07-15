import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { checkSourceGate, SOURCE_SCOPED_TOOLS, type SourceToolFile } from "@open-everywhere/core/agent/access/source-gate-manifest.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const coreToolsDir = join(root, "packages", "core", "agent", "tools");

const coreTools: SourceToolFile[] = [];
for (const f of readdirSync(coreToolsDir).filter((f) => f.endsWith(".ts") && !f.startsWith("_"))) {
  coreTools.push({ name: f.replace(/\.ts$/u, ""), source: readFileSync(join(coreToolsDir, f), "utf8") });
}

const problems = checkSourceGate(coreTools);

if (problems.length > 0) {
  console.error(`✗ source-gate-lint: ${problems.length} problem(s):\n` + problems.map((p) => `  - ${p}`).join("\n"));
  process.exit(1);
}
console.log(
  `✓ source-gate-lint: every per-surface tool (${Object.keys(SOURCE_SCOPED_TOOLS).length} declared, scanned across ${coreTools.length} core-authored tools) gates its mount on X ∈ sources via sourceScopedMount, and no un-declared tool blanket-mounts on a unified window.`,
);
