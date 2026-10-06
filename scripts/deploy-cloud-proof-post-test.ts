import assert from "node:assert/strict";

import type { ExecResult } from "./deploy/lib.js";
import { buildPostDecision, CLOUD_PROOF_CONTEXT, DESCRIPTION_MAX_LENGTH, formatInvocation, pinInvocationToRepo, postCommitStatus } from "./deploy/cloud-proof-post-lib.js";
import { parseEvidence, type ProofVerdict } from "./deploy/cloud-proof-verify-lib.js";

let checks = 0;
const pending: Promise<void>[] = [];
const check = (label: string, fn: () => void | Promise<void>): void => {
  checks++;
  const result = fn();
  if (result) {
    pending.push(
      result.catch((err: unknown) => {
        throw new Error(`${label}: ${err instanceof Error ? err.message : String(err)}`);
      }),
    );
  }
};

const SHA = "abc1234";
const PASS: ProofVerdict = { verdict: "pass", sha: SHA, suites: [{ name: "test", exit: 0 }, { name: "build", exit: 0 }] };
const FAIL: ProofVerdict = { verdict: "fail", sha: SHA, suites: [{ name: "test", exit: 1 }], failing: ["test"] };
const UNPARSEABLE: ProofVerdict = { verdict: "unparseable", suites: [], reason: "no evidence lines found" };

check("buildPostDecision: an unparseable verdict is refused — never reaches gh", () => {
  const decision = buildPostDecision({ verdict: UNPARSEABLE, expectedSha: SHA, sessionId: "session_abc" });
  assert.equal(decision.kind, "refuse");
  if (decision.kind === "refuse") assert.match(decision.reason, /unparseable/);
});

check("buildPostDecision: a sha mismatch between the evidence and the caller's --sha is refused", () => {
  const decision = buildPostDecision({ verdict: PASS, expectedSha: "0000000", sessionId: "session_abc" });
  assert.equal(decision.kind, "refuse");
  if (decision.kind === "refuse") assert.match(decision.reason, /must match exactly/);
});

check("buildPostDecision: an empty session id is refused", () => {
  const decision = buildPostDecision({ verdict: PASS, expectedSha: SHA, sessionId: "   " });
  assert.equal(decision.kind, "refuse");
  if (decision.kind === "refuse") assert.match(decision.reason, /session id/);
});

check("buildPostDecision: a pass verdict builds a 'success' post with the right context", () => {
  const decision = buildPostDecision({ verdict: PASS, expectedSha: SHA, sessionId: "session_9f2c" });
  assert.equal(decision.kind, "post");
  if (decision.kind === "post") {
    assert.equal(decision.state, "success");
    assert.equal(decision.sha, SHA);
    assert.match(decision.description, /session_9f2c/);
    assert.ok(decision.invocation.args.includes(`context=${CLOUD_PROOF_CONTEXT}`));
    assert.ok(decision.invocation.args.some((a) => a === "state=success"));
    assert.ok(decision.invocation.args.some((a) => a === `repos/{owner}/{repo}/statuses/${SHA}`));
  }
});

check("buildPostDecision: a fail verdict builds a 'failure' post, never 'success'", () => {
  const decision = buildPostDecision({ verdict: FAIL, expectedSha: SHA, sessionId: "session_9f2c" });
  assert.equal(decision.kind, "post");
  if (decision.kind === "post") {
    assert.equal(decision.state, "failure");
    assert.ok(decision.invocation.args.some((a) => a === "state=failure"));
  }
});

check("buildPostDecision: an optional target-url is included only when given", () => {
  const withUrl = buildPostDecision({ verdict: PASS, expectedSha: SHA, sessionId: "s1", targetUrl: "https://example.test/run/1" });
  const withoutUrl = buildPostDecision({ verdict: PASS, expectedSha: SHA, sessionId: "s1" });
  assert.equal(withUrl.kind, "post");
  assert.equal(withoutUrl.kind, "post");
  if (withUrl.kind === "post") assert.ok(withUrl.invocation.args.some((a) => a === "target_url=https://example.test/run/1"));
  if (withoutUrl.kind === "post") assert.ok(!withoutUrl.invocation.args.some((a) => a.startsWith("target_url=")));
});

