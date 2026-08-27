import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { CLOUD_PROOF_CONTEXT } from "./deploy/cloud-proof-post-lib.js";
import type { Env, Exec, ExecResult } from "./deploy/lib.js";
import {
  classifyRequiredContexts,
  planFenceAttestation,
  planFenceLeg,
  readDefaultBranch,
  readRequiredContexts,
  refusalGuidance,
  resolveTree,
  runProofTransfer,
  UPGRADE_FENCE_CONTEXT,
} from "./deploy/merge-attest-lib.js";
import { type FenceSubject, type MergeFenceDecision, runMergeFence } from "./deploy/merge-fence-lib.js";
import { ruleFor } from "./upgrade-fence/judge.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

let checks = 0;
const pending: Promise<void>[] = [];
const check = (label: string, fn: () => void | Promise<void>): void => {
  checks++;
  const run = (async () => {
    try {
      await fn();
    } catch (err) {
      throw new Error(`${label}: ${err instanceof Error ? err.message : String(err)}`);
    }
  })();
  pending.push(run);
};

const HEAD = "1111111111111111111111111111111111111111";
const BASE = "2222222222222222222222222222222222222222";
const MERGE = "3333333333333333333333333333333333333333";
const TREE = "4444444444444444444444444444444444444444";
const OTHER_TREE = "5555555555555555555555555555555555555555";

const ENV: Env = { GH_TOKEN: "t0ken", GITHUB_REPOSITORY: "acme/open-everywhere" };

function subject(overrides: Partial<FenceSubject> = {}): FenceSubject {
  return { number: 421, headSha: HEAD, baseSha: BASE, baseRef: "main", authorLogin: "example-owner", authorType: "User", merged: false, ...overrides };
}

function decision(overrides: Partial<MergeFenceDecision> = {}): MergeFenceDecision {
  return { verdict: "clear", fence: "pass", message: "the base-ref fence passes", detail: "", subject: subject(), ...overrides };
}

function field(args: string[], key: string): string | undefined {
  for (let i = 0; i < args.length - 1; i++) if (args[i] === "-f" && args[i + 1].startsWith(`${key}=`)) return args[i + 1].slice(key.length + 1);
  return undefined;
}

check("a decision with NO subject posts nothing — the fence never read a pull request", () => {
  const plan = planFenceAttestation({ decision: { verdict: "refuse", fence: "unknown", message: "no GitHub credential", detail: "" } });
  assert.equal(plan.kind, "refuse");
  if (plan.kind === "refuse") assert.match(plan.reason, /no judged sha/);
});

check("the posted sha is the SUBJECT's head, so a different head moves the status", () => {
  const onHead = planFenceAttestation({ decision: decision() });
  assert.equal(onHead.kind, "post");
  if (onHead.kind === "post") assert.equal(onHead.sha, HEAD);

  const moved = "9999999999999999999999999999999999999999";
  const onMoved = planFenceAttestation({ decision: decision({ subject: subject({ headSha: moved }) }) });
  assert.equal(onMoved.kind, "post");
  if (onMoved.kind === "post") {
    assert.equal(onMoved.sha, moved);
    assert.notEqual(onMoved.sha, HEAD);
    assert.match(onMoved.invocation.args.join(" "), new RegExp(`statuses/${moved}`));
  }
});

check("an already-merged pull request is NOT attested — the merge already happened", () => {
  const plan = planFenceAttestation({ decision: decision({ subject: subject({ merged: true }) }) });
  assert.equal(plan.kind, "refuse");
  if (plan.kind === "refuse") assert.match(plan.reason, /ALREADY MERGED/);
});

check("a fence PASS posts success under oe/upgrade-fence, with the endpoint and fields GitHub needs", () => {
  const plan = planFenceAttestation({ decision: decision() });
  assert.equal(plan.kind, "post");
  if (plan.kind !== "post") return;
  assert.equal(plan.state, "success");
  assert.equal(plan.context, UPGRADE_FENCE_CONTEXT);
  assert.equal(plan.invocation.command, "gh");
  assert.ok(plan.invocation.args.includes(`repos/{owner}/{repo}/statuses/${HEAD}`), "the invocation must name the statuses endpoint for the judged sha");
  assert.ok(plan.invocation.args.includes("POST"), "a status is created with POST");
  assert.equal(field(plan.invocation.args, "state"), "success");
  assert.equal(field(plan.invocation.args, "context"), UPGRADE_FENCE_CONTEXT);
  assert.match(field(plan.invocation.args, "description") ?? "", /base 222222222222/);
});

