import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";
import { auditToolAction } from "../audit/tool-action.js";
import { resolveAccessFor } from "../access/request.js";
import { getGitHubApp, repoAllowed } from "../scm/provider.js";
import { isSafeBranchName, isSafeCheckoutDir, pushCommand, redactSecret } from "../scm/git.js";
import { createOrUpdatePullRequest } from "../scm/pr.js";

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
export default defineTool({
  description:
    "Push your committed branch and open a GitHub pull request for it (this is the ONLY way changes leave the workspace — plain `git push` is not authorized). Commit on the head branch in the checkout first; this tool pushes it for you after approval. Write a clear body: what changed, why, how you verified it, and link the request that prompted it; open it as a draft if the repo's checks aren't passing. If a PR is already open for that branch, this updates it with your new commits instead. This is a consequential write and will pause for human approval before it runs.",
  inputSchema: z.object({
    repo: z.string().describe("Target repository as 'owner/repo'."),
    head: z.string().describe("The branch containing the changes (must exist in the checkout)."),
    base: z.string().default("main").describe("The branch to merge into."),
    title: z.string().describe("PR title."),
    body: z.string().describe("PR description (markdown)."),
    dir: z.string().optional().describe("Workspace-relative checkout directory to push from (default: the repo name)."),
  }),
  approval: always(),
  async execute(input, ctx) {
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
    const push = await sandbox.run({ command: pushCommand(dir, token, input.head) });
    if (push.exitCode !== 0) {
      throw new Error(
        `push of "${input.head}" from ${dir}/ failed — is the repo checked out there (checkout_repo) with that branch committed? ` +
          redactSecret(push.stderr || push.stdout || "unknown error", token).slice(0, 500),
      );
    }

    const pr = await createOrUpdatePullRequest({
      repo: input.repo,
      head: input.head,
      base: input.base,
      title: input.title,
      body: input.body,
      token,
    });

    await auditToolAction(ctx, pr.updated ? "pr.update" : "pr.open", {
      repo: input.repo,
      head: input.head,
      base: input.base,
      number: pr.number,
      url: pr.url,
    });

    return {
      url: pr.url,
      number: pr.number,
      message: pr.updated
        ? `PR #${pr.number} was already open for ${input.head} — your pushed commits updated it: ${pr.url}`
        : `Pushed ${input.head} and opened PR #${pr.number}: ${pr.url}`,
    };
  },
});
