import { defineTool } from "eve/tools";
import { windowGated } from "../access/window-gated.js";
import { z } from "zod";
import { bindFrom } from "../identity/binding.js";
import { resolvePartition } from "../memory/partition.js";
import { principalIdOf, resolveAccessFor } from "../access/request.js";
import { untrustedIngestedThisTurn } from "../access/taint-signal.js";
import { getGitHubApp, repoAllowed } from "../scm/provider.js";
import { isSafeBranchName, isSafeCheckoutDir, parseStagedSha, redactSecret, stagePushCommand } from "../scm/git.js";
import type { SandboxNetworkPolicy } from "eve/sandbox";
import { compileNetworkPolicy } from "../access/egress.js";
import { resolveHeaders } from "../access/credentials.js";
import { isEnforced } from "../access/enforcement.js";
import { mintGitReadBroker, mergeGitReadBroker, withBareAllowHost } from "../scm/broker.js";
import { useSelfHostEgress, pushEgressPolicy } from "../access/self-host-egress.js";
import { requestApproval, postedToSurfaceKey } from "../approvals/flow.js";
import { requireSessionContinuation } from "../spend/checkpoint.js";
import { approvalPostDeps, hasApprovalCardPath } from "./set_spend_limit.js";
import { executePrOpen, type PrOpenArgs } from "../approvals/pr-open.js";
import { getOperationalStore } from "../operational/provider.js";
import { proposingSessionId } from "../identity/binding.js";
import { markCardPostedThisTurn } from "../approvals/card-signal.js";
import { bridgeSlackForm } from "../channels/slack-bridge.js";
import { surfaceMessageOps } from "../channels/surface-message-ops.js";

async function resolvePrToken(repo: string): Promise<string> {
  const app = getGitHubApp();
  if (app) {
    const { tokens, ungranted } = await app.tokensForRepos([repo]);
    if (!ungranted.length) return tokens.get(repo.slice(0, repo.indexOf("/")))!.token;
  }
  const pat = process.env.GITHUB_TOKEN;
  if (!pat) {
    throw new Error("no GitHub credential: configure the GitHub App (OE_GITHUB_APP_*) or set GITHUB_TOKEN.");
  }
  return pat;
}

async function postSessionNote(platform: string, channelId: string, threadTs: string | null, text: string): Promise<void> {
  const ops = surfaceMessageOps(platform);
  if (ops) {
    await ops.postText(channelId, text).catch(() => {});
    return;
  }
  const body = new URLSearchParams();
  body.set("channel", channelId);
  if (threadTs) body.set("thread_ts", threadTs);
  body.set("text", text);
  await bridgeSlackForm("chat.postMessage", body.toString()).catch(() => {});
}

