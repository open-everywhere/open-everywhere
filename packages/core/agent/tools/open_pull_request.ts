import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";
import { auditToolAction } from "../audit/tool-action.js";
import { resolveAccessFor } from "../access/request.js";
import { getGitHubApp, repoAllowed } from "../scm/provider.js";

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
    "Open a GitHub pull request. Write a clear body: what changed, why, how you verified it, and link the request that prompted it; open it as a draft if the repo's checks aren't passing. This is a consequential write and will pause for human approval before it runs.",
  inputSchema: z.object({
    repo: z.string().describe("Target repository as 'owner/repo'."),
    head: z.string().describe("The branch containing the changes."),
    base: z.string().default("main").describe("The branch to merge into."),
    title: z.string().describe("PR title."),
    body: z.string().describe("PR description (markdown)."),
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

    const token = await resolvePrToken(input.repo);

    const res = await fetch(
      `https://api.github.com/repos/${input.repo}/pulls`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
        },
        body: JSON.stringify({
          title: input.title,
          body: input.body,
          head: input.head,
          base: input.base,
        }),
      },
    );

    if (!res.ok) {
      throw new Error(`GitHub PR creation failed: ${res.status} ${await res.text()}`);
    }

    const pr = (await res.json()) as { html_url: string; number: number };

    await auditToolAction(ctx, "pr.open", {
      repo: input.repo,
      head: input.head,
      base: input.base,
      number: pr.number,
      url: pr.html_url,
    });

    return { url: pr.html_url, number: pr.number };
  },
});