check("a fence WARN is still success — a person-authored guardrail diff is annotated, never refused", () => {
  const plan = planFenceAttestation({ decision: decision({ fence: "warn" }) });
  assert.equal(plan.kind, "post");
  if (plan.kind !== "post") return;
  assert.equal(plan.state, "success");
  assert.match(plan.description, /warn/);
  assert.match(plan.note, /guardrail change/);
});

check("a fence REFUSAL posts failure — the status blocks the merge", () => {
  const plan = planFenceAttestation({ decision: decision({ verdict: "refuse", fence: "refuse", message: "protected path" }) });
  assert.equal(plan.kind, "post");
  if (plan.kind !== "post") return;
  assert.equal(plan.state, "failure");
  assert.match(plan.description, /REFUSED/);
});

check("a fence that could not RUN also posts failure, and says which of the two it was", () => {
  const plan = planFenceAttestation({ decision: decision({ verdict: "refuse", fence: "unknown", message: "the fence driver never ran" }) });
  assert.equal(plan.kind, "post");
  if (plan.kind !== "post") return;
  assert.equal(plan.state, "failure");
  assert.match(plan.description, /could not run/);
  assert.doesNotMatch(plan.description, /REFUSED/);
});

const CLEARED: Parameters<typeof planFenceLeg>[0] = { decision: decision(), defaultBranch: "main", protection: { kind: "required" }, requireProtection: true };

check("the happy path clears: default-branch base, rule required, fence passes", () => {
  const plan = planFenceLeg(CLEARED);
  assert.equal(plan.kind, "post");
  if (plan.kind === "post") assert.equal(plan.state, "success");
});

check("a base ref that is NOT the default branch refuses — the attester would run the proposal's own fence", () => {
  const plan = planFenceLeg({ ...CLEARED, decision: decision({ subject: subject({ baseRef: "claude/some-branch" }) }) });
  assert.equal(plan.kind, "refuse");
  if (plan.kind === "refuse") assert.match(plan.reason, /not the default branch/);
});

