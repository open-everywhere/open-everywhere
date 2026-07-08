import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";
import { resolveAccessFor } from "../access/request.js";
import { repoAllowed } from "../scm/provider.js";
import { fetchPullRequestStatus, describePrStatus, resolveReadToken } from "../scm/pr-status.js";

export default defineTool({
  description:
    "Look up the current status of a GitHub pull request — open/closed/merged, draft, title, last updated. Read-only, no approval needed. Use this to check on a PR directly, or to re-check one you're watching via a pr-subscription routine (subscribe_pr).",
  inputSchema: z.object({
    repo: z.string().describe("Repository as 'owner/repo'."),
    number: z.number().int().positive().describe("PR number."),
  }),
  outputSchema: z.object({
    url: z.string(),
    title: z.string(),
    state: z.enum(["open", "closed"]),
    merged: z.boolean(),
    draft: z.boolean(),
    updatedAt: z.string(),
    summary: z.string().describe("One-line human summary — the format the subscription baseline uses."),
  }),
  approval: never(),
  async execute(input, ctx) {
    const access = resolveAccessFor(ctx);
    if (!repoAllowed(input.repo, access.repos)) {
      throw new Error(
        `repo "${input.repo}" is not granted to this channel. Allowed: ${access.repos.length ? access.repos.join(", ") : "(none)"}. ` +
          `Grant it via a bundle's repos (see agent/access/bundles.ts).`,
      );
    }
    const token = await resolveReadToken(input.repo);
    const status = await fetchPullRequestStatus({ repo: input.repo, number: input.number, token });
    return {
      url: status.url,
      title: status.title,
      state: status.state,
      merged: status.merged,
      draft: status.draft,
      updatedAt: status.updatedAt,
      summary: describePrStatus(status),
    };
  },
});
