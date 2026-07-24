import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { checkSourceGate, SOURCE_SCOPED_TOOLS, GENERIC_READ_VERBS, type SourceToolFile } from "@open-everywhere/core/agent/access/source-gate-manifest.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function toolDirs(): string[] {
  const dirs = [join(root, "packages", "core", "agent", "tools")];
  const providersRoot = join(root, "packages", "providers");
  if (existsSync(providersRoot)) {
    for (const e of readdirSync(providersRoot, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name.startsWith(".")) continue;
      const d = join(providersRoot, e.name, "agent", "tools");
      if (existsSync(d)) dirs.push(d);
    }
  }
  return dirs;
}

const coreTools: SourceToolFile[] = [];
for (const dir of toolDirs()) {
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.startsWith("_"))) {
    coreTools.push({ name: f.replace(/\.ts$/u, ""), source: readFileSync(join(dir, f), "utf8") });
  }
}

const problems = checkSourceGate(coreTools);

if (problems.length > 0) {
  console.error(`✗ source-gate-lint: ${problems.length} problem(s):\n` + problems.map((p) => `  - ${p}`).join("\n"));
  process.exit(1);
}
console.log(
  `✓ source-gate-lint: every per-surface tool (${Object.keys(SOURCE_SCOPED_TOOLS).length} declared) gates its mount on X ∈ sources via sourceScopedMount, ` +
    `every generic read verb (${GENERIC_READ_VERBS.length} declared) gates per-platform in execute (resolveWindowSources + assertTurnSurface), ` +
    `scanned across ${coreTools.length} core- and bundle-authored tools, and no un-declared tool blanket-mounts on a unified window.`,
);
