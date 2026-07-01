import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";
import { resolveAccessFor } from "../access/request.js";
import { getGitHubApp } from "../scm/provider.js";

export default defineTool({
  description:
    "List the GitHub repositories this channel is allowed to work with. Returns the granted repos (owner/repo). Use checkout_repo to clone one into your workspace before reading or changing its code.",
  inputSchema: z.object({}),
  outputSchema: z.object({
    repos: z.array(z.string()),
    sourceControlConfigured: z.boolean().describe("false if no GitHub App is set up — cloning/PRs won't work until it is."),
  }),
  approval: never(),
  async execute(_input, ctx) {
    const access = resolveAccessFor(ctx);
    return { repos: [...access.repos], sourceControlConfigured: getGitHubApp() !== null };
  },
});
