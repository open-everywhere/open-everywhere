import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { finishedRun, IncompleteChildRun, tsxCommand, type ChildResult } from "./npm-command.js";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

let lastOut = "";
let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, cond ? label : `${label}\n--- the runner's output for this run ---\n${lastOut}`);
  n++;
};

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RUNNER = join(REPO, "packages/core/scripts/e2e/runner.ts");
const [TSX, TSX_ARGS] = tsxCommand(REPO, [RUNNER]);
const RUN_TIMEOUT_MS = 120_000;

function run(env: Record<string, string>, timeout = RUN_TIMEOUT_MS): { code: number; out: string } {
  try {
    const out = execFileSync(TSX, TSX_ARGS, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: process.env.PATH ?? "", ...env },
      timeout,
    });
    lastOut = out;
    return { code: 0, out };
  } catch (err) {
    const e = err as ChildResult & { stdout?: string; stderr?: string };
    lastOut = `${e.stdout ?? ""}${e.stderr ?? ""}`;
    return { code: finishedRun(e, "the e2e runner").status, out: lastOut };
  }
}

{
  let thrown: unknown;
  try {
    run({ E2E_RELEASE_SCOPE: "launch" }, 100);
  } catch (err) {
    thrown = err;
  }
  ok(thrown instanceof IncompleteChildRun, `🔴 a runner killed at its ceiling THROWS IncompleteChildRun, never a graded { code, out } — got ${String(thrown)}`);
  ok(thrown instanceof IncompleteChildRun && /INCOMPLETE RUN — the e2e runner timed out/.test(thrown.message), "…and the error says the run timed out, in plain words");
}

{
  const r = run({});
  ok(r.code === 0, `dry mode (no capabilities) exits 0 — got ${r.code}. Output:\n${r.out}`);
  ok(r.out.includes("dry mode"), "dry mode names itself in the summary line");
  ok(r.out.includes("skip breakdown:"), "the summary carries a skip breakdown line");
  ok(/skip breakdown: \d+ missing-capability$/m.test(r.out), `the dry-mode breakdown names only missing-capability — got:\n${r.out}`);
  const board = r.out.indexOf("## Ship legs");
  const reader = r.out.indexOf("## Reader check");
  ok(board >= 0 && reader > board, `the reader check's section prints after the board — got:\n${r.out}`);
  ok(/0 posted text\(s\) read on 0 leg\(s\) — 0 flag\(s\)\. Graded by nobody/.test(r.out), "…and a dry run's section says nothing was read");
}

{
  const r = run({
    E2E_SLACK_USER_TOKEN: "xoxp-fake-e2e-guard-test",
    E2E_SLACK_CHANNEL: "C000FAKE",
    E2E_SLACK_BOT_USER_ID: "U000FAKE",
    E2E_SURFACES: "teams",
  });
  ok(r.code !== 0, `a live capability configured with no teams driver exits NON-zero — got ${r.code}. Output:\n${r.out}`);
  ok(!r.out.includes("dry mode"), "this is NOT the dry-mode path — capabilities were configured");
  ok(r.out.includes("CANNOT RUN"), `each unrunnable teams leg reds by name rather than skipping — got:\n${r.out}`);
  ok(r.out.includes("E2E_TEAMS_"), "…and the red names the variable that would arm it, so the reason is actionable");
  ok(r.out.includes("## Ship legs"), "the board is printed — the ship report's table is the runner's own output");
  ok(/\| J-TEAMS \| teams \| RED \|/.test(r.out), `…and J-TEAMS is a RED row on it — got:\n${r.out}`);
}

{
  const r = run({
    E2E_SLACK_USER_TOKEN: "xoxp-fake-e2e-guard-test",
    E2E_SLACK_CHANNEL: "C000FAKE",
    E2E_SLACK_BOT_USER_ID: "U000FAKE",
    E2E_ONLY: "J1",
    E2E_SURFACES: "teams",
  });
  ok(r.code !== 0, `--only naming a slack leg while E2E_SURFACES=teams exits NON-zero — got ${r.code}. Output:\n${r.out}`);
  ok(!r.out.includes("dry mode"), "this is NOT the dry-mode path — capabilities were configured");
  ok(r.out.includes("0 scenarios ran"), "the red names the zero-scenario condition, not a generic failure");
  ok(r.out.includes("skip breakdown:"), "the zero-scenario red carries a skip breakdown line");
  ok(r.out.includes("filtered-surface"), `the breakdown names filtered-surface — got:\n${r.out}`);
}

