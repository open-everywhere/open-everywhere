import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkResourceGrantMounts,
  RESOURCE_GRANT_TOOL_MOUNTS,
  type ResourceGrantToolFile,
} from "@open-everywhere/core/agent/access/resource-grant-manifest.js";

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

const tools: ResourceGrantToolFile[] = [];
for (const dir of toolDirs()) {
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.startsWith("_"))) {
    tools.push({ name: f.replace(/\.ts$/u, ""), source: readFileSync(join(dir, f), "utf8") });
  }
}

const problems = checkResourceGrantMounts(tools);

if (problems.length > 0) {
  console.error(`✗ resource-grant-mount-lint: ${problems.length} problem(s):\n` + problems.map((p) => `  - ${p}`).join("\n"));
  process.exit(1);
}
console.log(
  `✓ resource-grant-mount-lint: every resource-grant tool names its tier's MOUNT and its tier's FENCE — ` +
    `${Object.keys(RESOURCE_GRANT_TOOL_MOUNTS).length} classified, scanned across ${tools.length} core- and bundle-authored tools, ` +
    `and no un-classified tool touching the plane.`,
);
