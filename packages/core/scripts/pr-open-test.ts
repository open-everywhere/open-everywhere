import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { readFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const dir = join(tmpdir(), `open-everywhere-pr-open-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");
delete process.env.OE_PRINCIPAL;

const { readAudit } = await import("../agent/audit/audit.js");
const { actionKind } = await import("../agent/approvals/actions.js");
const { executePrOpen } = await import("../agent/approvals/pr-open.js");
const { RateLimitExhaustedError } = await import("../agent/channels/rate-limit-retry.js");
const { default: openPullRequestGated } = await import("../agent/tools/open_pull_request.js");
const { overrideSettingsForTest } = await import("../agent/settings/settings.js");
const { resolveWindowGated } = await import("../agent/access/window-gated.js");
const openPullRequestTool = (await resolveWindowGated(openPullRequestGated, { channel: { kind: "slack" }, session: { auth: { current: { attributes: { oe_grain: "task" } } } } } as never)) as { execute(input: unknown, ctx: unknown): Promise<any> };
const { registerConfig } = await import("../agent/access/config.js");
const { defineBundle, defineBinding } = await import("../agent/access/bundle.js");
type PrOpenArgs = import("../agent/approvals/pr-open.js").PrOpenArgs;
type RepoCapability = import("../agent/access/repo-capabilities.js").RepoCapability;
type PrOpenExecuteDeps = import("../agent/approvals/pr-open.js").PrOpenExecuteDeps;
type BindableContext = import("../agent/identity/binding.js").BindableContext;
await import("../agent/approvals/flow.js");

registerConfig({
  loadBundles: () => [defineBundle({ name: "coding", repos: ["acme/web"] })],
  loadBindings: () => [defineBinding({ bundle: "coding", scope: { level: "org" } })],
  pluginRegistry: {},
  skillContent: {},
  loadDomains: () => [],
  loadSilos: () => [],
  domainsForSurface: () => [],
});
process.env.GITHUB_TOKEN = "test-pat";

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

function fakeDeps(opts: {
  currentSha?: string | null;
  prUpdated?: boolean;
  updateRefFails?: string;
  deleteRefFails?: boolean;
  deleteRefRateLimited?: boolean;
  createBranchExists?: boolean;
}) {
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
      if (opts.deleteRefRateLimited) throw new RateLimitExhaustedError({ surface: "github", operation: "git.refs.delete", attempts: 4, waitedMs: 3000 });
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
  ok(!lines.some((l) => l.includes("external content")), "no taint banner on a clean proposal");
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
  const lines = kind!.summarize(args());
  const token = lines.find((l) => l.startsWith("Token the approve click mints"));
  ok(token !== undefined, "a plain proposal's card carries the token line");
  ok(token!.includes("contents: write") && token!.includes("pull_requests: write") && token!.includes("metadata: read"), "the plain card names every family of the default write set with its grade");
  ok(!token!.includes("workflows"), "🔴 a plain repo's card never names `workflows` — it is not in the default write set");
  ok(token!.includes("declares no capability"), "the plain card says the repo declares no capability");
  ok(!lines.some((l) => l.startsWith("↳")), "a plain repo's card carries no capability detail line");
  ok(
    !lines.some((l) => l.includes("GITHUB_TOKEN") || l.includes("falls back")),
    "🔴 OPE-2530: an app-mode card names no token fallback — there is none any more",
  );
}
{
  overrideSettingsForTest({ github: { auth: "token" } });
  const lines = kind!.summarize(args({ capabilities: ["workflows"] }));
  overrideSettingsForTest({ github: { auth: "app" } });
  ok(!lines.some((l) => l.startsWith("Token the approve click mints") || l.startsWith("↳")), "🔴 a token-mode card names no App grade and no capability detail");
  ok(
    lines.some((l) => l.startsWith("Token the approve click uses") && l.includes("personal access token") && l.includes("owner's rights")),
    "🔴 a token-mode card says the click uses the personal access token, with its owner's rights",
  );
}
{
  const lines = kind!.summarize(args({ capabilities: ["workflows"] }));
  const token = lines.find((l) => l.startsWith("Token the approve click mints"));
  ok(token !== undefined && token!.includes("workflows: write"), "🔴 a workflows-declared repo's card NAMES the `workflows: write` grade the click mints");
  ok(token!.includes("contents: write") && token!.includes("pull_requests: write"), "the expansion ADDS to the default write set on the card, it never replaces it");
  ok(
    lines.some((l) => l.startsWith("↳") && l.includes("`workflows`") && l.includes(".github/workflows")),
    "the card says in plain words what the declared capability buys — from the capability table's own summary",
  );
}
{
  const lines = kind!.summarize(args({ capabilities: ["workflows", "pr-admin"] }));
  const token = lines.find((l) => l.startsWith("Token the approve click mints"));
  ok(token!.includes("workflows: write") && token!.includes("pull_requests: write"), "two declared capabilities both reach the grade line");
  ok(lines.filter((l) => l.startsWith("↳")).length === 2, "one detail line per declared capability");
}
{
  const lines = kind!.summarize(args({ capabilities: ["workflows", "gone-in-this-build"] as unknown as readonly RepoCapability[] }));
  const token = lines.find((l) => l.startsWith("Token the approve click mints"));
  ok(token !== undefined && token!.includes("workflows: write"), "an unimplemented frozen name never hides the grades this build DOES map");
  ok(
    lines.some((l) => l.includes("gone-in-this-build") && l.includes("publish fails")),
    "an unimplemented frozen capability name is named on the card, with the publish failure it causes",
  );
}
{
  const lines = kind!.summarize(args({ capabilities: { workflows: true } as unknown as readonly RepoCapability[] }));
  ok(lines.some((l) => l.startsWith("Token the approve click mints")), "a non-list frozen capabilities value still renders the card");
  ok(lines.some((l) => l.includes("is not a list") && l.includes("publish fails")), "a non-list frozen capabilities value is named on the card, with the publish failure it causes");
  ok(!lines.some((l) => l.includes("workflows: write")), "🔴 a non-list value grades NOTHING — the card falls back to the default write set, never to a guessed expansion");
}
{
  const lines = kind!.summarize(args({ capabilities: ["workflows"] }));
  assert.deepEqual(lines, [
    "Open pull request — `acme/web`: `fix/issue-9` → `main` (commit `aaaaaaaaaaaa`)",
    "Token the approve click mints — contents: write, metadata: read, pull_requests: write, workflows: write.",
    "↳ this repo declares `workflows` — push branches that add or change GitHub Actions workflow files under .github/workflows",
    "*Fix the widget*",
    "```",
    "What changed and why.",
    "```",
  ]);
  n++;
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
  const { deps } = fakeDeps({ currentSha: null });
  await executePrOpen(args(), "U_GRANTER", deps, { sessionApproved: true });
  const audit = await readAudit({ org: "default", limit: 3 });
  const entry = audit.find((a) => a.action === "pr.open" && (a.detail as Record<string, unknown>).sessionApproved === true);
  ok(entry !== undefined && entry!.principalId === "U_GRANTER", "a session-approved publish stamps sessionApproved:true, attributed to the memo-granting member");
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
  const warnings: unknown[][] = [];
  const realWarn = console.warn;
  console.warn = (...args: unknown[]) => void warnings.push(args);
  try {
    const { deps } = fakeDeps({ currentSha: null, deleteRefRateLimited: true });
    const outcome = await executePrOpen(args(), "U_APPROVER", deps);
    ok(outcome.includes("opened PR #7"), "🔴 a rate-limited staging-ref cleanup ALSO never fails the publish");
    ok(
      warnings.some((w) => typeof w[0] === "string" && w[0].includes("git.refs.delete") && w[0].includes("4 attempts")),
      "🔴 …but the exhaustion is LOGGED by name before the swallow — never a silent drop",
    );
  } finally {
    console.warn = realWarn;
  }
}

