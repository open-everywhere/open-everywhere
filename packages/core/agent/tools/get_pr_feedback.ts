import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { resolveAccessFor } from "../access/request.js";
import { preRegisterDynamicEntry } from "../access/window-gated.js";
import type { BindableContext } from "../identity/binding.js";
import { repoAllowed } from "../scm/provider.js";
import { githubWorkMount } from "../scm/github-work.js";
import { assertGithubActingIdentity } from "../scm/github-acting-identity.js";
import { resolveReadToken } from "../scm/pr-status.js";
import { fetchPrFeedback, renderPrFeedbackForModel, type PrFeedbackDigest } from "../scm/pr-feedback.js";
import { githubRecordId, noteAuthoredRecordRead } from "../channels/read-reach.js";

const prFeedbackOutputSchema = z.object({
  repo: z.string(),
  number: z.number(),
  reviews: z.array(z.object({ author: z.string(), state: z.string(), body: z.string() })),
  reviewComments: z.array(z.object({ path: z.string(), line: z.number().nullable(), author: z.string(), body: z.string() })),
  issueComments: z.array(z.object({ author: z.string(), body: z.string() })),
  checks: z.array(z.object({ name: z.string(), status: z.string(), conclusion: z.string().nullable(), summary: z.string() })),
  checksSummary: z.object({
    total: z.number(),
    byConclusion: z.record(z.string(), z.number()),
    failing: z.array(z.string()),
    failingTruncated: z.boolean(),
    pending: z.number(),
  }),
  truncation: z.object({
    truncated: z.boolean(),
    reviewsDropped: z.number(),
    reviewCommentsDropped: z.number(),
    issueCommentsDropped: z.number(),
    checksDropped: z.number(),
    bodiesClipped: z.number(),
    maxBodyChars: z.number(),
  }),
  title: z.string().optional(),
  url: z.string().optional(),
  repoPrivate: z.boolean().optional(),
});

export const getPrFeedbackEntry = defineTool({
  description:
    "Read the feedback on a GitHub pull request: review verdicts (approved / changes-requested), inline review comments (with file + line), issue-thread comments, and check runs (with a failure excerpt for red checks). Read-only, no approval needed. Use this after a PR @mention to see the requested changes before fixing them — the mention only carries the single triggering comment. Bounded: large threads are capped and the result reports what was truncated.",
  inputSchema: z.object({
    repo: z.string().describe("Repository as 'owner/repo'."),
    number: z.number().int().positive().describe("PR number."),
  }),
  outputSchema: prFeedbackOutputSchema,
  async execute(input, ctx) {
    const access = resolveAccessFor(ctx);
    if (!repoAllowed(input.repo, access.repos)) {
      throw new Error(
        `repo "${input.repo}" is not granted to this channel. Allowed: ${access.repos.length ? access.repos.join(", ") : "(none)"}. ` +
          `Grant it via a bundle's repos (see agent/access/bundles.ts).`,
      );
    }
    await assertGithubActingIdentity(ctx as BindableContext, "get_pr_feedback");
    const token = await resolveReadToken(input.repo);
    const digest = await fetchPrFeedback({ repo: input.repo, number: input.number, token });
    noteAuthoredRecordRead(ctx, { kind: "github-pull-request", op: "get_pr_feedback", id: githubRecordId(input.repo, input.number), name: digest.title, url: digest.url });
    return digest as unknown as z.infer<typeof prFeedbackOutputSchema>;
  },
  toModelOutput(output) {
    return { type: "text" as const, value: renderPrFeedbackForModel(output as unknown as PrFeedbackDigest) };
  },
});
preRegisterDynamicEntry("get_pr_feedback", "_single", getPrFeedbackEntry);

export default defineDynamic({
  events: {
    "session.started": (_event, ctx) => (githubWorkMount(ctx as BindableContext) ? getPrFeedbackEntry : null),
  },
});