export default windowGated("open_pull_request", defineTool({
  description:
    "PROPOSE pushing your committed branch and opening a GitHub pull request for it (this is the ONLY way changes leave the workspace — plain `git push` is not authorized). Commit on the head branch in the checkout first. This does NOT open the PR: your commits are parked on a hidden staging ref and an approval card posts with the exact repo, branches, commit and description — the branch and PR publish only when a human in the channel approves. Write a clear body: what changed, why, how you verified it, and link the request that prompted it. If a PR is already open for that branch, approval updates it with your new commits instead. The posted card IS the reply — do not add narration after this call.",
  inputSchema: z.object({
    repo: z.string().describe("Target repository as 'owner/repo'."),
    head: z.string().describe("The branch containing the changes (must exist in the checkout)."),
    base: z.string().default("main").describe("The branch to merge into."),
    title: z.string().describe("PR title."),
    body: z.string().describe("PR description (markdown)."),
    dir: z.string().optional().describe("Workspace-relative checkout directory to push from (default: the repo name)."),
  }),
  outputSchema: z.object({
    ok: z.boolean(),
    repo: z.string(),
    head: z.string(),
    pending: z.boolean(),
    pendingId: z.string().optional(),
    message: z.string(),
  }),
  async execute(input, ctx) {
    await requireSessionContinuation(ctx, "open_pull_request");
    const access = resolveAccessFor(ctx);
    if (!repoAllowed(input.repo, access.repos)) {
      throw new Error(
        `repo "${input.repo}" is not granted to this channel. Allowed: ${access.repos.length ? access.repos.join(", ") : "(none)"}. ` +
          `Grant it via a bundle's repos (see agent/access/bundles.ts).`,
      );
    }

    if (!isSafeBranchName(input.head)) {
      throw new Error(`invalid head branch "${input.head}" — use a simple branch name (e.g. fix/issue-123).`);
    }
    const dir = input.dir ?? input.repo.split("/")[1];
    if (!isSafeCheckoutDir(dir)) {
      throw new Error(`invalid checkout dir "${dir}" — use a simple workspace-relative path.`);
    }

    const binding = bindFrom(ctx);
    if (!hasApprovalCardPath(binding.platform)) {
      throw new Error(
        `open_pull_request needs a surface with an approval-card path (Slack or Discord) — this is "${binding.platform}". A human must read and approve the PR before it publishes.`,
      );
    }
    const requestedBy = principalIdOf(ctx);
    if (!requestedBy) {
      throw new Error("open_pull_request needs a verified sender to gate the publish — no principal id resolved, so there's no proposer to show on the approval card.");
    }
    const channelId = typeof binding.target?.channelId === "string" ? binding.target.channelId : undefined;
    if (!channelId) {
      throw new Error("open_pull_request couldn't resolve this channel's id for the approval card — try again from a real channel.");
    }

    const token = await resolvePrToken(input.repo);

    let sandbox: Awaited<ReturnType<typeof ctx.getSandbox>>;
    try {
      sandbox = await ctx.getSandbox();
    } catch (err) {
      throw new Error(
        `no workspace to push from (${err instanceof Error ? err.message : String(err)}). ` +
          `checkout_repo the repo, commit on "${input.head}", then retry.`,
      );
    }
    const brokerApp = getGitHubApp();
    let brokered: SandboxNetworkPolicy | null = null;
    if (isEnforced() && brokerApp) {
      const basePolicy = await compileNetworkPolicy(access, resolveHeaders);
      const { rulesByOwner } = await mintGitReadBroker(brokerApp, access.repos);
      brokered = mergeGitReadBroker(basePolicy, rulesByOwner);
    }
    const applyPolicy = async (policy: SandboxNetworkPolicy): Promise<void> => {
      if (useSelfHostEgress()) await pushEgressPolicy(policy);
      else await sandbox.setNetworkPolicy(policy);
    };

    let push: Awaited<ReturnType<typeof sandbox.run>>;
    try {
      if (brokered) await applyPolicy(withBareAllowHost(brokered, "github.com"));
      push = await sandbox.run({ command: stagePushCommand(dir, token, input.head) });
    } finally {
      if (brokered) {
        try {
          await applyPolicy(brokered);
        } catch (restoreErr) {
          throw new Error(
            `open_pull_request: could not restore the git read-broker egress policy after the staging push — ` +
              `github.com is left on a bare allow (no firewall-injected credential) until the next SCM call re-arms it. ` +
              `This is a degraded firewall state that must be investigated: ${restoreErr instanceof Error ? restoreErr.message : String(restoreErr)}`,
          );
        }
      }
    }
    const headSha = push.exitCode === 0 ? parseStagedSha(push.stdout ?? "") : null;
    if (push.exitCode !== 0 || !headSha) {
      throw new Error(
        `staging push of "${input.head}" from ${dir}/ failed — is the repo checked out there (checkout_repo) with that branch committed? ` +
          redactSecret(push.stderr || push.stdout || "unknown error", token).slice(0, 500),
      );
    }

    const p = resolvePartition(ctx);
    const tainted = untrustedIngestedThisTurn();
    const sessionId = proposingSessionId(ctx);
    const args: PrOpenArgs = {
      org: p.org,
      scopeKey: p.surfaceKey,
      repo: input.repo,
      head: input.head,
      base: input.base,
      title: input.title,
      body: input.body,
      headSha,
      requestedBy,
      tainted,
      ...(sessionId ? { sessionId } : {}),
    };

    const store = getOperationalStore();
    const memo =
      sessionId && !tainted ? await store.getSessionApproval(p.org, sessionId, "pr.open", new Date().toISOString()).catch(() => null) : null;
    if (memo) {
      const outcome = await executePrOpen(args, memo.grantedBy, {}, { sessionApproved: true });
      await postSessionNote(binding.platform, channelId, binding.threadTs ?? null, `${outcome}\n-# session-approved by <@${memo.grantedBy}>`);
      markCardPostedThisTurn();
      return {
        ok: true,
        repo: input.repo,
        head: input.head,
        pending: false,
        message: `session-approved (by ${memo.grantedBy}) — published without a card: ${outcome}`,
      };
    }

    const posted = await requestApproval(
      {
        org: p.org,
        kind: "pr.open",
        args,
        scopeKey: p.surfaceKey,
        domain: null,
        requestedBy,
        channelId,
        threadTs: binding.threadTs ?? null,
        postedTo: postedToSurfaceKey(binding, channelId),
      },
      approvalPostDeps(binding.platform),
    );

    return {
      ok: true,
      repo: input.repo,
      head: input.head,
      pending: true,
      pendingId: posted.id,
      message: `card posted — PR "${input.title}" (${input.repo}: ${input.head} → ${input.base}, commit ${headSha.slice(0, 12)})${tainted ? " ⚠ tainted" : ""} awaiting a human to approve the publish (pending ${posted.id}).`,
    };
  },
}));
