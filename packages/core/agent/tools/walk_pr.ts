import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { resolveAccessFor } from "../access/request.js";
import { preRegisterDynamicEntry } from "../access/window-gated.js";
import type { BindableContext } from "../identity/binding.js";
import { repoAllowed } from "../scm/provider.js";
import { assertGithubActingIdentity } from "../scm/github-acting-identity.js";
import { githubWorkMount } from "../scm/github-work.js";
import { describePrStatus, fetchPullRequestStatus, prStateLabel, resolveReadToken } from "../scm/pr-status.js";
import { fetchPrDiff } from "../scm/pr-diff.js";
import { fetchConfigFacts } from "../review/facts-artifact.js";
import { buildNarratorBrief, renderWalkthrough } from "../review/pr-walkthrough.js";

export const WALK_PR_INPUT_KEYS: readonly string[] = ["repo", "number"];

const inputSchema = z.object({
  repo: z.string().describe("Repository as 'owner/repo'."),
  number: z.number().int().positive().describe("PR number."),
});

export const walkPrEntry = defineTool({
  description:
    "Gather everything needed to walk a human through a pull request before they merge it: the PR's state, its diff, and the resolved-config FACTS (effective access per scope, domain rosters, declared webhooks, standing instructions) read either from the config-diff workflow's own artifact or from the `oe/config-diff` commit status that vouches for a cloud run's output by sha256. Returns a `narratorBrief` — pass it verbatim as `message` to fresh_eyes_review, then call post_pr_walkthrough with that verdict. Read-only, no approval needed. It deliberately takes no free-text input: you cannot add your own framing to what the independent reviewer sees.",
  inputSchema,
  outputSchema: z.object({
    repo: z.string(),
    number: z.number(),
    headSha: z.string(),
    prSummary: z.string(),
    factsState: z
      .enum(["artifact", "cloud-status", "not-triggered", "unavailable"])
      .describe(
        "artifact = real config facts from a CODEOWNED Actions workflow run; cloud-status = real config facts from a cloud run, vouched for by an " +
          "`oe/config-diff` commit status and verified against the sha256 it names; not-triggered = this PR changes no config (a computed absence); unavailable = UNKNOWN.",
      ),
    factsRunId: z.number().optional().describe("The config-diff workflow run the facts came from. Actions provenance only — a cloud-status walkthrough has no run id. Pass to post_pr_walkthrough so a staleness check is possible."),
    factsNote: z.string().describe("One line: where the facts came from, or why there are none."),
    diffChars: z.number(),
    diffClipped: z.boolean(),
    filesTouched: z.number(),
    narratorBrief: z.string().describe("Pass this verbatim to fresh_eyes_review as `message`. Do not edit, summarize or add to it."),
    factsOnlyWalkthrough: z.string().describe("The walkthrough as it stands with NO narration — every interpretive section renders NOT COMPUTABLE."),
    nextStep: z.string(),
  }),
  async execute(input, ctx) {
    const access = resolveAccessFor(ctx);
    if (!repoAllowed(input.repo, access.repos)) {
      throw new Error(
        `repo "${input.repo}" is not granted to this channel. Allowed: ${access.repos.length ? access.repos.join(", ") : "(none)"}. ` +
          `Grant it via a bundle's repos (see agent/access/bundles.ts).`,
      );
    }
    await assertGithubActingIdentity(ctx as BindableContext, "walk_pr");
    const token = await resolveReadToken(input.repo);
    const [status, diff] = await Promise.all([
      fetchPullRequestStatus({ repo: input.repo, number: input.number, token }),
      fetchPrDiff({ repo: input.repo, number: input.number, token }),
    ]);

    const facts = await fetchConfigFacts({
      repo: input.repo,
      headSha: diff.headSha,
      token,
      ...(diff.filesCapped ? {} : { changedPaths: diff.files }),
    });

    const pr = {
      repo: input.repo,
      number: input.number,
      url: status.url,
      title: status.title,
      stateLabel: prStateLabel(status),
      baseRef: diff.baseRef,
      headSha: diff.headSha,
    };

    return {
      repo: input.repo,
      number: input.number,
      headSha: diff.headSha,
      prSummary: describePrStatus(status),
      factsState: facts.kind,
      ...(facts.kind === "artifact" ? { factsRunId: facts.provenance.runId } : {}),
      factsNote:
        facts.kind === "artifact"
          ? `config-diff run ${facts.provenance.runId} (${facts.provenance.runUrl}), artifact "${facts.provenance.artifactName}", conclusion ${facts.provenance.runConclusion ?? "pending"}`
          : facts.kind === "cloud-status"
            ? `the "${facts.provenance.statusContext}" commit status on ${facts.provenance.headSha.slice(0, 12)}` +
              `${facts.provenance.postedBy ? ` (posted by ${facts.provenance.postedBy})` : ""}, vouching for ${facts.provenance.documentUrl} ` +
              `by sha256:${facts.provenance.digest} — verified before the facts were read`
            : facts.reason,
      diffChars: diff.diffChars,
      diffClipped: diff.diffClipped,
      filesTouched: diff.files.length,
      narratorBrief: buildNarratorBrief({ pr, diff, facts }),
      factsOnlyWalkthrough: renderWalkthrough({ pr, diff, facts }),
      nextStep:
        `Call fresh_eyes_review with message = narratorBrief (verbatim), then post_pr_walkthrough with repo, number, ` +
        `narration = that verdict, and factsRunId = ${
          facts.kind === "artifact"
            ? facts.provenance.runId
            : facts.kind === "cloud-status"
              ? "(omit — these facts come from a commit status, which has no workflow run id)"
              : "(omit — there are no facts)"
        }. ` +
        `Do not write the walkthrough yourself: post_pr_walkthrough renders it from the facts it fetches itself, and your prose would not be labelled as a model opinion.`,
    };
  },
  toModelOutput(output) {
    const o = output as { prSummary: string; factsNote: string; narratorBrief: string; nextStep: string; factsState: string };
    return {
      type: "text" as const,
      value: [
        `PR: ${o.prSummary}`,
        `Config facts: ${o.factsState} — ${o.factsNote}`,
        "",
        "── BRIEF FOR fresh_eyes_review (pass as `message`, verbatim) ──",
        o.narratorBrief,
        "",
        `── NEXT ── ${o.nextStep}`,
      ].join("\n"),
    };
  },
});
preRegisterDynamicEntry("walk_pr", "_single", walkPrEntry);

export default defineDynamic({
  events: {
    "session.started": (_event, ctx) => (githubWorkMount(ctx as BindableContext) ? walkPrEntry : null),
  },
});