{
  const r = run({ E2E_RELEASE_SCOPE: "launch" });
  ok(r.code !== 0, `a canonical launch run with no capabilities exits NON-zero — got ${r.code}. Output:\n${r.out}`);
  ok(r.out.includes("release scope=launch: 64 REQUIRED, 55 NON_LAUNCH"), "the canonical selector prints its reviewed accounting totals");
  ok(/\| J1 \| slack \| REQUIRED \| RED \|/.test(r.out), `a required missing Slack leg is RED — got:\n${r.out}`);
  ok(/\| S-SPEND-DM-MASK \| slack \| REQUIRED \| RED \|/.test(r.out), "a shared security row remains REQUIRED, and a leg that could not run scores RED on a LAUNCH surface (OPE-1914 re-vehicled this row onto Slack)");
  ok(/\| S-DISCORD-GRANT \| discord \| REQUIRED \| RED \|/.test(r.out), "the unresolved live grant-used to grant-notified row remains REQUIRED despite its Discord vehicle");
  ok(
    /\| S-GITHUB-NOTION-REST \| cross \| REQUIRED \| RED \|/.test(r.out),
    "the GitHub-origin shared Notion REST workflow is an explicit required row, not only part of the aggregate count",
  );
  ok(
    /\| S-SUSPENDED-github \| github \| NON_LAUNCH \| NOT_RUN \|/.test(r.out) &&
      r.out.includes("no connector write that raises an op.connector card is reachable from a GitHub seat"),
    "the unsupported GitHub carded-write GAP stays visible as a reasoned pilot NON_LAUNCH row",
  );
  ok(
    r.out.includes("S-DISCORD-GRANT requires the human-tapped phase") && r.out.includes("E2E_DISCORD_GRANT_TAPPED=1"),
    "an untapped raising phase is visibly RED and cannot masquerade as deployed grant.used/grant.notified evidence",
  );
  ok(/\| J-DISC \| discord \| NON_LAUNCH \| NOT_RUN \|/.test(r.out), "a platform-only Discord row remains visible as NOT_RUN");
  ok(r.out.includes("55 NOT RUN outside this release scope"), "the board headline preserves the complete non-launch count");
  ok(r.out.includes("required-not-green="), "the scoped verdict names every required row that failed to turn green");
}

{
  const r = run({ E2E_RELEASE_SCOPE: "launch", E2E_DISCORD_GRANT_TAPPED: "1" });
  ok(r.code !== 0, "a tapped release run without the Discord fixture remains nonzero");
  ok(!r.out.includes("S-DISCORD-GRANT requires the human-tapped phase"), "the tapped pin clears the phase prerequisite");
  ok(/\| S-DISCORD-GRANT \| discord \| REQUIRED \| RED \| cannot run —/.test(r.out), "the tapped row then reaches its ordinary missing-capability refusal");
}

{
  const r = run({ E2E_RELEASE_SCOPE: "launch", E2E_ONLY: "J1" });
  ok(r.code !== 0, "E2E_ONLY cannot compose with the canonical release selector");
  ok(r.out.includes("reviewed scope itself is the complete selector"), "the selector conflict explains the fail-closed remedy");
}

{
  const r = run({ E2E_RELEASE_SCOPE: "launch", E2E_SURFACES: "slack,notion,github" });
  ok(r.code !== 0, "a launch-surface filter cannot erase shared rows from the canonical release selector");
  ok(r.out.includes("reviewed scope itself is the complete selector"), "the surface-filter conflict explains why the scope refuses it");
}

console.log(`✓ e2e-runner-zero-scenario-test: ${n} assertions passed (dry-mode pass preserved, filtered-to-nothing now reds)`);
