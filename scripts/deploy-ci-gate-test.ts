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
  fetchGithubApi,
  GITHUB_API_BASE,
  GITHUB_API_TIMEOUT_MS,
  HEAVY_JOB_NAME,
  listFirstParentAncestors,
  parseGithubOwnerRepo,
  realGithubApiFetch,
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
  assert.equal(calls[0].url, `${GITHUB_API_BASE}/repos/acme/oe/commits/${SHA}/status?per_page=100`);
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

const greenRuns = (n: number): Record<string, unknown>[] => Array.from({ length: n }, (_, i) => ({ name: `shard ${i}`, status: "completed", conclusion: "success" }));

const otherStatuses = (n: number): Record<string, unknown>[] => Array.from({ length: n }, (_, i) => ({ context: `other/check-${i}`, state: "success" }));

const execOk: ExecResult = { code: 0, stdout: "", stderr: "" };
const ghStdout = (body: unknown): ExecResult => ({ code: 0, stdout: JSON.stringify(body), stderr: "" });

await check("REST fallback: a network failure DURING the body read REFUSES with a named reason, never escapes as a raw throw", async () => {
  const midBodyFail: GithubApiFetchLike = async () => ({
    status: 200,
    text: async () => {
      throw new Error("socket hang up");
    },
  });
  const result = await fetchCheckRunsForSha({ sha: SHA, exec: NO_GH_EXEC, fetchImpl: midBodyFail, env: TOKEN_ENV });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.reason, /REST fallback GET/);
    assert.match(result.reason, /socket hang up/);
  }
  const decision = await runCiGate({ sha: SHA, isTip: true, exec: NO_GH_EXEC, fetchImpl: midBodyFail, env: TOKEN_ENV });
  assert.equal(decision.verdict, "refuse");
  assert.match(decision.message, /could not read CI state/);
});

await check("REST fallback: the same response shape with a readable body PASSES — negative control for the mid-body refusal", async () => {
  const okBody: GithubApiFetchLike = async () => ({ status: 200, text: async () => JSON.stringify({ total_count: 2, check_runs: GREEN }) });
  const decision = await runCiGate({ sha: SHA, isTip: true, exec: NO_GH_EXEC, fetchImpl: okBody, env: TOKEN_ENV });
  assert.equal(decision.verdict, "pass");
});

const TINY_TIMEOUT_MS = 25;
const BOUNDED_MS = 5_000;

