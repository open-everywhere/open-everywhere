import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { readFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const dir = join(tmpdir(), `open-everywhere-pr-open-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");

const { readAudit } = await import("../agent/audit/audit.js");
const { actionKind } = await import("../agent/approvals/actions.js");
const { executePrOpen } = await import("../agent/approvals/pr-open.js");
type PrOpenArgs = import("../agent/approvals/pr-open.js").PrOpenArgs;
type PrOpenExecuteDeps = import("../agent/approvals/pr-open.js").PrOpenExecuteDeps;
await import("../agent/approvals/flow.js");

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

const SHA = "a".repeat(40);

function args(over: Partial<PrOpenArgs> = {}): PrOpenArgs {
  return {
    org: "default",
    scopeKey: "slack/T1/C1",
    repo: "acme/web",
    head: "fix/issue-9",
    base: "main",
    title: "Fix the widget",
    body: "What changed and why.",
    headSha: SHA,
    requestedBy: "U_PROPOSER",
    ...over,
  };
}

function fakeDeps(opts: { currentSha?: string | null; prUpdated?: boolean; updateRefFails?: string; deleteRefFails?: boolean; createBranchExists?: boolean }) {
  const calls: string[] = [];
  const deps: PrOpenExecuteDeps = {
    resolveToken: async () => "tok",
    getBranchSha: async ({ branch }) => {
      calls.push(`getBranchSha:${branch}`);
      return opts.currentSha === undefined ? null : opts.currentSha;
    },
    createBranch: async ({ branch, sha }) => {
      calls.push(`createBranch:${branch}@${sha.slice(0, 6)}`);
      return opts.createBranchExists ? "exists" : "created";
    },
    updateRef: async ({ ref, sha, force }) => {
      calls.push(`updateRef:${ref}@${sha.slice(0, 6)}:force=${force === true}`);
      if (opts.updateRefFails) throw new Error(opts.updateRefFails);
    },
    deleteRef: async ({ ref }) => {
      calls.push(`deleteRef:${ref}`);
      if (opts.deleteRefFails) throw new Error("cleanup boom");
      return "deleted";
    },
    createPr: async ({ repo, head, base, title }) => {
      calls.push(`createPr:${repo}:${head}->${base}:${title}`);
      return { url: "https://github.com/acme/web/pull/7", number: 7, updated: opts.prUpdated === true };
    },
  };
  return { deps, calls };
}

const kind = actionKind("pr.open");
ok(kind !== undefined, "pr.open is registered (flow.ts side-effect import)");
ok(kind!.policy === "member", "pr.open is MEMBER policy — the card is the injection gate, same tier as skill.create");

{
  const lines = kind!.summarize(args());
  ok(lines[0].includes("`acme/web`") && lines[0].includes("`fix/issue-9`") && lines[0].includes("`main`"), "card names repo, head and base");
  ok(lines[0].includes(SHA.slice(0, 12)), "card pins the exact staged commit sha — the click publishes THESE commits or fails");
  ok(!lines.some((l) => l.includes("⚠")), "no taint banner on a clean proposal");
  ok(lines.some((l) => l.includes("Fix the widget")), "card carries the frozen title");
}
{
  const lines = kind!.summarize(args({ tainted: true }));
  ok(lines.some((l) => l.includes("⚠") && l.includes("external content")), "tainted proposal gets the reviewer-scrutiny banner");
}
{
  const long = "x".repeat(2000);
  const lines = kind!.summarize(args({ body: long }));
  ok(lines.some((l) => l.includes("more bytes")), "an oversize body is capped on the card with a truncation note");
}

{
  const { deps, calls } = fakeDeps({ currentSha: null });
  const outcome = await executePrOpen(args(), "U_APPROVER", deps);
  ok(outcome.includes("opened PR #7") && outcome.includes("pull/7"), `create path reports the PR (${outcome})`);
  ok(calls.includes(`createBranch:fix/issue-9@${SHA.slice(0, 6)}`), "publishes refs/heads at the FROZEN sha");
  ok(!calls.some((c) => c.startsWith("updateRef:")), "no ref update needed on the create path");
  ok(calls.some((c) => c.startsWith("createPr:acme/web:fix/issue-9->main")), "opens the PR from the frozen args");
  ok(calls.includes("deleteRef:oe-pending/fix/issue-9"), "staging ref cleaned up after publish");
  const audit = await readAudit({ org: "default", limit: 3 });
  const entry = audit.find((a) => a.action === "pr.open");
  ok(entry !== undefined, "audits pr.open (same action name as the pre-plane tool)");
  const detail = entry!.detail as Record<string, unknown>;
  ok(detail.sha === SHA && detail.requestedBy === "U_PROPOSER" && entry!.principalId === "U_APPROVER", "audit carries the frozen sha, the proposer AND the approver");
}

{
  const { deps, calls } = fakeDeps({ currentSha: "b".repeat(40), prUpdated: true });
  const outcome = await executePrOpen(args(), "U_APPROVER", deps);
  ok(calls.includes(`updateRef:heads/fix/issue-9@${SHA.slice(0, 6)}:force=false`), "existing branch fast-forwards to the frozen sha — force is NEVER set");
  ok(!calls.some((c) => c.startsWith("createBranch:")), "no create on the update path");
  ok(outcome.includes("already open") && outcome.includes("updated"), "422-already-exists reads as a PR update");
  const audit = await readAudit({ org: "default", limit: 3 });
  ok(audit.some((a) => a.action === "pr.update"), "the follow-up push audits pr.update");
}

{
  const { deps, calls } = fakeDeps({ currentSha: SHA });
  await executePrOpen(args(), "U_APPROVER", deps);
  ok(!calls.some((c) => c.startsWith("createBranch:") || c.startsWith("updateRef:")), "branch already at the frozen sha — no ref write at all");
}

{
  const { deps, calls } = fakeDeps({ currentSha: null, createBranchExists: true });
  await executePrOpen(args(), "U_APPROVER", deps);
  ok(calls.some((c) => c.startsWith("updateRef:heads/fix/issue-9")), "a create-race resolves by updating the ref to the frozen sha");
}

{
  const { deps } = fakeDeps({ currentSha: "b".repeat(40), updateRefFails: "422 not a fast forward" });
  await assert.rejects(() => executePrOpen(args(), "U_APPROVER", deps), /not a fast forward/, "non-FF publish surfaces as the execute error (card shows FAILED)");
  n++;
}

{
  const { deps } = fakeDeps({ currentSha: null, deleteRefFails: true });
  const outcome = await executePrOpen(args(), "U_APPROVER", deps);
  ok(outcome.includes("opened PR #7"), "a failed staging-ref cleanup never fails the publish (best-effort by contract)");
}

{
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../agent/tools/open_pull_request.ts"), "utf8");
  ok(/approval:\s*never\(\)/.test(src), "open_pull_request no longer rides eve HITL (approval: never())");
  ok(src.includes('kind: "pr.open"') && /\brequestApproval\s*\(/.test(src), "open_pull_request proposes via requestApproval(pr.open)");
  ok(src.includes("stagePushCommand"), "the propose half stage-pushes (hidden ref) rather than publishing");
  ok(src.includes("hasApprovalCardPath"), "fail-closed off surfaces with no approval-card path");
}

console.log(`✓ ${n} pr-open assertions passed`);
