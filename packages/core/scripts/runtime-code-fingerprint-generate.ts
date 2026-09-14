import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

const RUNTIME_CODE_FINGERPRINT_FILE = join(REPO_ROOT, "packages/core/agent/channels/runtime-code-fingerprint.generated.ts");

const RUNTIME_CODE_ROOTS: readonly string[] = [
  "agent",
  "packages/core/agent",
  "packages/adapters/agent",
  "packages/providers/discord/agent",
  "packages/providers/github/agent",
  "packages/providers/linear/agent",
  "packages/providers/notion/agent",
  "packages/providers/slack/agent",
  "packages/providers/teams/agent",
];

const RUNTIME_CODE_EXCLUDED_DIRS: readonly string[] = [
  "agent/memory/config/domains",
  "agent/docs/generated",
  "agent/tools",
  "agent/channels",
  "agent/hooks",
  "agent/schedules",
  "agent/skills",
  "agent/connections",
];

const RUNTIME_CODE_EXCLUDED_FILES: readonly string[] = ["agent/lib/providers.generated.ts", "packages/core/agent/channels/runtime-code-fingerprint.generated.ts"];

const RUNTIME_CODE_EXTRA_FILES: readonly string[] = ["roster.config.ts", "roster.lock.json", "agent/instructions.md"];

const RUNTIME_CODE_EXTRA_DIRS: readonly string[] = ["patches"];

function isRuntimeCodeFile(relPath: string): boolean {
  if (!relPath.endsWith(".ts")) return false;
  if (relPath.endsWith(".d.ts")) return false;
  if (relPath.endsWith("docs-generated.ts")) return false;
  if (RUNTIME_CODE_EXCLUDED_FILES.includes(relPath)) return false;
  if (relPath.endsWith("-test.ts") || relPath.endsWith(".test.ts") || relPath.endsWith(".spec.ts")) return false;
  return true;
}

export function runtimeCodeFiles(repoRoot: string = REPO_ROOT): readonly string[] {
  const excluded = new Set(RUNTIME_CODE_EXCLUDED_DIRS);
  const found: string[] = [];
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      const rel = relative(repoRoot, abs).split(sep).join("/");
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "dist" || excluded.has(rel)) continue;
        walk(abs);
      } else if (entry.isFile() && isRuntimeCodeFile(rel)) {
        found.push(rel);
      }
    }
  };
  for (const root of RUNTIME_CODE_ROOTS) {
    const abs = join(repoRoot, root);
    try {
      if (!statSync(abs).isDirectory()) continue;
    } catch {
      continue;
    }
    walk(abs);
  }
  for (const rel of RUNTIME_CODE_EXTRA_FILES) {
    try {
      if (statSync(join(repoRoot, rel)).isFile()) found.push(rel);
    } catch {
    }
  }
  for (const dir of RUNTIME_CODE_EXTRA_DIRS) {
    let entries;
    try {
      entries = readdirSync(join(repoRoot, dir), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isFile()) found.push(`${dir}/${entry.name}`);
    }
  }
  return found.sort();
}

export function computeRuntimeCodeFingerprint(repoRoot: string = REPO_ROOT): string {
  const digest = createHash("sha256");
  for (const rel of runtimeCodeFiles(repoRoot)) {
    digest.update(rel);
    digest.update("\0");
    digest.update(createHash("sha256").update(readFileSync(join(repoRoot, rel))).digest());
    digest.update("\n");
  }
  return digest.digest("hex").slice(0, 16);
}

function renderRuntimeCodeFingerprintModule(fingerprint: string): string {
  return [
    "// GENERATED FILE — DO NOT EDIT, AND DO NOT COMMIT (it is gitignored).",
    "// Written by packages/core/scripts/runtime-code-fingerprint-generate.ts, which npm runs as `prebuild:packages`.",
    "// Read by packages/core/agent/channels/runtime-rotation.ts: when this value differs from the one a",
    "// standing seat was last served with, the code under that seat changed and its generation retires.",
    "",
    "// It is meaningful ONLY in a tree that runs this generator: a consumer installing",
    "// @open-everywhere/core from a registry gets the value baked at PUBLISH time, and its own",
    "// agent/ edits move no fingerprint. The scaffolder clones this monorepo for that reason.",
    "",
    `export const RUNTIME_CODE_FINGERPRINT_SOURCE = ${JSON.stringify(fingerprint)};`,
    "",
  ].join("\n");
}

export function writeRuntimeCodeFingerprint(
  outFile: string = RUNTIME_CODE_FINGERPRINT_FILE,
  repoRoot: string = REPO_ROOT,
): { readonly fingerprint: string; readonly wrote: boolean } {
  const fingerprint = computeRuntimeCodeFingerprint(repoRoot);
  const next = renderRuntimeCodeFingerprintModule(fingerprint);
  let current: string | undefined;
  try {
    current = readFileSync(outFile, "utf8");
  } catch {
    current = undefined;
  }
  if (current === next) return { fingerprint, wrote: false };
  writeFileSync(outFile, next, "utf8");
  return { fingerprint, wrote: true };
}

function main(): void {
  const { fingerprint, wrote } = writeRuntimeCodeFingerprint();
  console.log(`[runtime-code-fingerprint] ${fingerprint} ${wrote ? "over" : "unchanged over"} ${runtimeCodeFiles().length} runtime source files`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
