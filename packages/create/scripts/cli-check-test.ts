import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WIZARD_STEPS } from "../src/steps/index.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const tsxBin = join(repoRoot, "node_modules", ".bin", "tsx");
const cliPath = join(packageRoot, "src", "cli.ts");

function runCli(args: readonly string[], cwd: string): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(tsxBin, [cliPath, ...args], { cwd, encoding: "utf8", env: { ...process.env } });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

{
  const version = runCli(["--version"], packageRoot);
  ok(version.status === 0, "--version: exits 0");
  ok(/^\d+\.\d+\.\d+/.test(version.stdout.trim()), "--version: prints a semver-looking string");

  const help = runCli(["--help"], packageRoot);
  ok(help.status === 0, "--help: exits 0");
  ok(help.stdout.includes("--check"), "--help: mentions --check");
}

{
  const dir = mkdtempSync(join(tmpdir(), "oe-wizard-cli-check-test-"));
  try {
    const result = runCli(["--check"], dir);
    ok(result.status === 1, "--check: exits 1 when the checklist isn't fully satisfied (a bare scratch dir never is)");
    ok(result.stdout.includes("Prerequisites"), "--check: reports the prerequisites step");
    ok(result.stdout.includes("Repo"), "--check: reports the repo step");
    ok(result.stdout.includes("Slack app"), "--check: reports the Slack step");
    ok(result.stdout.includes("Roster ("), "--check: reports the roster step");
    ok(
      new RegExp(String.raw`\d+/${WIZARD_STEPS.length} steps satisfied\.`).test(result.stdout),
      `--check: prints an N/${WIZARD_STEPS.length} summary line covering every registered step`,
    );
    ok(!existsSync(join(dir, ".open-everywhere", "wizard-state.json")), "--check: never writes wizard-state.json (no prompts, no side effects)");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`✓ ${n} CLI --check assertions passed`);
