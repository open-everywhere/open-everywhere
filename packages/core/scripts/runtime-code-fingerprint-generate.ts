import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { codeFingerprintFiles, computeCodeFingerprint, type CodeFingerprintSpec } from "./code-fingerprint.js";

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
  "packages/core/agent/docs/generated",
  "agent/tools",
  "agent/channels",
  "agent/hooks",
  "agent/schedules",
  "agent/skills",
  "agent/connections",
];

const RUNTIME_CODE_EXCLUDED_FILES: readonly string[] = [
  "agent/lib/providers.generated.ts",
  "agent/lib/app-code-fingerprint.generated.ts",
  "packages/core/agent/channels/runtime-code-fingerprint.generated.ts",
];

const RUNTIME_CODE_EXTRA_FILES: readonly string[] = ["roster.config.ts", "roster.lock.json"];

const RUNTIME_CODE_EXTRA_DIRS: readonly string[] = ["patches"];

const RUNTIME_CODE_SPEC: CodeFingerprintSpec = {
  roots: RUNTIME_CODE_ROOTS,
  excludedDirs: RUNTIME_CODE_EXCLUDED_DIRS,
  excludedFiles: RUNTIME_CODE_EXCLUDED_FILES,
  extraFiles: RUNTIME_CODE_EXTRA_FILES,
  extraDirs: RUNTIME_CODE_EXTRA_DIRS,
};

export function runtimeCodeFiles(repoRoot: string = REPO_ROOT): readonly string[] {
  return codeFingerprintFiles(repoRoot, RUNTIME_CODE_SPEC);
}

export function computeRuntimeCodeFingerprint(repoRoot: string = REPO_ROOT): string {
  return computeCodeFingerprint(repoRoot, RUNTIME_CODE_SPEC);
}

function renderRuntimeCodeFingerprintModule(fingerprint: string): string {
  return [
    "// GENERATED FILE — DO NOT EDIT, AND DO NOT COMMIT (it is gitignored).",
    "// Written by packages/core/scripts/runtime-code-fingerprint-generate.ts, which npm runs as `prebuild:packages`.",
    "// Read by packages/core/agent/channels/runtime-rotation.ts: when this value differs from the one a",
    "// standing seat was last served with, the code under that seat changed and its generation retires.",
    "",
    "// This is the PRODUCT half. An app installing @open-everywhere/core from a registry gets the",
    "// value baked at PUBLISH time. The app's own agent/ tree is the APP half, which `oe build` writes",
    "// to agent/lib/app-code-fingerprint.generated.ts (packages/core/scripts/code-fingerprint.ts).",
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