async function withinBounds<T>(label: string, run: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}: nothing came back within ${BOUNDED_MS}ms — the deadline under test did not end the wait`)), BOUNDED_MS);
  });
  try {
    return await Promise.race([run(), guard]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

const restReadWithDeadline = (fetchImpl: GithubApiFetchLike) =>
  fetchGithubApi({
    ghArgs: ["api", `repos/{owner}/{repo}/commits/${SHA}/check-runs`, "--method", "GET"],
    restPathSuffix: `commits/${SHA}/check-runs`,
    exec: NO_GH_EXEC,
    fetchImpl,
    env: TOKEN_ENV,
    timeoutMs: TINY_TIMEOUT_MS,
  });

await check("REST fallback: a fetch that NEVER settles REFUSES on the deadline, in bounded time — it never hangs the gate", async () => {
  let handed: AbortSignal | undefined;
  const neverSettles: GithubApiFetchLike = (_url, init) => {
    handed = init.signal;
    return new Promise<never>(() => {});
  };

  const started = Date.now();
  const result = await withinBounds("a fetch that never settles", () => restReadWithDeadline(neverSettles));
  const elapsed = Date.now() - started;

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.reason, /REST fallback GET/);
    assert.match(result.reason, new RegExp(`timed out after ${TINY_TIMEOUT_MS}ms`));
    assert.match(result.reason, /refusing rather than waiting/);
  }
  assert.ok(elapsed < BOUNDED_MS, `the deadline must end the wait — it took ${elapsed}ms`);
  assert.ok(handed instanceof AbortSignal, "the fetch seam must be handed an AbortSignal");
  assert.equal(handed?.aborted, true);
});

await check("REST fallback: a BODY that never settles refuses on the same deadline — the bound covers the body read, not only the headers", async () => {
  const stalledBody: GithubApiFetchLike = async () => ({ status: 200, text: () => new Promise<string>(() => {}) });
  const started = Date.now();
  const result = await withinBounds("a body that never settles", () => restReadWithDeadline(stalledBody));
  const elapsed = Date.now() - started;
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /timed out after/);
  assert.ok(elapsed < BOUNDED_MS, `the deadline must cover the body read — it took ${elapsed}ms`);
});

await check("REST fallback: the same tiny deadline with a transport that ANSWERS parses normally — negative control for the timeout refusal", async () => {
  const answers: GithubApiFetchLike = async () => ({ status: 200, text: async () => JSON.stringify({ total_count: 2, check_runs: GREEN }) });
  const result = await restReadWithDeadline(answers);
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual((result.body as { check_runs: unknown }).check_runs, GREEN);
});

await check("the default deadline is a real, bounded number of milliseconds — no product caller opts out of it", () => {
  assert.equal(Number.isFinite(GITHUB_API_TIMEOUT_MS), true);
  assert.ok(GITHUB_API_TIMEOUT_MS > 0, "a non-positive default would refuse every read");
  assert.ok(GITHUB_API_TIMEOUT_MS <= 120_000, "a deadline the operator outwaits is not a deadline");
});

await check("realGithubApiFetch: the deadline's AbortSignal reaches the real `fetch` — a timed-out socket is CANCELLED, not abandoned", async () => {
  const originalFetch = globalThis.fetch;
  const seen: { signal?: AbortSignal | null }[] = [];
  const controller = new AbortController();
  try {
    globalThis.fetch = (async (_url: unknown, init: { signal?: AbortSignal | null }) => {
      seen.push({ signal: init?.signal });
      return { status: 200, text: async () => "{}" };
    }) as unknown as typeof globalThis.fetch;

    const res = await realGithubApiFetch(`${GITHUB_API_BASE}/repos/acme/oe`, {
      headers: { accept: "application/vnd.github+json" },
      signal: controller.signal,
    });
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "{}");
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(seen.length, 1);
  assert.equal(seen[0].signal, controller.signal, "the real transport must pass the deadline's signal through to `fetch`");
});

await check("REST fallback: HTTP 500 REFUSES, naming the status and the body", async () => {
  const fetchImpl = routedRestFetch({ "/check-runs": { status: 500, body: { message: "Server Error" } } }, []);
  const result = await fetchCheckRunsForSha({ sha: SHA, exec: NO_GH_EXEC, fetchImpl, env: TOKEN_ENV });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.reason, /HTTP 500/);
    assert.match(result.reason, /Server Error/);
  }
});

await check("REST fallback: the same body at HTTP 200 refuses for the missing array instead — negative control for the HTTP 500 branch", async () => {
  const fetchImpl = routedRestFetch({ "/check-runs": { status: 200, body: { message: "Server Error" } } }, []);
  const result = await fetchCheckRunsForSha({ sha: SHA, exec: NO_GH_EXEC, fetchImpl, env: TOKEN_ENV });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.reason, /no `check_runs` array/);
    assert.equal(/HTTP 500/.test(result.reason), false);
  }
});

await check("REST fallback: a non-JSON body (an HTML error page) REFUSES, naming it as not JSON", async () => {
  const nonJson: GithubApiFetchLike = async () => ({ status: 200, text: async () => "<html><body>502 Bad Gateway</body></html>" });
  const result = await fetchCheckRunsForSha({ sha: SHA, exec: NO_GH_EXEC, fetchImpl: nonJson, env: TOKEN_ENV });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.reason, /not JSON/);
    assert.match(result.reason, /502 Bad Gateway/);
  }
});

await check("REST fallback: an EMPTY check_runs array is never 'nothing to block on' — it routes to the cloud-proof lane, and a red proof there REFUSES", async () => {
  const fetchImpl = routedRestFetch(
    {
      "/check-runs": { status: 200, body: { total_count: 0, check_runs: [] } },
      "/status": { status: 200, body: { total_count: 1, statuses: [{ context: CLOUD_PROOF_CONTEXT, state: "failure" }] } },
    },
    [],
  );
  const decision = await runCiGate({ sha: SHA, isTip: true, exec: NO_GH_EXEC, fetchImpl, env: TOKEN_ENV });
  assert.equal(decision.verdict, "refuse");
  assert.match(decision.message, /\bred\b/);
});

await check("REST fallback: the same empty check_runs array with a GREEN oe/cloud-proof PASSES — negative control for the empty-array route", async () => {
  const fetchImpl = routedRestFetch(
    {
      "/check-runs": { status: 200, body: { total_count: 0, check_runs: [] } },
      "/status": { status: 200, body: { total_count: 1, statuses: [{ context: CLOUD_PROOF_CONTEXT, state: "success" }] } },
    },
    [],
  );
  const decision = await runCiGate({ sha: SHA, isTip: true, exec: NO_GH_EXEC, fetchImpl, env: TOKEN_ENV });
  assert.equal(decision.verdict, "pass");
});

await check("runCiGate: a check-runs page whose total_count EXCEEDS it REFUSES — the shape a stripped or ignored per_page produces", async () => {
  const fetchImpl = routedRestFetch({ "/check-runs": { status: 200, body: { total_count: 150, check_runs: greenRuns(30) } } }, []);
  const decision = await runCiGate({ sha: SHA, isTip: true, exec: NO_GH_EXEC, fetchImpl, env: TOKEN_ENV });
  assert.equal(decision.verdict, "refuse");
  assert.match(decision.message, /does not describe itself consistently/);
  assert.match(decision.message, /total_count=150/);
  assert.match(decision.message, /30 record/);
});

await check("runCiGate: a FULL check-runs page REFUSES even when total_count agrees — completeness rests on the page bound, not on total_count", async () => {
  const fetchImpl = routedRestFetch({ "/check-runs": { status: 200, body: { total_count: 100, check_runs: greenRuns(100) } } }, []);
  const decision = await runCiGate({ sha: SHA, isTip: true, exec: NO_GH_EXEC, fetchImpl, env: TOKEN_ENV });
  assert.equal(decision.verdict, "refuse");
  assert.match(decision.message, /fills a whole page/);
});

await check("runCiGate: a SHORT check-runs page with a matching total_count PASSES — negative control for both truncation branches", async () => {
  const fetchImpl = routedRestFetch({ "/check-runs": { status: 200, body: { total_count: 99, check_runs: greenRuns(99) } } }, []);
  const decision = await runCiGate({ sha: SHA, isTip: true, exec: NO_GH_EXEC, fetchImpl, env: TOKEN_ENV });
  assert.equal(decision.verdict, "pass");
});

await check("fetchCheckRunsForSha: a total_count BELOW the delivered length also REFUSES — a self-inconsistent response is never trusted", async () => {
  const result = await fetchCheckRunsForSha({ sha: SHA, exec: async () => ghStdout({ total_count: 2, check_runs: greenRuns(5) }), fetchImpl: PANIC_FETCH, env: NO_TOKEN_ENV });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.reason, /does not describe itself consistently/);
    assert.match(result.reason, /total_count=2/);
  }
});

await check("runCiGate: the truncation refusal is NOT REST-specific — the `gh` transport refuses the identical body", async () => {
  const decision = await runCiGate({
    sha: SHA,
    isTip: true,
    exec: async () => ghStdout({ total_count: 150, check_runs: greenRuns(30) }),
    fetchImpl: PANIC_FETCH,
    env: NO_TOKEN_ENV,
  });
  assert.equal(decision.verdict, "refuse");
  assert.match(decision.message, /does not describe itself consistently/);
});

await check("fetchCheckRunsForSha: a FULL page with no total_count REFUSES; a short page without one still parses", async () => {
  const full = await fetchCheckRunsForSha({ sha: SHA, exec: async () => ghStdout({ check_runs: greenRuns(100) }), fetchImpl: PANIC_FETCH, env: NO_TOKEN_ENV });
  assert.equal(full.ok, false);
  if (!full.ok) assert.match(full.reason, /fills a whole page/);
  const short = await fetchCheckRunsForSha({ sha: SHA, exec: async () => ghStdout({ check_runs: greenRuns(99) }), fetchImpl: PANIC_FETCH, env: NO_TOKEN_ENV });
  assert.equal(short.ok, true);
  if (short.ok) assert.equal(short.checkRuns.length, 99);
});

function recordingNoGhExec(calls: string[], revListCode = 128): Exec {
  return async (command, args) => {
    calls.push(`${command} ${args.join(" ")}`);
    if (command === "gh") return GH_ENOENT;
    if (command === "git" && args[0] === "rev-list") return { code: revListCode, stdout: "", stderr: "fatal: bad revision" };
    return execOk;
  };
}

await check(
  "runCiGate: a TRUNCATED combined-status page REFUSES and never enters the walk-back — an ancestor's green proof can no longer stand in for this sha's unread red",
  async () => {
    const calls: string[] = [];
    const fetchImpl = routedRestFetch(
      {
        "/check-runs": { status: 200, body: { total_count: 0, check_runs: [] } },
        "/status": { status: 200, body: { total_count: 45, statuses: otherStatuses(30) } },
      },
      [],
    );
    const decision = await runCiGate({ sha: SHA, isTip: true, exec: recordingNoGhExec(calls), fetchImpl, env: TOKEN_ENV });
    assert.equal(decision.verdict, "refuse");
    assert.match(decision.message, /does not describe itself consistently/);
    assert.match(decision.message, /total_count=45/);
    assert.equal(
      calls.some((c) => c.includes("rev-list")),
      false,
      "the walk-back must never run over a status page that could not be read completely",
    );
  },
);

await check("runCiGate: a COMPLETE status page with no oe/cloud-proof DOES enter the walk-back — negative control for the truncation refusal", async () => {
  const calls: string[] = [];
  const fetchImpl = routedRestFetch(
    {
      "/check-runs": { status: 200, body: { total_count: 0, check_runs: [] } },
      "/status": { status: 200, body: { total_count: 30, statuses: otherStatuses(30) } },
    },
    [],
  );
  const decision = await runCiGate({ sha: SHA, isTip: true, exec: recordingNoGhExec(calls), fetchImpl, env: TOKEN_ENV });
  assert.equal(decision.verdict, "refuse");
  assert.match(decision.message, /could not list ancestor commits/);
  assert.equal(/does not describe itself consistently/.test(decision.message), false);
  assert.equal(
    calls.some((c) => c.includes("rev-list")),
    true,
    "a complete status page with no oe/cloud-proof must still walk back, exactly as before",
  );
});

await check(
  "runCiGate: a FULL status page REFUSES even when total_count agrees — an ancestor's green proof can never stand in for a proof that merely paged off",
  async () => {
    const calls: string[] = [];
    const fetchImpl = routedRestFetch(
      {
        "/check-runs": { status: 200, body: { total_count: 0, check_runs: [] } },
        "/status": { status: 200, body: { total_count: 100, statuses: otherStatuses(100) } },
      },
      [],
    );
    const decision = await runCiGate({ sha: SHA, isTip: true, exec: recordingNoGhExec(calls), fetchImpl, env: TOKEN_ENV });
    assert.equal(decision.verdict, "refuse");
    assert.match(decision.message, /fills a whole page/);
    assert.equal(
      calls.some((c) => c.includes("rev-list")),
      false,
      "the walk-back must never run over a status page that fills the per_page bound",
    );
  },
);

await check("runCiGate: a SHORT status page with a matching total_count still reaches the walk-back — negative control for the status page bound", async () => {
  const calls: string[] = [];
  const fetchImpl = routedRestFetch(
    {
      "/check-runs": { status: 200, body: { total_count: 0, check_runs: [] } },
      "/status": { status: 200, body: { total_count: 99, statuses: otherStatuses(99) } },
    },
    [],
  );
  const decision = await runCiGate({ sha: SHA, isTip: true, exec: recordingNoGhExec(calls), fetchImpl, env: TOKEN_ENV });
  assert.equal(decision.verdict, "refuse");
  assert.match(decision.message, /could not list ancestor commits/);
  assert.equal(
    calls.some((c) => c.includes("rev-list")),
    true,
    "a provably complete status page with no oe/cloud-proof must still walk back",
  );
});

await check("walkBackForCloudProof: a truncated status page on an ANCESTOR refuses too — the walk never reads a partial page as 'keep going'", async () => {
  const fetchImpl = routedRestFetch({ "/status": { status: 200, body: { total_count: 45, statuses: otherStatuses(30) } } }, []);
  const exec: Exec = async (command, args) => {
    if (command === "gh") return GH_ENOENT;
    if (command === "git" && args[0] === "rev-list") return { code: 0, stdout: `${SHA}\n${A1}\n`, stderr: "" };
    return execOk;
  };
  const decision = await walkBackForCloudProof({ sha: SHA, exec, fetchImpl, env: TOKEN_ENV });
  assert.equal(decision.verdict, "refuse");
  assert.match(decision.message, /does not describe itself consistently/);
  assert.match(decision.message, new RegExp(A1.slice(0, 12)));
});

await check("the four refusal cases still name themselves — red / in flight / no run yet / transport failure never blur into one another", async () => {
  const restRefusal = async (checkRuns: unknown): Promise<string> => {
    const fetchImpl = routedRestFetch({ "/check-runs": { status: 200, body: checkRuns } }, []);
    const decision = await runCiGate({ sha: SHA, isTip: true, exec: NO_GH_EXEC, fetchImpl, env: TOKEN_ENV });
    assert.equal(decision.verdict, "refuse");
    return decision.message;
  };

  const cases = [
    { label: "red", own: /CI is red for/, message: await restRefusal({ total_count: 2, check_runs: [GREEN[0], { name: HEAVY_JOB_NAME, status: "completed", conclusion: "failure" }] }) },
    { label: "in flight", own: /still in flight/, message: await restRefusal({ total_count: 2, check_runs: [GREEN[0], { name: HEAVY_JOB_NAME, status: "in_progress", conclusion: null }] }) },
    { label: "no run yet", own: /no CI run found yet/, message: decideCiGate({ sha: SHA, checkRuns: [], isTip: true }).message },
    { label: "transport failure", own: /could not read CI state/, message: await restRefusal({ total_count: 150, check_runs: greenRuns(30) }) },
  ];

  for (const c of cases) {
    assert.match(c.message, c.own, `the ${c.label} refusal must name its own case`);
    for (const other of cases) {
      if (other.label === c.label) continue;
      assert.equal(other.own.test(c.message), false, `the ${c.label} refusal must not read as ${other.label}`);
    }
  }
});

console.log(`✓ deploy-ci-gate: ${checks} check(s) passed (classification, decision matrix, spawn-trap seam, fetch→decide, walk-back, oe/cloud-proof lane, REST fallback transport, fail-closed fetch edge — all offline)`);