check("buildPostDecision: a very long suite summary truncates the description, never exceeds GitHub's 140-byte cap", () => {
  const bigVerdict: ProofVerdict = {
    verdict: "pass",
    sha: SHA,
    suites: Array.from({ length: 30 }, (_, i) => ({ name: `suite-with-a-fairly-long-name-${i}`, exit: 0 })),
  };
  const decision = buildPostDecision({ verdict: bigVerdict, expectedSha: SHA, sessionId: "session_9f2c" });
  assert.equal(decision.kind, "post");
  if (decision.kind === "post") assert.ok(decision.description.length <= 140);
});

const SHARDED_SESSION = "session_01EXAMPLE00000000000003";

const FOUR_TIERS_SHARDED: ProofVerdict = {
  verdict: "pass",
  sha: SHA,
  suites: [
    { name: "typecheck:all", exit: 0 },
    { name: "test", exit: 0 },
    { name: "build", exit: 0 },
    { name: "test:integration--shard=1/4", exit: 0 },
    { name: "test:integration--shard=2/4", exit: 0 },
    { name: "test:integration--shard=3/4", exit: 0 },
    { name: "test:integration--shard=4/4", exit: 0 },
  ],
};

check("buildPostDecision: a complete four-shard series renders as its tier, not as four shard names", () => {
  const decision = buildPostDecision({ verdict: FOUR_TIERS_SHARDED, expectedSha: SHA, sessionId: SHARDED_SESSION });
  assert.equal(decision.kind, "post");
  if (decision.kind === "post") {
    assert.ok(decision.description.includes("test:integration=0 (4 shards)"), decision.description);
    assert.ok(!decision.description.includes("--shard="), decision.description);
  }
});

check("buildPostDecision: four tiers with a sharded integration tier fit the 140-char cap UNTRUNCATED", () => {
  const decision = buildPostDecision({ verdict: FOUR_TIERS_SHARDED, expectedSha: SHA, sessionId: SHARDED_SESSION });
  assert.equal(decision.kind, "post");
  if (decision.kind === "post") {
    assert.ok(decision.description.length <= DESCRIPTION_MAX_LENGTH, `${decision.description.length} chars: ${decision.description}`);
    assert.ok(!decision.description.includes("…"), decision.description);
    for (const tier of ["typecheck:all=0", "test=0", "build=0", "test:integration=0"]) {
      assert.ok(decision.description.includes(tier), `${tier} missing from: ${decision.description}`);
    }
  }
});

check("buildPostDecision: an INCOMPLETE shard series keeps its literal shard names — it proves no tier", () => {
  const missingShard: ProofVerdict = {
    verdict: "pass",
    sha: SHA,
    suites: [
      { name: "test:integration--shard=1/4", exit: 0 },
      { name: "test:integration--shard=2/4", exit: 0 },
      { name: "test:integration--shard=4/4", exit: 0 },
    ],
  };
  const decision = buildPostDecision({ verdict: missingShard, expectedSha: SHA, sessionId: "session_9f2c" });
  assert.equal(decision.kind, "post");
  if (decision.kind === "post") {
    assert.ok(!decision.description.includes("test:integration=0 (3 shards)"), decision.description);
    assert.ok(decision.description.includes("test:integration--shard=1/4=0"), decision.description);
  }
});

check("buildPostDecision: 🔴 a PARTIAL green series parsed from evidence is never posted (OPE-2282)", () => {
  const text = [
    `OE_PROOF sha=${SHA} suite=typecheck:all exit=0`,
    `OE_PROOF sha=${SHA} suite=test exit=0`,
    `OE_PROOF sha=${SHA} suite=build exit=0`,
    `OE_PROOF sha=${SHA} suite=test:integration--shard=1/4 exit=0`,
    `OE_PROOF sha=${SHA} suite=test:integration--shard=2/4 exit=0`,
    `OE_PROOF sha=${SHA} suite=test:integration--shard=4/4 exit=0`,
  ].join("\n");
  const decision = buildPostDecision({ verdict: parseEvidence(text), expectedSha: SHA, sessionId: "session_9f2c" });
  assert.equal(decision.kind, "refuse");
  if (decision.kind === "refuse") assert.ok(/incomplete shard series/.test(decision.reason), decision.reason);
});

