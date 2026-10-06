import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { resolveAccessFor } from "../access/request.js";
import { preRegisterDynamicEntry } from "../access/window-gated.js";
import type { BindableContext } from "../identity/binding.js";
import { repoAllowed } from "../scm/provider.js";
import { githubWorkMount } from "../scm/github-work.js";
import { assertGithubActingIdentity } from "../scm/github-acting-identity.js";
import { resolveConversationReadToken } from "../scm/pr-status.js";
import { fetchGithubIssue, renderGithubIssueForModel, type GithubIssueDigest } from "../scm/issue-read.js";

const githubIssueOutputSchema = z.object({
  repo: z.string(),
  number: z.number(),
  kind: z.enum(["issue", "pull_request"]),
  title: z.string(),
  state: z.string(),
  author: z.string(),
  url: z.string().optional(),
  body: z.string(),
  repoPrivate: z.boolean().optional(),
  comments: z.array(z.object({ author: z.string(), createdAt: z.string(), body: z.string() })),
  totalComments: z.number(),
  truncation: z.object({
    truncated: z.boolean(),
    commentsDropped: z.number(),
    bodiesClipped: z.number(),
    maxCommentChars: z.number(),
    maxOpeningBodyChars: z.number(),
  }),
});

export const readGithubIssueEntry = defineTool({
  description:
    "Read one GitHub issue by target: its title, state, author, opening body and newest comments. Use it when a `search` hit or a message names an issue (`owner/repo#number`) that is not this conversation — read the body here before you call it inaccessible. It also reads a pull request's opening description. Read-only, no approval needed. Bounded: long bodies are clipped and older comments are dropped, and the result says so.",
  inputSchema: z.object({
    repo: z.string().describe("Repository as 'owner/repo'."),
    number: z.number().int().positive().describe("Issue or pull request number."),
  }),
  outputSchema: githubIssueOutputSchema,
  async execute(input, ctx) {
    const access = resolveAccessFor(ctx);
    if (!repoAllowed(input.repo, access.repos)) {
      throw new Error(
        `repo "${input.repo}" is not granted to this channel. Allowed: ${access.repos.length ? access.repos.join(", ") : "(none)"}. ` +
          `Grant it via a bundle's repos (see agent/access/bundles.ts).`,
      );
    }
    await assertGithubActingIdentity(ctx as BindableContext, "read_github_issue");
    const token = await resolveConversationReadToken(input.repo);
    return (await fetchGithubIssue({ repo: input.repo, number: input.number, token })) as unknown as z.infer<typeof githubIssueOutputSchema>;
  },
  toModelOutput(output) {
    return { type: "text" as const, value: renderGithubIssueForModel(output as unknown as GithubIssueDigest) };
  },
});
preRegisterDynamicEntry("read_github_issue", "_single", readGithubIssueEntry);

export default defineDynamic({
  events: {
    "session.started": (_event, ctx) => (githubWorkMount(ctx as BindableContext) ? readGithubIssueEntry : null),
  },
});
