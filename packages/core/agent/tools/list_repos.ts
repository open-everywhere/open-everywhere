import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";
import { resolveAccessFor } from "../access/request.js";
import { githubAuthMode, githubCredentialConfigured, tokenReaches } from "../scm/credential.js";

export default defineTool({
  description:
    "List the GitHub repositories this channel is allowed to work with. Returns the granted repos (owner/repo). Use checkout_repo to clone one into your workspace before reading or changing its code.",
  inputSchema: z.object({}),
  outputSchema: z.object({
    repos: z.array(z.string()),
    sourceControlConfigured: z.boolean().describe("false if this deployment holds no GitHub credential — cloning/PRs won't work until it does."),
  }),
  approval: never(),
  async execute(_input, ctx) {
    const access = resolveAccessFor(ctx);
    const repos = githubAuthMode() === "token" ? access.repos.filter((r) => tokenReaches(r)) : access.repos;
    return { repos: [...repos], sourceControlConfigured: githubCredentialConfigured() };
  },
});