check("an unreadable default branch refuses — an unverified base is never attested", () => {
  const plan = planFenceLeg({ ...CLEARED, defaultBranch: undefined });
  assert.equal(plan.kind, "refuse");
  if (plan.kind === "refuse") assert.match(plan.reason, /could not read the repository's default branch/);
});

check("a repository whose default branch is not `main` still clears — the rule is not hardcoded", () => {
  const plan = planFenceLeg({ ...CLEARED, defaultBranch: "trunk", decision: decision({ subject: subject({ baseRef: "trunk" }) }) });
  assert.equal(plan.kind, "post");
});

check("--require-protection refuses when the rule does not name the context", () => {
  const plan = planFenceLeg({ ...CLEARED, protection: { kind: "not-required", contexts: ["oe/cloud-proof"] } });
  assert.equal(plan.kind, "refuse");
  if (plan.kind === "refuse") assert.match(plan.reason, /does not name this context/);
});

check("--require-protection refuses on an UNKNOWN rule — 'could not tell' is never a pass", () => {
  const plan = planFenceLeg({ ...CLEARED, protection: { kind: "unknown", reason: "HTTP 403" } });
  assert.equal(plan.kind, "refuse");
  if (plan.kind === "refuse") assert.match(plan.reason, /could not be confirmed/);
});

check("--require-protection refuses when the rule was never read at all", () => {
  const plan = planFenceLeg({ ...CLEARED, protection: undefined });
  assert.equal(plan.kind, "refuse");
  if (plan.kind === "refuse") assert.match(plan.reason, /was never read/);
});

check("WITHOUT --require-protection an unrequired rule still posts — the advisory case", () => {
  const plan = planFenceLeg({ ...CLEARED, requireProtection: false, protection: { kind: "not-required", contexts: [] } });
  assert.equal(plan.kind, "post");
  if (plan.kind === "post") assert.equal(plan.state, "success");
});

check("the base-ref rule is checked BEFORE the fence verdict is read", () => {
  const plan = planFenceLeg({
    ...CLEARED,
    decision: decision({ verdict: "refuse", fence: "refuse", message: "protected path", subject: subject({ baseRef: "claude/x" }) }),
  });
  assert.equal(plan.kind, "refuse");
  if (plan.kind === "refuse") assert.match(plan.reason, /not the default branch/);
});

check("a decision with no subject skips the base-ref rule and still posts nothing", () => {
  const plan = planFenceLeg({ ...CLEARED, decision: { verdict: "refuse", fence: "unknown", message: "no GitHub credential", detail: "" } });
  assert.equal(plan.kind, "refuse");
  if (plan.kind === "refuse") assert.match(plan.reason, /no judged sha/);
});

check("readDefaultBranch returns the branch GitHub names", async () => {
  const branch = await readDefaultBranch({ exec: async () => ({ code: 0, stdout: JSON.stringify({ default_branch: "trunk" }), stderr: "" }), env: ENV, fetchImpl: async () => ({ status: 500, text: async () => "" }) });
  assert.equal(branch, "trunk");
});

check("readDefaultBranch answers undefined on an unreadable or shapeless record", async () => {
  const failed = await readDefaultBranch({ exec: async () => ({ code: 1, stdout: "", stderr: "HTTP 404" }), env: ENV, fetchImpl: async () => ({ status: 404, text: async () => "" }) });
  assert.equal(failed, undefined);
  const shapeless = await readDefaultBranch({ exec: async () => ({ code: 0, stdout: JSON.stringify({ name: "open-everywhere" }), stderr: "" }), env: ENV, fetchImpl: async () => ({ status: 500, text: async () => "" }) });
  assert.equal(shapeless, undefined);
});

check("the rung attests the head GitHub reports, reached through the real runMergeFence", async () => {
  const record = {
    number: 421,
    title: "OPE-1182: merge attestation",
    body: "",
    merged: false,
    user: { login: "example-owner", type: "User" },
    head: { sha: HEAD },
    base: { sha: BASE, ref: "main" },
  };
  const exec: Exec = async (command, args) => {
    if (command === "gh" && args.join(" ").includes("pulls/421")) return { code: 0, stdout: JSON.stringify(record), stderr: "" };
    return { code: 1, stdout: "", stderr: "not here" };
  };
  const fenceDecision = await runMergeFence({ prNumber: 421, exec, env: ENV, fetchImpl: async () => ({ status: 500, text: async () => "" }) });
  assert.equal(fenceDecision.verdict, "refuse");
  assert.ok(fenceDecision.subject, "a refusal after the parse must carry the subject it parsed");
  assert.equal(fenceDecision.subject?.headSha, HEAD);

  const plan = planFenceAttestation({ decision: fenceDecision });
  assert.equal(plan.kind, "post");
  if (plan.kind === "post") {
    assert.equal(plan.sha, HEAD);
    assert.equal(plan.state, "failure");
  }
});

check("a non-default base ref is refused BEFORE the base's fence is extracted or run", async () => {
  const record = {
    number: 421,
    title: "stacked on another agent branch",
    body: "",
    merged: false,
    user: { login: "example-owner", type: "User" },
    head: { sha: HEAD },
    base: { sha: BASE, ref: "claude/some-other-branch" },
  };
  let extractionStarted = false;
  let spawned = false;
  const exec: Exec = async (command, args) => {
    if (command === "gh" && args.join(" ").includes("pulls/421")) return { code: 0, stdout: JSON.stringify(record), stderr: "" };
    if (command === "git" && ["cat-file", "ls-tree", "show", "fetch"].includes(args[0])) extractionStarted = true;
    return { code: 0, stdout: "", stderr: "" };
  };
  const decision = await runMergeFence({
    prNumber: 421,
    requiredBaseRef: "main",
    exec,
    env: ENV,
    fetchImpl: async () => ({ status: 500, text: async () => "" }),
    spawn: async () => {
      spawned = true;
      return { code: 0, stdout: "", stderr: "" };
    },
  });

  assert.equal(decision.verdict, "refuse");
  assert.equal(extractionStarted, false, "the base ref's fence must never be EXTRACTED for a base this run may not execute");
  assert.equal(spawned, false, "the base ref's fence must never be SPAWNED for a base this run may not execute");
  assert.match(decision.message, /may only execute the fence from `main`/);
  assert.equal(decision.subject?.headSha, HEAD);
  const plan = planFenceLeg({ decision, defaultBranch: "main", protection: { kind: "required" }, requireProtection: true });
  assert.equal(plan.kind, "refuse");
});

check("the DEFAULT base ref still runs the fence — the guard is not a blanket refusal", async () => {
  const record = { number: 421, title: "t", body: "", merged: false, user: { login: "example-owner", type: "User" }, head: { sha: HEAD }, base: { sha: BASE, ref: "main" } };
  let extractionStarted = false;
  const exec: Exec = async (command, args) => {
    if (command === "gh" && args.join(" ").includes("pulls/421")) return { code: 0, stdout: JSON.stringify(record), stderr: "" };
    if (command === "git" && ["cat-file", "ls-tree", "show", "fetch"].includes(args[0])) extractionStarted = true;
    return { code: 1, stdout: "", stderr: "stop here" };
  };
  await runMergeFence({ prNumber: 421, requiredBaseRef: "main", exec, env: ENV, fetchImpl: async () => ({ status: 500, text: async () => "" }) });
  assert.equal(extractionStarted, true, "a matching base ref must reach the extraction — otherwise the guard proves nothing");
});

check("with NO requiredBaseRef the in-sandbox rung is unchanged — it still extracts", async () => {
  const record = { number: 421, title: "t", body: "", merged: false, user: { login: "example-owner", type: "User" }, head: { sha: HEAD }, base: { sha: BASE, ref: "claude/anything" } };
  let extractionStarted = false;
  const exec: Exec = async (command, args) => {
    if (command === "gh" && args.join(" ").includes("pulls/421")) return { code: 0, stdout: JSON.stringify(record), stderr: "" };
    if (command === "git" && ["cat-file", "ls-tree", "show", "fetch"].includes(args[0])) extractionStarted = true;
    return { code: 1, stdout: "", stderr: "stop here" };
  };
  await runMergeFence({ prNumber: 421, exec, env: ENV, fetchImpl: async () => ({ status: 500, text: async () => "" }) });
  assert.equal(extractionStarted, true, "`deploy:merge-fence` runs with the author's own authority and must keep judging stacked pull requests");
});

check("a refusal reached BEFORE the parse carries no subject, so nothing is attested", async () => {
  const noCredential = await runMergeFence({ prNumber: 421, exec: async () => ({ code: 1, stdout: "", stderr: "" }), env: {}, fetchImpl: async () => ({ status: 500, text: async () => "" }) });
  assert.equal(noCredential.verdict, "refuse");
  assert.equal(noCredential.subject, undefined);
  assert.equal(planFenceAttestation({ decision: noCredential }).kind, "refuse");
});

check("a tree missing from this clone is fetched once, then read", async () => {
  const calls: string[][] = [];
  let haveIt = false;
  const exec: Exec = async (command, args) => {
    calls.push([command, ...args]);
    if (args[0] === "fetch") {
      haveIt = true;
      return { code: 0, stdout: "", stderr: "" };
    }
    return haveIt ? { code: 0, stdout: `${TREE}\n`, stderr: "" } : { code: 128, stdout: "", stderr: "unknown revision" };
  };
  const res = await resolveTree({ sha: MERGE, exec });
  assert.equal(res.ok, true);
  if (res.ok) assert.equal(res.tree, TREE);
  assert.ok(calls.some((c) => c[1] === "fetch"), "the shallow-clone fetch must actually be attempted");
});

check("a tree still absent after the fetch refuses — an unread tree is never a matching tree", async () => {
  const res = await resolveTree({ sha: MERGE, exec: async () => ({ code: 128, stdout: "", stderr: "unknown revision" }) });
  assert.equal(res.ok, false);
  if (!res.ok) assert.match(res.reason, /did not bring it in/);
});

check("a git that cannot be spawned refuses, never reads as an empty tree", async () => {
  const res = await resolveTree({ sha: MERGE, exec: async () => ({ code: 1, stdout: "", stderr: "", spawnError: "ENOENT: git" }) });
  assert.equal(res.ok, false);
  if (!res.ok) assert.match(res.reason, /could not run `git`/);
});

check("a value that is not a full sha never reaches `git` at all", async () => {
  let spawned = false;
  const res = await resolveTree({
    sha: "--upload-pack=touch /tmp/pwned",
    exec: async () => {
      spawned = true;
      return { code: 0, stdout: `${TREE}\n`, stderr: "" };
    },
  });
  assert.equal(res.ok, false);
  assert.equal(spawned, false, "the guard must refuse BEFORE any git spawn, not judge its output");
  if (!res.ok) assert.match(res.reason, /not a full 40-character commit sha/);
});

type TransferWorld = {
  pr?: Record<string, unknown>;
  headTree?: string;
  mergeTree?: string;
  headStatuses?: { context: string; state: string }[];
  mergeStatuses?: { context: string; state: string }[];
};

function transferExec(world: TransferWorld): Exec {
  return async (command, args) => {
    const joined = args.join(" ");
    if (command === "git" && args[0] === "rev-parse") {
      const tree = joined.includes(HEAD) ? world.headTree : joined.includes(MERGE) ? world.mergeTree : undefined;
      return tree ? { code: 0, stdout: `${tree}\n`, stderr: "" } : { code: 128, stdout: "", stderr: "unknown revision" };
    }
    if (command === "git" && args[0] === "fetch") return { code: 1, stdout: "", stderr: "no such object" };
    if (command === "gh" && joined.includes("pulls/421")) {
      return world.pr ? { code: 0, stdout: JSON.stringify(world.pr), stderr: "" } : { code: 1, stdout: "", stderr: "not found" };
    }
    if (command === "gh" && joined.includes("/status")) {
      const statuses = joined.includes(HEAD) ? world.headStatuses : joined.includes(MERGE) ? world.mergeStatuses : undefined;
      if (!statuses) return { code: 1, stdout: "", stderr: "not found" };
      return { code: 0, stdout: JSON.stringify({ total_count: statuses.length, statuses }), stderr: "" };
    }
    return { code: 1, stdout: "", stderr: `unstubbed: ${command} ${joined}` };
  };
}

const MERGED_PR = { number: 421, merged: true, merge_commit_sha: MERGE, user: { login: "example-owner", type: "User" }, head: { sha: HEAD }, base: { sha: BASE, ref: "main" } };
const GREEN = [{ context: CLOUD_PROOF_CONTEXT, state: "success" }];

async function transfer(world: TransferWorld, env: Env = ENV) {
  return runProofTransfer({ prNumber: 421, mergeSha: MERGE, exec: transferExec(world), env, fetchImpl: async () => ({ status: 500, text: async () => "" }) });
}

check("with identical trees and a green head, the proof moves onto the merge commit", async () => {
  const plan = await transfer({ pr: MERGED_PR, headTree: TREE, mergeTree: TREE, headStatuses: GREEN, mergeStatuses: [] });
  assert.equal(plan.kind, "post");
  if (plan.kind !== "post") return;
  assert.equal(plan.sha, MERGE);
  assert.equal(plan.context, CLOUD_PROOF_CONTEXT);
  assert.equal(plan.state, "success");
  assert.match(plan.description, /transferred from 111111111111/);
});

check("DIFFERENT trees refuse — that tip needs its own proof run", async () => {
  const plan = await transfer({ pr: MERGED_PR, headTree: TREE, mergeTree: OTHER_TREE, headStatuses: GREEN, mergeStatuses: [] });
  assert.equal(plan.kind, "refuse");
  if (plan.kind === "refuse") assert.match(plan.reason, /does not have the same tree/);
});

check("an unmerged pull request refuses — there is no merge commit yet", async () => {
  const plan = await transfer({ pr: { ...MERGED_PR, merged: false }, headTree: TREE, mergeTree: TREE, headStatuses: GREEN, mergeStatuses: [] });
  assert.equal(plan.kind, "refuse");
  if (plan.kind === "refuse") assert.match(plan.reason, /is not merged/);
});

check("a merged pull request with no merge_commit_sha refuses rather than guess", async () => {
  const plan = await transfer({ pr: { ...MERGED_PR, merge_commit_sha: null }, headTree: TREE, mergeTree: TREE, headStatuses: GREEN, mergeStatuses: [] });
  assert.equal(plan.kind, "refuse");
  if (plan.kind === "refuse") assert.match(plan.reason, /no `merge_commit_sha`/);
});

check("a --merge-sha that disagrees with GitHub's own merge commit refuses", async () => {
  const plan = await transfer({ pr: { ...MERGED_PR, merge_commit_sha: OTHER_TREE }, headTree: TREE, mergeTree: TREE, headStatuses: GREEN, mergeStatuses: [] });
  assert.equal(plan.kind, "refuse");
  if (plan.kind === "refuse") assert.match(plan.reason, /must match exactly/);
});

check("a head with no green cloud-proof has nothing to transfer", async () => {
  const absent = await transfer({ pr: MERGED_PR, headTree: TREE, mergeTree: TREE, headStatuses: [], mergeStatuses: [] });
  assert.equal(absent.kind, "refuse");
  if (absent.kind === "refuse") assert.match(absent.reason, /it is absent/);

  const red = await transfer({ pr: MERGED_PR, headTree: TREE, mergeTree: TREE, headStatuses: [{ context: CLOUD_PROOF_CONTEXT, state: "failure" }], mergeStatuses: [] });
  assert.equal(red.kind, "refuse");
  if (red.kind === "refuse") assert.match(red.reason, /is `failure`/);
});

check("a merge commit that already carries a RED cloud-proof is never painted over", async () => {
  const plan = await transfer({ pr: MERGED_PR, headTree: TREE, mergeTree: TREE, headStatuses: GREEN, mergeStatuses: [{ context: CLOUD_PROOF_CONTEXT, state: "failure" }] });
  assert.equal(plan.kind, "refuse");
  if (plan.kind === "refuse") assert.match(plan.reason, /refusing to overwrite/);
});

check("a pending cloud-proof on the merge commit is not overwritten either", async () => {
  const plan = await transfer({ pr: MERGED_PR, headTree: TREE, mergeTree: TREE, headStatuses: GREEN, mergeStatuses: [{ context: CLOUD_PROOF_CONTEXT, state: "pending" }] });
  assert.equal(plan.kind, "refuse");
  if (plan.kind === "refuse") assert.match(plan.reason, /refusing to overwrite/);
});

check("no credential refuses before any read", async () => {
  const plan = await transfer({ pr: MERGED_PR, headTree: TREE, mergeTree: TREE, headStatuses: GREEN, mergeStatuses: [] }, { GITHUB_REPOSITORY: "acme/open-everywhere" });
  assert.equal(plan.kind, "refuse");
  if (plan.kind === "refuse") assert.match(plan.reason, /no GitHub credential/);
});

check("an unreadable pull request refuses — a proof is never transferred untraced", async () => {
  const plan = await transfer({ headTree: TREE, mergeTree: TREE, headStatuses: GREEN, mergeStatuses: [] });
  assert.equal(plan.kind, "refuse");
  if (plan.kind === "refuse") assert.match(plan.reason, /could not read pull request/);
});

check("a refused --fence run says DO NOT MERGE — the act still ahead of it", () => {
  const line = refusalGuidance({ kind: "fence" });
  assert.match(line, /DO NOT MERGE\./, "the fence leg keeps the pre-merge instruction verbatim");
  assert.equal(/DO NOT DEPLOY/.test(line), false, "negative control: the fence leg must NOT talk about deploying — the merge has not happened");
});

check("a refused --transfer run does NOT say DO NOT MERGE — the merge already happened", () => {
  const line = refusalGuidance({ kind: "transfer", mergeSha: MERGE });
  assert.equal(/DO NOT MERGE/.test(line), false, "🔴 OPE-1207: the transfer leg judges a merged commit, so it may never tell the caller not to merge");
  assert.match(line, /DO NOT DEPLOY/, "the transfer leg names the act that IS still ahead — the deploy");
  assert.match(line, /already happened/i, "…and says why the merge instruction does not apply");
});

check("a refused --transfer run names the merge commit it refused on", () => {
  assert.match(refusalGuidance({ kind: "transfer", mergeSha: MERGE }), new RegExp(MERGE.slice(0, 12)), "the operator is told WHICH commit is unproven");
  assert.match(refusalGuidance({ kind: "transfer", mergeSha: MERGE }), new RegExp(CLOUD_PROOF_CONTEXT.replace("/", "\\/")), "…and which status it is missing");
  assert.match(
    refusalGuidance({ kind: "transfer" }),
    /named by --merge-sha/,
    "the defensive branch: with no sha to name the line still refuses, and points at the flag rather than printing 'undefined'",
  );
});

check("merge-attest.ts routes its refusal through refusalGuidance, not a literal of its own", () => {
  const cli = readFileSync(join(ROOT, "scripts", "deploy", "merge-attest.ts"), "utf8");
  assert.ok(cli.includes("refusalGuidance("), "the CLI must call the shared helper");
  assert.equal(
    cli.split("DO NOT MERGE.").length - 1,
    2,
    "🔴 exactly two DO NOT MERGE literals remain in the CLI, both on fence-only paths — a third means the shared refusal regrew one",
  );
});

check("a legacy `contexts` list naming the check reads as required", () => {
  assert.equal(classifyRequiredContexts({ contexts: ["oe/cloud-proof", UPGRADE_FENCE_CONTEXT] }, UPGRADE_FENCE_CONTEXT).kind, "required");
});

check("the newer `checks` shape naming the check also reads as required", () => {
  assert.equal(classifyRequiredContexts({ checks: [{ context: UPGRADE_FENCE_CONTEXT, app_id: 1 }] }, UPGRADE_FENCE_CONTEXT).kind, "required");
});

check("a rule that does not name the check reads as not-required, and lists what IS required", () => {
  const state = classifyRequiredContexts({ contexts: ["oe/cloud-proof"], checks: [] }, UPGRADE_FENCE_CONTEXT);
  assert.equal(state.kind, "not-required");
  if (state.kind === "not-required") assert.deepEqual(state.contexts, ["oe/cloud-proof"]);
});

check("a response carrying neither array is UNKNOWN, never not-required", () => {
  assert.equal(classifyRequiredContexts({ url: "https://api.github.com/..." }, UPGRADE_FENCE_CONTEXT).kind, "unknown");
  assert.equal(classifyRequiredContexts("nope", UPGRADE_FENCE_CONTEXT).kind, "unknown");
});

check("an unreadable protection endpoint is UNKNOWN — a 403 must never read as 'no rule'", async () => {
  const state = await readRequiredContexts({
    branch: "main",
    context: UPGRADE_FENCE_CONTEXT,
    exec: async () => ({ code: 1, stdout: "", stderr: "HTTP 403: Resource not accessible by integration" }),
    env: ENV,
    fetchImpl: async () => ({ status: 403, text: async () => "" }),
  });
  assert.equal(state.kind, "unknown");
  if (state.kind === "unknown") assert.match(state.reason, /cannot tell them apart/);
});

const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> };