{
  let sandboxCalls = 0;
  const spySandbox = {
    async getSandbox() {
      sandboxCalls++;
      throw new Error("SANDBOX_REACHED — a gate that should have thrown did not");
    },
  };
  const ctx = (platform: string, attrs: Record<string, unknown>, principalId?: string): BindableContext =>
    ({
      channel: { kind: platform },
      session: { auth: { current: { attributes: { ...attrs, oe_grain: "task" }, ...(principalId ? { principalId, principalType: `${platform}-user` } : {}) } } },
      ...spySandbox,
    }) as unknown as BindableContext;

  const slackAttrs = { team_id: "T1", channel_id: "C1", channel_type: "channel" };
  const goodInput = { repo: "acme/web", head: "fix/issue-9", base: "main", title: "t", body: "b" };

  async function refuses(label: string, c: BindableContext, input: Record<string, unknown>, needle: RegExp): Promise<void> {
    const before = sandboxCalls;
    await assert.rejects(async () => {
      await openPullRequestTool.execute(input as never, c as never);
    }, needle, label);
    ok(sandboxCalls === before, `${label} — refused BEFORE the sandbox (no stage-push, no card)`);
  }

  await refuses(
    "ungranted repo",
    ctx("slack", slackAttrs, "U1"),
    { ...goodInput, repo: "evil/repo" },
    /not granted to this channel/,
  );
  await refuses(
    "unsafe head branch (refspec smuggling)",
    ctx("slack", slackAttrs, "U1"),
    { ...goodInput, head: "a:b" },
    /invalid head branch/,
  );
  await refuses(
    "unsafe checkout dir (traversal)",
    ctx("slack", slackAttrs, "U1"),
    { ...goodInput, dir: "../etc" },
    /invalid checkout dir/,
  );
  await refuses(
    "no approval-card path (teams surface)",
    ctx("teams", { conversation_id: "19:abc", channel_id: "C1" }, "U1"),
    goodInput,
    /approval-card path/,
  );
  await refuses(
    "no verified sender (no principal / no user_id)",
    ctx("slack", slackAttrs),
    goodInput,
    /verified sender/,
  );
  await refuses(
    "no resolvable channel id (no channel_id attr → target undefined) — subsumed into the venue walk",
    ctx("slack", { team_id: "T1", channel_type: "channel" }, "U1"),
    goodInput,
    /approval-card path/,
  );

  ok(sandboxCalls === 0, "across ALL fail-closed cases the sandbox was never reached (nothing staged, no card posted)");
}

{
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../agent/tools/open_pull_request.ts"), "utf8");
  ok(!/^\s*approval:(?!\s*never\()/m.test(src), "open_pull_request rides NO eve HITL (no non-never approval:)");
  ok(src.includes('kind: "pr.open"') && /\brequestApproval\s*\(/.test(src), "open_pull_request proposes via requestApproval(pr.open)");
  ok(src.includes("stagePushCommand"), "the propose half stage-pushes (hidden ref) rather than publishing");
  ok(src.includes("checkApprovalVenue"), "fail-closed off surfaces with no approval-card path AND no in-domain redirect, via the venue walk");
}

console.log(`✓ ${n} pr-open assertions passed`);
