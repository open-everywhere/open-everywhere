import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const LINT = join(dirname(fileURLToPath(import.meta.url)), "own-account-gate-lint.ts");
const REFUSAL = "refusing to report clean against an unread tree";

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};

function lint(scanRoot: string): { status: number | null; stdout: string; stderr: string } {
  const argv = [...process.execArgv];
  if (!argv.some((a) => a.includes("tsx"))) argv.push("--import", "tsx");
  const r = spawnSync(process.execPath, [...argv, LINT, "--scan-root", scanRoot], { encoding: "utf8" });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

const scratch = mkdtempSync(join(tmpdir(), "oe-own-account-refusal-"));
try {
  const empty = join(scratch, "empty");
  mkdirSync(empty);
  const refused = lint(empty);
  ok(refused.status === 1, `an empty scan root exits 1 (got ${refused.status}; stderr: ${refused.stderr.slice(0, 400)})`);
  ok(refused.stderr.includes(REFUSAL), `…and the red is the refusal, not a rule finding (stderr: ${refused.stderr.slice(0, 400)})`);

  const bare = join(scratch, "bare");
  mkdirSync(join(bare, "packages", "providers", "x"), { recursive: true });
  mkdirSync(join(bare, "packages", "core", "agent"), { recursive: true });
  const bareRun = lint(bare);
  ok(bareRun.status === 1 && bareRun.stderr.includes(REFUSAL), "a tree whose agent roots exist but hold no .ts source is refused too");

  const one = join(scratch, "one");
  mkdirSync(join(one, "agent"), { recursive: true });
  writeFileSync(join(one, "agent", "a.ts"), "export const a = 1;\n");
  const read = lint(one);
  ok(!read.stderr.includes(REFUSAL), `🔴 NEGATIVE CONTROL: a tree with one agent source is read, not refused (stderr: ${read.stderr.slice(0, 400)})`);
  ok(
    /[✓✗] own-account-gate-lint: (?:every connector|\d+ problem)/.test(read.stdout + read.stderr),
    `…and the lint ran its rules to a verdict (✓ or a rule finding), not a crash (stdout: ${read.stdout.slice(0, 200)}; stderr: ${read.stderr.slice(0, 400)})`,
  );
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

console.log(`✓ own-account-gate-refusal: ${n} assertions — an unread tree is refused by name, and a read one is not`);
