import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";
import { resolveAccess } from "../access/resolver.js";
import { buildResolveRequest } from "../access/request.js";
import { loadBundles, loadBindings } from "../access/bundles.js";
import { getGitHubApp } from "../scm/provider.js";

export default defineTool({
  description:
    "List the GitHub repositories this channel is allowed to work with. Returns the granted repos (owner/repo). Use checkout_repo to clone one into your workspace before reading or changing its code.",
  inputSchema: z.object({}),
  outputSchema: z.object({
    repos: z.array(z.string()),
    sourceControlConfigured: z.boolean().describe("false if no GitHub App is set up — cloning/PRs won't work until it is."),
  }),
  needsApproval: never(),
  async execute(_input, ctx) {
    const access = resolveAccess(buildResolveRequest(ctx), loadBundles(), loadBindings());
    return { repos: [...access.repos], sourceControlConfigured: getGitHubApp() !== null };
  },
});
