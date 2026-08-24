import assert from "node:assert/strict";

import type { ExecResult } from "./deploy/lib.js";
import { classifyCheckRuns, decideCiGate, fetchCheckRunsForSha, runCiGate, type CheckRun } from "./deploy/ci-gate-lib.js";

let checks = 0;
const check = (label: string, fn: () => void | Promise<void>): Promise<void> | void => {
  checks++;
  return fn() as void;
};

const SHA = "0123456789abcdef0123456789abcdef01234567";

const GREEN: CheckRun[] = [
  { name: "typecheck + deterministic suites", status: "completed", conclusion: "success" },
  { name: "eve build + integration tier", status: "completed", conclusion: "success" },
];

check("classifyCheckRuns buckets pending/failing/cancelled/passing correctly", () => {
  const runs: CheckRun[] = [
    { name: "unit", status: "completed", conclusion: "success" },
    { name: "integration", status: "in_progress", conclusion: null },
    { name: "flaky", status: "completed", conclusion: "failure" },
    { name: "superseded", status: "completed", conclusion: "cancelled" },
    { name: "informational", status: "completed", conclusion: "neutral" },
  ];
  const c = classifyCheckRuns(runs);
  assert.deepEqual(c.passing.map((r) => r.name), ["unit", "informational"]);
  assert.deepEqual(c.pending.map((r) => r.name), ["integration"]);
  assert.deepEqual(c.failing.map((r) => r.name), ["flaky"]);
  assert.deepEqual(c.cancelled.map((r) => r.name), ["superseded"]);
});

check("decideCiGate PASSES when every check-run is completed + a passing conclusion", () => {
  const decision = decideCiGate({ sha: SHA, checkRuns: GREEN, isTip: true });
  assert.equal(decision.verdict, "pass");
  assert.match(decision.message, /green/);
});

check("decideCiGate REFUSES when any check-run is a failing conclusion (the forced-red case)", () => {
  const red: CheckRun[] = [GREEN[0], { name: "eve build + integration tier", status: "completed", conclusion: "failure" }];
  const decision = decideCiGate({ sha: SHA, checkRuns: red, isTip: true });
  assert.equal(decision.verdict, "refuse");
  assert.match(decision.message, /red/);
  assert.match(decision.message, /failure/);
});

check("decideCiGate REFUSES on timed_out / action_required / stale, not only 'failure'", () => {
  for (const conclusion of ["timed_out", "action_required", "stale"]) {
    const decision = decideCiGate({
      sha: SHA,
      checkRuns: [{ name: "eve build + integration tier", status: "completed", conclusion }],
      isTip: true,
    });
    assert.equal(decision.verdict, "refuse", `${conclusion} must refuse`);
  }
});

check("decideCiGate: one pending run alongside a passing one still refuses (in-flight, not red)", () => {
  const mixed: CheckRun[] = [GREEN[0], { name: "eve build + integration tier", status: "in_progress", conclusion: null }];
  const decision = decideCiGate({ sha: SHA, checkRuns: mixed, isTip: true });
  assert.equal(decision.verdict, "refuse");
  assert.match(decision.message, /in flight/);
  assert.match(decision.message, /eve build \+ integration tier/);
});

check("decideCiGate: no run yet + isTip → refuse, 'may not have started'", () => {
  const decision = decideCiGate({ sha: SHA, checkRuns: [], isTip: true });
  assert.equal(decision.verdict, "refuse");
  assert.match(decision.message, /may not have started/);
});

check("decideCiGate: no run yet + NOT tip → refuse, points at the current tip instead", () => {
  const decision = decideCiGate({ sha: SHA, checkRuns: [], isTip: false });
  assert.equal(decision.verdict, "refuse");
  assert.match(decision.message, /not the tip/);
  assert.match(decision.message, /current tip/);
});

