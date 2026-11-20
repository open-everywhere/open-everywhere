import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { checkStandDownGateSites, type StandDownGateFile } from "@open-everywhere/core/agent/channels/stand-down-gate-manifest.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const scanRootArg = process.argv.indexOf("--scan-root");
const scanRoot = scanRootArg === -1 ? root : process.argv[scanRootArg + 1];
if (scanRoot === undefined) {
  console.error("✗ stand-down-gate-lint: --scan-root needs a directory");
  process.exit(2);
}

function isDir(d: string): boolean {
  try {
    return statSync(d).isDirectory();
  } catch {
    return false;
  }
}

const toolDirs = [join(scanRoot, "packages", "core", "agent", "tools"), join(scanRoot, "agent", "tools")];
const providersDir = join(scanRoot, "packages", "providers");
if (isDir(providersDir)) {
  for (const p of readdirSync(providersDir)) toolDirs.push(join(providersDir, p, "agent", "tools"));
}

const files: StandDownGateFile[] = [];
for (const dir of toolDirs.filter(isDir)) {
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith(".ts") || name.endsWith(".d.ts") || name.endsWith(".test.ts")) continue;
    const full = join(dir, name);
    if (!statSync(full).isFile()) continue;
    files.push({ file: relative(scanRoot, full).split("\\").join("/"), source: readFileSync(full, "utf8") });
  }
}
if (files.length === 0) {
  console.error(`✗ stand-down-gate-lint: found no tool sources under ${scanRoot} — refusing to report clean against an unread tree`);
  process.exit(1);
}

const problems = checkStandDownGateSites(files);
if (problems.length > 0) {
  console.error(`✗ stand-down-gate-lint: ${problems.length} problem(s):\n` + problems.map((p) => `  - ${p}`).join("\n"));
  process.exit(1);
}
console.log(`✓ stand-down-gate-lint: every tool file that names a posting primitive calls the stand-down gate or has a reviewed STAND_DOWN_UNGATED entry (a text match: a post through a helper in another module, an entity action or a connector mount op is not seen) — ${files.length} tool files scanned.`);
