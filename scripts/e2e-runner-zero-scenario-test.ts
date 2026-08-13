import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RUNNER = join(REPO, "packages/core/scripts/e2e/runner.ts");
const TSX = join(REPO, "node_modules/.bin/tsx");

function run(env: Record<string, string>): { code: number; out: string } {
  try {
    const out = execFileSync(TSX, [RUNNER], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: process.env.PATH ?? "", ...env },
      timeout: 30_000,
    });
    return { code: 0, out };
  } catch (err) {
    const e = err as { status?: number | null; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

{
  const r = run({});
  ok(r.code === 0, `dry mode (no capabilities) exits 0 — got ${r.code}. Output:\n${r.out}`);
  ok(r.out.includes("dry mode"), "dry mode names itself in the summary line");
}

{
  const r = run({
    E2E_SLACK_USER_TOKEN: "xoxp-fake-e2e-guard-test",
    E2E_SLACK_CHANNEL: "C000FAKE",
    E2E_SLACK_BOT_USER_ID: "U000FAKE",
    E2E_SURFACES: "teams",
  });
  ok(r.code !== 0, `a live capability configured but 0 scenarios ran (filtered to a surface with no capability) exits NON-zero — got ${r.code}. Output:\n${r.out}`);
  ok(!r.out.includes("dry mode"), "this is NOT the dry-mode path — capabilities were configured");
  ok(r.out.includes("0 scenarios ran"), "the red names the zero-scenario condition, not a generic failure");
}

console.log(`✓ e2e-runner-zero-scenario-test: ${n} assertions passed (dry-mode pass preserved, filtered-to-nothing now reds)`);