check("decideCiGate: cancelled + NOT tip → refuse, names tip-wins concurrency as expected", () => {
  const decision = decideCiGate({
    sha: SHA,
    checkRuns: [{ name: "eve build + integration tier", status: "completed", conclusion: "cancelled" }],
    isTip: false,
  });
  assert.equal(decision.verdict, "refuse");
  assert.match(decision.message, /tip-wins concurrency/);
  assert.match(decision.message, /expected, not a red/);
});

check("decideCiGate: cancelled + isTip → refuse, no superseding commit to explain it", () => {
  const decision = decideCiGate({
    sha: SHA,
    checkRuns: [{ name: "eve build + integration tier", status: "completed", conclusion: "cancelled" }],
    isTip: true,
  });
  assert.equal(decision.verdict, "refuse");
  assert.match(decision.message, /no later commit/);
});

check("fetchCheckRunsForSha: a failed SPAWN refuses loudly, naming the spawn error — not empty check-runs", async () => {
  const spawnFailed: ExecResult = { code: 1, stdout: "", stderr: "", spawnError: "ENOENT: spawn gh ENOENT" };
  const result = await fetchCheckRunsForSha({ sha: SHA, exec: async () => spawnFailed });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.reason, /could not run `gh`/);
    assert.match(result.reason, /ENOENT/);
  }
});

check("fetchCheckRunsForSha: empty stdout WITHOUT spawnError is read as unparsable data, not a spawn failure", async () => {
  const ranButPrintedNothing: ExecResult = { code: 0, stdout: "", stderr: "" };
  const result = await fetchCheckRunsForSha({ sha: SHA, exec: async () => ranButPrintedNothing });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.doesNotMatch(result.reason, /spawn/i);
    assert.match(result.reason, /not JSON/);
  }
});

check("fetchCheckRunsForSha: a non-zero gh exit refuses and surfaces stderr", async () => {
  const authFailed: ExecResult = { code: 4, stdout: "", stderr: "gh: not authenticated" };
  const result = await fetchCheckRunsForSha({ sha: SHA, exec: async () => authFailed });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /not authenticated/);
});

check("fetchCheckRunsForSha: parses a real check-runs response shape into CheckRun[]", async () => {
  const body = {
    total_count: 2,
    check_runs: [
      { name: "typecheck + deterministic suites", status: "completed", conclusion: "success", head_sha: SHA },
      { name: "eve build + integration tier", status: "in_progress", conclusion: null, head_sha: SHA },
    ],
  };
  const ok: ExecResult = { code: 0, stdout: JSON.stringify(body), stderr: "" };
  const result = await fetchCheckRunsForSha({ sha: SHA, exec: async () => ok });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.checkRuns.length, 2);
    assert.equal(result.checkRuns[1].status, "in_progress");
    assert.equal(result.checkRuns[1].conclusion, null);
  }
});

check("fetchCheckRunsForSha: a response with no check_runs array refuses rather than treating it as empty", async () => {
  const malformed: ExecResult = { code: 0, stdout: JSON.stringify({ message: "Not Found" }), stderr: "" };
  const result = await fetchCheckRunsForSha({ sha: SHA, exec: async () => malformed });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /check_runs/);
});

await check("runCiGate: a fetch failure REFUSES (never passes a deploy CI state could not be read for)", async () => {
  const spawnFailed: ExecResult = { code: 1, stdout: "", stderr: "", spawnError: "ENOENT: spawn gh ENOENT" };
  const decision = await runCiGate({ sha: SHA, isTip: true, exec: async () => spawnFailed });
  assert.equal(decision.verdict, "refuse");
  assert.match(decision.message, /could not read CI state/);
});

await check("runCiGate: a genuinely green response PASSES end to end", async () => {
  const body = { total_count: 2, check_runs: GREEN.map((r) => ({ ...r, head_sha: SHA })) };
  const ok: ExecResult = { code: 0, stdout: JSON.stringify(body), stderr: "" };
  const decision = await runCiGate({ sha: SHA, isTip: true, exec: async () => ok });
  assert.equal(decision.verdict, "pass");
});

console.log(`✓ deploy-ci-gate: ${checks} check(s) passed (classification, decision matrix, spawn-trap seam, fetch→decide — all offline)`);