check("package.json defines both the rung and its suite", () => {
  assert.match(pkg.scripts["deploy:merge-attest"] ?? "", /scripts\/deploy\/merge-attest\.ts/);
  assert.match(pkg.scripts["test:deploy-merge-attest"] ?? "", /scripts\/deploy-merge-attest-test\.ts/);
});

check("the root test chain runs this suite — drop the leg and nothing else notices", () => {
  assert.match(pkg.scripts["test:chain"] ?? "", /npm run test:deploy-merge-attest\b/);
});

check("the fence protects this suite by exact path — it sits at scripts/ root, outside scripts/deploy/", () => {
  const own = ruleFor("scripts/deploy-merge-attest-test.ts");
  assert.ok(own, "scripts/deploy-merge-attest-test.ts must be in the fence's protected set");
  const runner = ruleFor("scripts/deploy/merge-attest-lib.ts");
  assert.ok(runner, "the rung itself must be protected — it sits under scripts/deploy/");
});

check("merge-attest.ts reads the default branch BEFORE runMergeFence and hands it in — the CLI composition that stops the extraction, pinned in source", () => {
  const cli = readFileSync(join(ROOT, "scripts", "deploy", "merge-attest.ts"), "utf8");
  const readsAt = cli.indexOf("readDefaultBranch(");
  const fenceAt = cli.indexOf("runMergeFence(");
  assert.ok(readsAt >= 0, "merge-attest.ts must read the default branch");
  assert.ok(fenceAt >= 0, "merge-attest.ts must call runMergeFence");
  assert.ok(readsAt < fenceAt, "the default branch must be read BEFORE runMergeFence runs — the guard arrives too late otherwise");
  assert.match(cli, /requiredBaseRef:\s*defaultBranch/, "runMergeFence must be handed the default branch as requiredBaseRef");
});

check("the security page names the rung, so the doc and the code cannot drift apart", () => {
  const page = readFileSync(join(ROOT, "docs", "security", "self-upgrade-fence.md"), "utf8");
  assert.match(page, /deploy:merge-attest/);
  assert.match(page, new RegExp(UPGRADE_FENCE_CONTEXT.replace("/", "\\/")));
});

await Promise.all(pending);
console.log(`✓ deploy-merge-attest: ${checks} check(s) passed (attested-sha join, tree-identity transfer, protection read, wiring — all offline, nothing posted)`);
