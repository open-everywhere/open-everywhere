import assert from "node:assert/strict";

import type { Env, Exec, ExecResult } from "./deploy/lib.js";
import {
  classifyCheckRuns,
  classifyCloudProofStatus,
  classifyHeavyJob,
  decideCiGate,
  decideCiGateViaCloudProof,
  fetchCheckRunsForSha,
  fetchCombinedStatusForSha,
  GITHUB_API_BASE,
  HEAVY_JOB_NAME,
  listFirstParentAncestors,
  parseGithubOwnerRepo,
  resolveGithubOwnerRepoFromEnv,
  resolveGithubRestToken,
  runCiGate,
  walkBackForCloudProof,
  walkBackForHeavyProof,
  type CheckRun,
  type CommitStatus,
  type GithubApiFetchLike,
} from "./deploy/ci-gate-lib.js";
import { CLOUD_PROOF_CONTEXT } from "./deploy/cloud-proof-post-lib.js";

const NO_TOKEN_ENV: Env = {};

const PANIC_FETCH: GithubApiFetchLike = async () => {
  throw new Error("PANIC_FETCH: the REST fallback must not have been called here");
};

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

check("fetchCheckRunsForSha: a failed SPAWN with no token refuses loudly, naming BOTH remedies (OPE-1117)", async () => {
  const spawnFailed: ExecResult = { code: 1, stdout: "", stderr: "", spawnError: "ENOENT: spawn gh ENOENT" };
  const result = await fetchCheckRunsForSha({ sha: SHA, exec: async () => spawnFailed, fetchImpl: PANIC_FETCH, env: NO_TOKEN_ENV });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.reason, /could not run `gh`/);
    assert.match(result.reason, /ENOENT/);
    assert.match(result.reason, /install the GitHub CLI/);
    assert.match(result.reason, /GH_TOKEN/);
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

check("fetchCheckRunsForSha: a non-zero gh exit refuses and surfaces stderr — never falls back, even with a token set", async () => {
  const authFailed: ExecResult = { code: 4, stdout: "", stderr: "gh: not authenticated" };
  const result = await fetchCheckRunsForSha({
    sha: SHA,
    exec: async () => authFailed,
    fetchImpl: PANIC_FETCH,
    env: { GH_TOKEN: "would-be-used-if-this-were-a-spawn-failure" },
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.reason, /not authenticated/);
    assert.doesNotMatch(result.reason, /REST fallback/);
  }
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
  const decision = await runCiGate({ sha: SHA, isTip: true, exec: async () => spawnFailed, fetchImpl: PANIC_FETCH, env: NO_TOKEN_ENV });
  assert.equal(decision.verdict, "refuse");
  assert.match(decision.message, /could not read CI state/);
});

await check("runCiGate: a genuinely green response PASSES end to end", async () => {
  const body = { total_count: 2, check_runs: GREEN.map((r) => ({ ...r, head_sha: SHA })) };
  const ok: ExecResult = { code: 0, stdout: JSON.stringify(body), stderr: "" };
  const decision = await runCiGate({ sha: SHA, isTip: true, exec: async () => ok });
  assert.equal(decision.verdict, "pass");
});

const GH_ENOENT: ExecResult = { code: 1, stdout: "", stderr: "", spawnError: "ENOENT: spawn gh ENOENT" };
const TOKEN_ENV: Env = { GH_TOKEN: "test-gh-token", GITHUB_REPOSITORY: "acme/oe" };

const NO_GH_EXEC: Exec = async (command, args) => {
  if (command === "gh") return GH_ENOENT;
  throw new Error(`NO_GH_EXEC: unexpected exec(${command}, ${JSON.stringify(args)}) — GITHUB_REPOSITORY should have made this unnecessary`);
};

function routedRestFetch(fixture: Record<string, { status: number; body: unknown }>, calls: { url: string; headers: Record<string, string> }[]): GithubApiFetchLike {
  return async (url, init) => {
    calls.push({ url, headers: init.headers });
    const path = new URL(url).pathname;
    const match = Object.entries(fixture).find(([suffix]) => path.endsWith(suffix));
    if (!match) throw new Error(`routedRestFetch: no fixture for ${path}`);
    const [, { status, body }] = match;
    return { status, text: async () => JSON.stringify(body) };
  };
}

await check("fetchCheckRunsForSha: gh ENOENT + a token falls back to REST and parses identically to the gh path", async () => {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fetchImpl = routedRestFetch({ "/check-runs": { status: 200, body: { total_count: 2, check_runs: GREEN.map((r) => ({ ...r, head_sha: SHA })) } } }, calls);
  const result = await fetchCheckRunsForSha({ sha: SHA, exec: NO_GH_EXEC, fetchImpl, env: TOKEN_ENV });
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.checkRuns, GREEN);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${GITHUB_API_BASE}/repos/acme/oe/commits/${SHA}/check-runs?per_page=100`);
  assert.equal(calls[0].headers.authorization, "Bearer test-gh-token");
});

await check("fetchCombinedStatusForSha: gh ENOENT + a token falls back to REST and parses identically to the gh path", async () => {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fetchImpl = routedRestFetch({ "/status": { status: 200, body: { statuses: [{ context: CLOUD_PROOF_CONTEXT, state: "success" }] } } }, calls);
  const result = await fetchCombinedStatusForSha({ sha: SHA, exec: NO_GH_EXEC, fetchImpl, env: TOKEN_ENV });
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.statuses, [{ context: CLOUD_PROOF_CONTEXT, state: "success" }]);
  assert.equal(calls[0].url, `${GITHUB_API_BASE}/repos/acme/oe/commits/${SHA}/status`);
});

await check("runCiGate: gh ENOENT + REST fallback → GREEN check-runs PASSES, same verdict as the gh path", async () => {
  const fetchImpl = routedRestFetch({ "/check-runs": { status: 200, body: { check_runs: GREEN } } }, []);
  const decision = await runCiGate({ sha: SHA, isTip: true, exec: NO_GH_EXEC, fetchImpl, env: TOKEN_ENV });
  assert.equal(decision.verdict, "pass");
});

await check("runCiGate: gh ENOENT + REST fallback → RED check-run REFUSES, same verdict as the gh path", async () => {
  const fetchImpl = routedRestFetch(
    { "/check-runs": { status: 200, body: { check_runs: [GREEN[0], { name: HEAVY_JOB_NAME, status: "completed", conclusion: "failure" }] } } },
    [],
  );
  const decision = await runCiGate({ sha: SHA, isTip: true, exec: NO_GH_EXEC, fetchImpl, env: TOKEN_ENV });
  assert.equal(decision.verdict, "refuse");
  assert.match(decision.message, /red/);
});

await check("runCiGate: gh ENOENT + REST fallback → IN-FLIGHT check-run REFUSES, same verdict as the gh path", async () => {
  const fetchImpl = routedRestFetch(
    { "/check-runs": { status: 200, body: { check_runs: [GREEN[0], { name: HEAVY_JOB_NAME, status: "in_progress", conclusion: null }] } } },
    [],
  );
  const decision = await runCiGate({ sha: SHA, isTip: true, exec: NO_GH_EXEC, fetchImpl, env: TOKEN_ENV });
  assert.equal(decision.verdict, "refuse");
  assert.match(decision.message, /in flight/);
});

await check(
  "runCiGate: gh ENOENT + REST fallback → ABSENT everywhere REFUSES, proving REST also feeds the cloud-proof + walk-back lane (no forked logic)",
  async () => {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const fetchImpl = routedRestFetch(
      { "/check-runs": { status: 200, body: { check_runs: [] } }, "/status": { status: 200, body: { statuses: [] } } },
      calls,
    );
    const exec: Exec = async (command, args) => {
      if (command === "gh") return GH_ENOENT;
      if (command === "git" && args[0] === "rev-list") return { code: 128, stdout: "", stderr: "fatal: bad revision" };
      throw new Error(`unexpected exec(${command}, ${JSON.stringify(args)})`);
    };
    const decision = await runCiGate({ sha: SHA, isTip: true, exec, fetchImpl, env: TOKEN_ENV });
    assert.equal(decision.verdict, "refuse");
    assert.match(decision.message, /could not list ancestor commits/);
    assert.equal(calls.filter((c) => c.url.includes("/check-runs")).length, 1);
    assert.equal(calls.filter((c) => c.url.includes("/status")).length, 1);
  },
);

await check("fetchCheckRunsForSha: gh ENOENT + token + NO GITHUB_REPOSITORY falls back to `git remote get-url origin`", async () => {
  const exec: Exec = async (command, args) => {
    if (command === "gh") return GH_ENOENT;
    if (command === "git" && args[0] === "remote") return { code: 0, stdout: "https://github.com/acme/oe.git\n", stderr: "" };
    throw new Error(`unexpected exec(${command}, ${JSON.stringify(args)})`);
  };
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fetchImpl = routedRestFetch({ "/check-runs": { status: 200, body: { check_runs: GREEN } } }, calls);
  const result = await fetchCheckRunsForSha({ sha: SHA, exec, fetchImpl, env: { GH_TOKEN: "tok" } });
  assert.equal(result.ok, true);
  assert.equal(calls[0].url, `${GITHUB_API_BASE}/repos/acme/oe/commits/${SHA}/check-runs?per_page=100`);
});

await check("fetchCheckRunsForSha: gh ENOENT + token but no resolvable owner/repo (no GITHUB_REPOSITORY, no origin remote) REFUSES", async () => {
  const exec: Exec = async (command) => {
    if (command === "gh") return GH_ENOENT;
    if (command === "git") return { code: 128, stdout: "", stderr: "fatal: No such remote 'origin'" };
    throw new Error("unexpected exec");
  };
  const result = await fetchCheckRunsForSha({ sha: SHA, exec, fetchImpl: PANIC_FETCH, env: { GH_TOKEN: "tok" } });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.reason, /GITHUB_REPOSITORY/);
    assert.match(result.reason, /git remote get-url origin/);
  }
});

check("parseGithubOwnerRepo: parses https and ssh GitHub remote URLs; rejects a non-GitHub host", () => {
  assert.deepEqual(parseGithubOwnerRepo("https://github.com/acme/oe.git"), { owner: "acme", repo: "oe" });
  assert.deepEqual(parseGithubOwnerRepo("https://github.com/acme/oe"), { owner: "acme", repo: "oe" });
  assert.deepEqual(parseGithubOwnerRepo("git@github.com:acme/oe.git"), { owner: "acme", repo: "oe" });
  assert.equal(parseGithubOwnerRepo("https://gitlab.com/acme/oe.git"), undefined);
});

check("resolveGithubOwnerRepoFromEnv: reads GITHUB_REPOSITORY, rejects a missing or malformed value", () => {
  assert.deepEqual(resolveGithubOwnerRepoFromEnv({ GITHUB_REPOSITORY: "acme/oe" }), { owner: "acme", repo: "oe" });
  assert.equal(resolveGithubOwnerRepoFromEnv({}), undefined);
  assert.equal(resolveGithubOwnerRepoFromEnv({ GITHUB_REPOSITORY: "no-slash" }), undefined);
});

check("resolveGithubRestToken: GH_TOKEN wins over GITHUB_TOKEN; either alone works; neither is undefined", () => {
  assert.equal(resolveGithubRestToken({ GH_TOKEN: "a", GITHUB_TOKEN: "b" }), "a");
  assert.equal(resolveGithubRestToken({ GITHUB_TOKEN: "b" }), "b");
  assert.equal(resolveGithubRestToken({}), undefined);
});

check("decideCiGate: a 'skipped' heavy job, with nothing else considered, REFUSES on its own", () => {
  const decision = decideCiGate({
    sha: SHA,
    checkRuns: [GREEN[0], { name: HEAVY_JOB_NAME, status: "completed", conclusion: "skipped" }],
    isTip: true,
  });
  assert.equal(decision.verdict, "refuse");
});

const A1 = "a1".repeat(20);
const A2 = "b2".repeat(20);
const A3 = "c3".repeat(20);

check("classifyHeavyJob: success / skipped / red / pending / absent, read from the named check-run only", () => {
  assert.deepEqual(classifyHeavyJob([{ name: HEAVY_JOB_NAME, status: "completed", conclusion: "success" }]), { kind: "success" });
  assert.deepEqual(classifyHeavyJob([{ name: HEAVY_JOB_NAME, status: "completed", conclusion: "skipped" }]), { kind: "skipped" });
  assert.deepEqual(classifyHeavyJob([{ name: HEAVY_JOB_NAME, status: "completed", conclusion: "failure" }]), { kind: "red", conclusion: "failure" });
  assert.deepEqual(classifyHeavyJob([{ name: HEAVY_JOB_NAME, status: "in_progress", conclusion: null }]), { kind: "pending" });
  assert.deepEqual(classifyHeavyJob([GREEN[0]]), { kind: "absent" });
  assert.deepEqual(classifyHeavyJob([]), { kind: "absent" });
});

function routedExec(fixture: { ancestors?: string[]; checkRuns?: Record<string, CheckRun[]>; diffs?: Record<string, string[]> }, calls: string[]) {
  return async (command: string, args: string[]): Promise<ExecResult> => {
    calls.push(`${command} ${args.join(" ")}`);
    if (command === "gh") {
      const m = /commits\/([0-9a-fA-F]+)\/check-runs/.exec(args[1] ?? "");
      const sha = m?.[1];
      const runs = sha ? fixture.checkRuns?.[sha] : undefined;
      if (!runs) return { code: 1, stdout: "", stderr: `routedExec: no check-runs fixture for ${sha}` };
      return { code: 0, stdout: JSON.stringify({ check_runs: runs }), stderr: "" };
    }
    if (command === "git" && args[0] === "rev-list") {
      const shas = fixture.ancestors ?? [];
      return { code: 0, stdout: `${shas.join("\n")}\n`, stderr: "" };
    }
    if (command === "git" && args[0] === "diff") {
      const key = `${args[2]}..${args[3]}`;
      const paths = fixture.diffs?.[key];
      if (paths === undefined) return { code: 1, stdout: "", stderr: `routedExec: no diff fixture for ${key}` };
      return { code: 0, stdout: paths.length ? `${paths.join("\n")}\n` : "", stderr: "" };
    }
    return { code: 1, stdout: "", stderr: `routedExec: unhandled ${command} ${args.join(" ")}` };
  };
}

await check("walkBackForHeavyProof: PASSES when the nearest green ancestor's cumulative diff is entirely skippable", async () => {
  const calls: string[] = [];
  const exec = routedExec(
    {
      ancestors: [SHA, A1, A2],
      checkRuns: {
        [A1]: [{ name: HEAVY_JOB_NAME, status: "completed", conclusion: "skipped" }],
        [A2]: [{ name: HEAVY_JOB_NAME, status: "completed", conclusion: "success" }],
      },
      diffs: { [`${A2}..${SHA}`]: [".claude/skills/example/SKILL.md", "docs/deploy/rollback.md"] },
    },
    calls,
  );
  const decision = await walkBackForHeavyProof({ sha: SHA, exec });
  assert.equal(decision.verdict, "pass");
  assert.match(decision.message, new RegExp(A2.slice(0, 12)));
  assert.match(decision.message, /legitimately skipped/);
});

await check("walkBackForHeavyProof: REFUSES when the cumulative diff includes a runtime path — names it", async () => {
  const calls: string[] = [];
  const exec = routedExec(
    {
      ancestors: [SHA, A1, A2],
      checkRuns: {
        [A1]: [{ name: HEAVY_JOB_NAME, status: "completed", conclusion: "skipped" }],
        [A2]: [{ name: HEAVY_JOB_NAME, status: "completed", conclusion: "success" }],
      },
      diffs: { [`${A2}..${SHA}`]: [".claude/skills/example/SKILL.md", "agent/agent.ts"] },
    },
    calls,
  );
  const decision = await walkBackForHeavyProof({ sha: SHA, exec });
  assert.equal(decision.verdict, "refuse");
  assert.match(decision.message, /agent\/agent\.ts/);
});

await check("walkBackForHeavyProof: REFUSES immediately on a RED ancestor — never walks further back past it", async () => {
  const calls: string[] = [];
  const exec = routedExec(
    {
      ancestors: [SHA, A1, A2],
      checkRuns: {
        [A1]: [{ name: HEAVY_JOB_NAME, status: "completed", conclusion: "failure" }],
      },
      diffs: {},
    },
    calls,
  );
  const decision = await walkBackForHeavyProof({ sha: SHA, exec });
  assert.equal(decision.verdict, "refuse");
  assert.match(decision.message, /\bred\b/);
  assert.equal(
    calls.some((c) => c.includes(A2)),
    false,
    "must not have called gh/git for the ancestor past the red one",
  );
});

await check("walkBackForHeavyProof: REFUSES when no green run is found within maxDepth (ambiguous, not a pass)", async () => {
  const calls: string[] = [];
  const exec = routedExec(
    {
      ancestors: [SHA, A1, A2],
      checkRuns: {
        [A1]: [{ name: HEAVY_JOB_NAME, status: "completed", conclusion: "skipped" }],
        [A2]: [{ name: HEAVY_JOB_NAME, status: "completed", conclusion: "skipped" }],
      },
      diffs: {},
    },
    calls,
  );
  const decision = await walkBackForHeavyProof({ sha: SHA, exec, maxDepth: 2 });
  assert.equal(decision.verdict, "refuse");
  assert.match(decision.message, /within 2 ancestor commit\(s\)/);
});

await check("listFirstParentAncestors: parses rev-list output, sha itself first", async () => {
  const exec = async () => ({ code: 0, stdout: `${SHA}\n${A1}\n${A2}\n`, stderr: "" });
  const result = await listFirstParentAncestors({ sha: SHA, count: 3, exec });
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.shas, [SHA, A1, A2]);
});

await check("listFirstParentAncestors: a spawn failure refuses (same OPE-1028 discipline as gh)", async () => {
  const exec = async () => ({ code: 1, stdout: "", stderr: "", spawnError: "ENOENT: spawn git ENOENT" });
  const result = await listFirstParentAncestors({ sha: SHA, count: 3, exec });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /could not run `git rev-list`/);
});

await check("runCiGate: end to end, a 'skipped' heavy job covered by a proven ancestor PASSES", async () => {
  const calls: string[] = [];
  const exec = routedExec(
    {
      checkRuns: {
        [SHA]: [GREEN[0], { name: HEAVY_JOB_NAME, status: "completed", conclusion: "skipped" }],
        [A1]: [{ name: HEAVY_JOB_NAME, status: "completed", conclusion: "success" }],
      },
      ancestors: [SHA, A1],
      diffs: { [`${A1}..${SHA}`]: ["AGENTS.md"] },
    },
    calls,
  );
  const decision = await runCiGate({ sha: SHA, isTip: true, exec });
  assert.equal(decision.verdict, "pass");
});

await check("runCiGate: a genuinely RED heavy job never triggers the walk-back (no git/gh calls made for it)", async () => {
  const calls: string[] = [];
  const exec = routedExec(
    { checkRuns: { [SHA]: [GREEN[0], { name: HEAVY_JOB_NAME, status: "completed", conclusion: "failure" }] } },
    calls,
  );
  const decision = await runCiGate({ sha: SHA, isTip: true, exec });
  assert.equal(decision.verdict, "refuse");
  assert.match(decision.message, /red/);
  assert.equal(
    calls.filter((c) => c.startsWith("git ")).length,
    0,
    "a red heavy job must never trigger the walk-back's rev-list/diff calls",
  );
});

await check("runCiGate: a 'skipped' heavy job alongside a non-green unit run never triggers the walk-back", async () => {
  const calls: string[] = [];
  const exec = routedExec(
    {
      checkRuns: {
        [SHA]: [
          { name: GREEN[0].name, status: "in_progress", conclusion: null },
          { name: HEAVY_JOB_NAME, status: "completed", conclusion: "skipped" },
        ],
      },
    },
    calls,
  );
  const decision = await runCiGate({ sha: SHA, isTip: true, exec });
  assert.equal(decision.verdict, "refuse");
  assert.match(decision.message, /in flight/);
  assert.equal(
    calls.filter((c) => c.startsWith("git ")).length,
    0,
    "the unit job being non-green must block the walk-back before any git call is made",
  );
});

function routedExecWithCloudProof(
  fixture: { ancestors?: string[]; checkRuns?: Record<string, CheckRun[]>; statuses?: Record<string, CommitStatus[]>; diffs?: Record<string, string[]> },
  calls: string[],
) {
  return async (command: string, args: string[]): Promise<ExecResult> => {
    calls.push(`${command} ${args.join(" ")}`);
    if (command === "gh") {
      const path = args[1] ?? "";
      const statusMatch = /commits\/([0-9a-fA-F]+)\/status$/.exec(path);
      if (statusMatch) {
        const sha = statusMatch[1];
        const statuses = fixture.statuses?.[sha];
        if (statuses === undefined) return { code: 1, stdout: "", stderr: `routedExecWithCloudProof: no status fixture for ${sha}` };
        return { code: 0, stdout: JSON.stringify({ statuses }), stderr: "" };
      }
      const checkRunsMatch = /commits\/([0-9a-fA-F]+)\/check-runs/.exec(path);
      if (checkRunsMatch) {
        const sha = checkRunsMatch[1];
        const runs = fixture.checkRuns?.[sha];
        if (runs === undefined) return { code: 1, stdout: "", stderr: `routedExecWithCloudProof: no check-runs fixture for ${sha}` };
        return { code: 0, stdout: JSON.stringify({ check_runs: runs }), stderr: "" };
      }
      return { code: 1, stdout: "", stderr: `routedExecWithCloudProof: unhandled gh ${args.join(" ")}` };
    }
    if (command === "git" && args[0] === "rev-list") {
      const shas = fixture.ancestors ?? [];
      return { code: 0, stdout: `${shas.join("\n")}\n`, stderr: "" };
    }
    if (command === "git" && args[0] === "diff") {
      const key = `${args[2]}..${args[3]}`;
      const paths = fixture.diffs?.[key];
      if (paths === undefined) return { code: 1, stdout: "", stderr: `routedExecWithCloudProof: no diff fixture for ${key}` };
      return { code: 0, stdout: paths.length ? `${paths.join("\n")}\n` : "", stderr: "" };
    }
    return { code: 1, stdout: "", stderr: `routedExecWithCloudProof: unhandled ${command} ${args.join(" ")}` };
  };
}

check("classifyCloudProofStatus: success / pending / red / absent, read from the oe/cloud-proof context only", () => {
  assert.deepEqual(classifyCloudProofStatus([{ context: CLOUD_PROOF_CONTEXT, state: "success" }]), { kind: "success" });
  assert.deepEqual(classifyCloudProofStatus([{ context: CLOUD_PROOF_CONTEXT, state: "pending" }]), { kind: "pending" });
  assert.deepEqual(classifyCloudProofStatus([{ context: CLOUD_PROOF_CONTEXT, state: "failure" }]), { kind: "red", state: "failure" });
  assert.deepEqual(classifyCloudProofStatus([{ context: "some-other-context", state: "success" }]), { kind: "absent" });
  assert.deepEqual(classifyCloudProofStatus([]), { kind: "absent" });
});

check("fetchCombinedStatusForSha: a failed SPAWN refuses loudly, naming the spawn error", async () => {
  const spawnFailed: ExecResult = { code: 1, stdout: "", stderr: "", spawnError: "ENOENT: spawn gh ENOENT" };
  const result = await fetchCombinedStatusForSha({ sha: SHA, exec: async () => spawnFailed, fetchImpl: PANIC_FETCH, env: NO_TOKEN_ENV });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /could not run `gh`/);
});

check("fetchCombinedStatusForSha: parses a real combined-status response shape", async () => {
  const body = { state: "success", statuses: [{ context: CLOUD_PROOF_CONTEXT, state: "success" }, { context: "other-check", state: "pending" }] };
  const ok: ExecResult = { code: 0, stdout: JSON.stringify(body), stderr: "" };
  const result = await fetchCombinedStatusForSha({ sha: SHA, exec: async () => ok });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.statuses.length, 2);
});

await check("fetchCombinedStatusForSha: a response with no statuses array refuses rather than treating it as empty", async () => {
  const malformed: ExecResult = { code: 0, stdout: JSON.stringify({ message: "Not Found" }), stderr: "" };
  const result = await fetchCombinedStatusForSha({ sha: SHA, exec: async () => malformed });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /statuses/);
});

await check("decideCiGateViaCloudProof: PASSES when the tip's own oe/cloud-proof status is success", async () => {
  const body = { statuses: [{ context: CLOUD_PROOF_CONTEXT, state: "success" }] };
  const ok: ExecResult = { code: 0, stdout: JSON.stringify(body), stderr: "" };
  const decision = await decideCiGateViaCloudProof({ sha: SHA, isTip: true, exec: async () => ok });
  assert.equal(decision.verdict, "pass");
  assert.match(decision.message, /oe\/cloud-proof/);
});

await check("decideCiGateViaCloudProof: REFUSES when oe/cloud-proof is still pending", async () => {
  const body = { statuses: [{ context: CLOUD_PROOF_CONTEXT, state: "pending" }] };
  const ok: ExecResult = { code: 0, stdout: JSON.stringify(body), stderr: "" };
  const decision = await decideCiGateViaCloudProof({ sha: SHA, isTip: true, exec: async () => ok });
  assert.equal(decision.verdict, "refuse");
  assert.match(decision.message, /pending/);
});

await check("decideCiGateViaCloudProof: REFUSES when oe/cloud-proof is red — never treated as a pass", async () => {
  const body = { statuses: [{ context: CLOUD_PROOF_CONTEXT, state: "failure" }] };
  const ok: ExecResult = { code: 0, stdout: JSON.stringify(body), stderr: "" };
  const decision = await decideCiGateViaCloudProof({ sha: SHA, isTip: true, exec: async () => ok });
  assert.equal(decision.verdict, "refuse");
  assert.match(decision.message, /red/);
});

await check("walkBackForCloudProof: PASSES when the nearest green ancestor's cumulative diff is entirely skippable", async () => {
  const calls: string[] = [];
  const exec = routedExecWithCloudProof(
    {
      ancestors: [SHA, A1, A2],
      statuses: { [A1]: [], [A2]: [{ context: CLOUD_PROOF_CONTEXT, state: "success" }] },
      diffs: { [`${A2}..${SHA}`]: [".claude/skills/example/SKILL.md", "docs/deploy/rollback.md"] },
    },
    calls,
  );
  const decision = await walkBackForCloudProof({ sha: SHA, exec });
  assert.equal(decision.verdict, "pass");
  assert.match(decision.message, new RegExp(A2.slice(0, 12)));
});

await check("walkBackForCloudProof: REFUSES when the cumulative diff includes a runtime path — names it", async () => {
  const calls: string[] = [];
  const exec = routedExecWithCloudProof(
    {
      ancestors: [SHA, A1, A2],
      statuses: { [A1]: [], [A2]: [{ context: CLOUD_PROOF_CONTEXT, state: "success" }] },
      diffs: { [`${A2}..${SHA}`]: [".claude/skills/example/SKILL.md", "agent/agent.ts"] },
    },
    calls,
  );
  const decision = await walkBackForCloudProof({ sha: SHA, exec });
  assert.equal(decision.verdict, "refuse");
  assert.match(decision.message, /agent\/agent\.ts/);
});

await check("walkBackForCloudProof: REFUSES immediately on a RED ancestor — never walks further back past it", async () => {
  const calls: string[] = [];
  const exec = routedExecWithCloudProof(
    { ancestors: [SHA, A1, A2], statuses: { [A1]: [{ context: CLOUD_PROOF_CONTEXT, state: "failure" }] }, diffs: {} },
    calls,
  );
  const decision = await walkBackForCloudProof({ sha: SHA, exec });
  assert.equal(decision.verdict, "refuse");
  assert.match(decision.message, /\bred\b/);
  assert.equal(calls.some((c) => c.includes(A2)), false, "must not have called gh/git for the ancestor past the red one");
});

await check("walkBackForCloudProof: REFUSES when no green status is found within maxDepth (ambiguous, not a pass)", async () => {
  const calls: string[] = [];
  const exec = routedExecWithCloudProof({ ancestors: [SHA, A1, A2], statuses: { [A1]: [], [A2]: [] }, diffs: {} }, calls);
  const decision = await walkBackForCloudProof({ sha: SHA, exec, maxDepth: 2 });
  assert.equal(decision.verdict, "refuse");
  assert.match(decision.message, /within 2 ancestor commit\(s\)/);
});

await check("runCiGate: zero GitHub check-runs + a green oe/cloud-proof on the tip PASSES", async () => {
  const calls: string[] = [];
  const exec = routedExecWithCloudProof({ checkRuns: { [SHA]: [] }, statuses: { [SHA]: [{ context: CLOUD_PROOF_CONTEXT, state: "success" }] } }, calls);
  const decision = await runCiGate({ sha: SHA, isTip: true, exec });
  assert.equal(decision.verdict, "pass");
  assert.match(decision.message, /oe\/cloud-proof/);
});

await check("runCiGate: zero GitHub check-runs + no oe/cloud-proof anywhere REFUSES (fail closed, never a silent pass)", async () => {
  const calls: string[] = [];
  const exec = routedExecWithCloudProof(
    { checkRuns: { [SHA]: [] }, ancestors: [SHA, A1], statuses: { [SHA]: [], [A1]: [] }, diffs: {} },
    calls,
  );
  const decision = await runCiGate({ sha: SHA, isTip: true, exec });
  assert.equal(decision.verdict, "refuse");
});

await check("runCiGate: any GitHub check-run present at all means oe/cloud-proof is never even queried", async () => {
  const calls: string[] = [];
  const exec = async (command: string, args: string[]): Promise<ExecResult> => {
    calls.push(`${command} ${args.join(" ")}`);
    if (command === "gh" && (args[1] ?? "").includes("check-runs")) {
      return { code: 0, stdout: JSON.stringify({ check_runs: GREEN }), stderr: "" };
    }
    return { code: 1, stdout: "", stderr: "unhandled — must never be called" };
  };
  const decision = await runCiGate({ sha: SHA, isTip: true, exec });
  assert.equal(decision.verdict, "pass");
  assert.equal(
    calls.some((c) => c.includes("/status")),
    false,
    "oe/cloud-proof must never be queried when GitHub Actions already produced check-runs",
  );
});

console.log(`✓ deploy-ci-gate: ${checks} check(s) passed (classification, decision matrix, spawn-trap seam, fetch→decide, walk-back, oe/cloud-proof lane, REST fallback transport — all offline)`);
