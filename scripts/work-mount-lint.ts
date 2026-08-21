import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkWorkMounts,
  WORK_MOUNT_GAPS,
  WORK_TOOL_MOUNTS,
  type WorkToolFile,
} from "@open-everywhere/core/agent/access/work-mount-manifest.js";

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

const tools: WorkToolFile[] = [];
for (const dir of toolDirs()) {
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.startsWith("_"))) {
    tools.push({ name: f.replace(/\.ts$/u, ""), source: readFileSync(join(dir, f), "utf8") });
  }
}

const problems = checkWorkMounts(tools);

if (problems.length > 0) {
  console.error(`✗ work-mount-lint: ${problems.length} problem(s):\n` + problems.map((p) => `  - ${p}`).join("\n"));
  process.exit(1);
}
console.log(
  `✓ work-mount-lint: every work tool decides its mount from the caller's work grant — ` +
    `${Object.keys(WORK_TOOL_MOUNTS).length} declared (grant-only or sources ∪ grant), ` +
    `${Object.keys(WORK_MOUNT_GAPS).length} declared gap(s) still carrying their execute fence, ` +
    `scanned across ${tools.length} core- and bundle-authored tools, and no un-classified work tool.`,
);
