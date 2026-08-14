import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { findProtectedImports, PROTECTED_HUMAN_ONLY_EXPORTS } from "@open-everywhere/core/agent/access/human-only-invariants-manifest.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isGitIgnored(dir: string): boolean {
  try {
    execFileSync("git", ["check-ignore", "-q", dir], { cwd: root, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...tsFilesUnder(full));
    else if (name.endsWith(".ts") && !name.endsWith(".d.ts") && !name.endsWith("-test.ts")) out.push(full);
  }
  return out;
}

const toolRoots: string[] = [];
const addRoot = (dir: string): void => {
  if (isDir(dir) && !isGitIgnored(dir)) toolRoots.push(dir);
};
addRoot(join(root, "packages", "core", "agent", "tools"));
const providersDir = join(root, "packages", "providers");
try {
  for (const p of readdirSync(providersDir)) addRoot(join(providersDir, p, "agent", "tools"));
} catch {
}
addRoot(join(root, "agent", "tools"));

if (toolRoots.length === 0) {
  console.error(`✗ human-only-invariants-lint: found no agent-tool roster directory under ${root} — refusing to report clean against an unread tree`);
  process.exit(1);
}

const files = toolRoots.flatMap(tsFilesUnder);
if (files.length === 0) {
  console.error(`✗ human-only-invariants-lint: ${toolRoots.length} roster dir(s) found, but they hold no .ts files — refusing to report clean against an unread tree`);
  process.exit(1);
}

const sites = files.flatMap((f) => findProtectedImports(relative(root, f), readFileSync(f, "utf8")));

if (sites.length > 0) {
  console.error(`✗ human-only-invariants-lint: ${sites.length} agent-tool file(s) import a human-only export:`);
  for (const s of sites) {
    console.error(`  - ${s.file}:${s.line} imports "${s.name}" — ${s.group.reason}`);
  }
  console.error(
    `\n  Why this is a hard error: the stance is not to prevent the agent from acting, it is to require a human\n` +
      `  to approve anything consequential. A tool that can decide its own approval, or write the trust\n` +
      `  registry that decides which rooms are trusted, has configured that requirement away.`,
  );
  process.exit(1);
}

const totalNames = PROTECTED_HUMAN_ONLY_EXPORTS.reduce((n, g) => n + g.exportNames.length, 0);
console.log(
  `✓ human-only-invariants-lint: ${files.length} agent-tool file(s) across ${toolRoots.length} roster dir(s) import none of the ${totalNames} human-only export(s) (${PROTECTED_HUMAN_ONLY_EXPORTS.length} group(s): approval-decide, trust-write).`,
);