check("buildPostDecision: a RED shard posts 'failure' and keeps every literal shard name", () => {
  const redShard: ProofVerdict = {
    verdict: "fail",
    sha: SHA,
    suites: [
      { name: "test:integration--shard=1/4", exit: 0 },
      { name: "test:integration--shard=2/4", exit: 1 },
      { name: "test:integration--shard=3/4", exit: 0 },
      { name: "test:integration--shard=4/4", exit: 0 },
    ],
    failing: ["test:integration--shard=2/4"],
  };
  const decision = buildPostDecision({ verdict: redShard, expectedSha: SHA, sessionId: "session_9f2c" });
  assert.equal(decision.kind, "post");
  if (decision.kind === "post") {
    assert.equal(decision.state, "failure");
    assert.ok(decision.invocation.args.some((a) => a === "state=failure"));
    assert.ok(!decision.description.includes("(4 shards)"), decision.description);
    assert.ok(!/(^|[\s,])test:integration=/.test(decision.description), decision.description);
    assert.ok(decision.description.includes("test:integration--shard=1/4=0"), decision.description);
    assert.ok(decision.description.includes("test:integration--shard=2/4=1"), decision.description);
  }
});

check("formatInvocation: quotes an argument containing spaces", () => {
  const rendered = formatInvocation({ command: "gh", args: ["api", "state=success", "description=cloud-proof session s1: success"] });
  assert.match(rendered, /^gh api state=success 'description=cloud-proof session s1: success'$/);
});

check("formatInvocation: leaves a plain argument unquoted", () => {
  const rendered = formatInvocation({ command: "gh", args: ["api", `repos/{owner}/{repo}/statuses/${SHA}`] });
  assert.equal(rendered, `gh api repos/{owner}/{repo}/statuses/${SHA}`);
});

check("postCommitStatus: a failed SPAWN refuses loudly, naming the spawn error", async () => {
  const spawnFailed: ExecResult = { code: 1, stdout: "", stderr: "", spawnError: "ENOENT: spawn gh ENOENT" };
  const result = await postCommitStatus({ command: "gh", args: ["api", "x"] }, async () => spawnFailed);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /could not run `gh`/);
});

check("postCommitStatus: a non-zero gh exit refuses and surfaces stderr", async () => {
  const authFailed: ExecResult = { code: 4, stdout: "", stderr: "gh: not authenticated" };
  const result = await postCommitStatus({ command: "gh", args: ["api", "x"] }, async () => authFailed);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /not authenticated/);
});

check("postCommitStatus: a clean exit reports ok with the stdout detail", async () => {
  const ok: ExecResult = { code: 0, stdout: '{"id": 1}', stderr: "" };
  const result = await postCommitStatus({ command: "gh", args: ["api", "x"] }, async () => ok);
  assert.equal(result.ok, true);
  if (result.ok) assert.match(result.detail, /"id": 1/);
});

const STATUS_ARGS = ["api", `repos/{owner}/{repo}/statuses/${SHA}`, "--method", "POST", "-f", "state=success", "-f", "description=see {repo}"];

check("postCommitStatus: GITHUB_REPOSITORY set — the spawned `gh` names THAT repository, with no placeholder left", async () => {
  const seen: string[][] = [];
  const result = await postCommitStatus({ command: "gh", args: STATUS_ARGS }, async (_command, args) => {
    seen.push([...args]);
    return { code: 0, stdout: "{}", stderr: "" };
  }, { GITHUB_REPOSITORY: "open-everywhere/open-everywhere" });
  assert.equal(result.ok, true);
  assert.deepEqual(seen, [["api", `repos/open-everywhere/open-everywhere/statuses/${SHA}`, "--method", "POST", "-f", "state=success", "-f", "description=see {repo}"]]);
});

check("postCommitStatus: GITHUB_REPOSITORY UNSET — the spawned `gh` keeps the placeholder", async () => {
  const seen: string[][] = [];
  const result = await postCommitStatus({ command: "gh", args: STATUS_ARGS }, async (_command, args) => {
    seen.push([...args]);
    return { code: 0, stdout: "{}", stderr: "" };
  }, {});
  assert.equal(result.ok, true);
  assert.deepEqual(seen, [STATUS_ARGS]);
});

check("pinInvocationToRepo: the `--dry-run` rendering is the command a real run spawns", () => {
  const pinned = pinInvocationToRepo({ command: "gh", args: STATUS_ARGS }, { GITHUB_REPOSITORY: "acme/oe" });
  assert.equal(formatInvocation(pinned), `gh api repos/acme/oe/statuses/${SHA} --method POST -f state=success -f 'description=see {repo}'`);
  assert.deepEqual(STATUS_ARGS[1], `repos/{owner}/{repo}/statuses/${SHA}`, "the decision's invocation must not change");
});

await Promise.all(pending);

console.log(`✓ deploy-cloud-proof-post: ${checks} check(s) passed (fail-closed refusals, state mapping, dry-run rendering, spawn-trap seam — all offline, nothing posted)`);
