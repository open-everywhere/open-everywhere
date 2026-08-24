import assert from "node:assert/strict";

import type { ExecResult } from "./deploy/lib.js";
import { buildPostDecision, CLOUD_PROOF_CONTEXT, formatInvocation, postCloudProofStatus } from "./deploy/cloud-proof-post-lib.js";
import type { ProofVerdict } from "./deploy/cloud-proof-verify-lib.js";

let checks = 0;
const check = (label: string, fn: () => void): void => {
  checks++;
  fn();
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

check("formatInvocation: quotes an argument containing spaces", () => {
  const rendered = formatInvocation({ command: "gh", args: ["api", "state=success", "description=cloud-proof session s1: success"] });
  assert.match(rendered, /^gh api state=success 'description=cloud-proof session s1: success'$/);
});

check("formatInvocation: leaves a plain argument unquoted", () => {
  const rendered = formatInvocation({ command: "gh", args: ["api", `repos/{owner}/{repo}/statuses/${SHA}`] });
  assert.equal(rendered, `gh api repos/{owner}/{repo}/statuses/${SHA}`);
});

check("postCloudProofStatus: a failed SPAWN refuses loudly, naming the spawn error", async () => {
  const spawnFailed: ExecResult = { code: 1, stdout: "", stderr: "", spawnError: "ENOENT: spawn gh ENOENT" };
  const result = await postCloudProofStatus({ command: "gh", args: ["api", "x"] }, async () => spawnFailed);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /could not run `gh`/);
});

check("postCloudProofStatus: a non-zero gh exit refuses and surfaces stderr", async () => {
  const authFailed: ExecResult = { code: 4, stdout: "", stderr: "gh: not authenticated" };
  const result = await postCloudProofStatus({ command: "gh", args: ["api", "x"] }, async () => authFailed);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /not authenticated/);
});

check("postCloudProofStatus: a clean exit reports ok with the stdout detail", async () => {
  const ok: ExecResult = { code: 0, stdout: '{"id": 1}', stderr: "" };
  const result = await postCloudProofStatus({ command: "gh", args: ["api", "x"] }, async () => ok);
  assert.equal(result.ok, true);
  if (result.ok) assert.match(result.detail, /"id": 1/);
});

console.log(`✓ deploy-cloud-proof-post: ${checks} check(s) passed (fail-closed refusals, state mapping, dry-run rendering, spawn-trap seam — all offline, nothing posted)`);
