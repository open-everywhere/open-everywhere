import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";
import { appendAudit } from "../audit/audit.js";
import { getConfig } from "../access/config.js";
import { resolveAccessFor } from "../access/request.js";
import { deploymentOrg } from "../identity/binding.js";
import { bridgeSlackForm } from "../channels/slack-bridge.js";
import { repoAllowed } from "../scm/provider.js";
import { fetchPullRequestStatus, prStateLabel, resolveReadToken } from "../scm/pr-status.js";
import { fetchPrDiff } from "../scm/pr-diff.js";
import { fetchConfigFacts } from "../review/facts-artifact.js";
import { renderWalkthrough, type WalkthroughNarration } from "../review/pr-walkthrough.js";
import { REVIEW_CATEGORY, REVIEW_SEVERITY } from "../subagents/contracts.js";

export const POST_PR_WALKTHROUGH_INPUT_KEYS: readonly string[] = ["repo", "number", "narration", "factsRunId"];

const narrationSchema = z.object({
  recommendation: z.enum(["approve", "block"]).describe("The reviewer's own value. It decides nothing here."),
  summary: z.string().describe("The reviewer's `summary`, verbatim."),
  evidenceSeen: z.boolean().describe("The reviewer's `evidenceSeen`. False renders section 2 as NOT COMPUTABLE."),
  findings: z
    .array(
      z.object({
        severity: z.enum(REVIEW_SEVERITY),
        category: z.enum(REVIEW_CATEGORY),
        title: z.string(),
        detail: z.string(),
        location: z.string().optional(),
      }),
    )
    .describe("The reviewer's `findings`, verbatim."),
  meaning: z
    .array(z.object({ subject: z.string(), says: z.string() }))
    .optional()
    .describe("The reviewer's `meaning`, verbatim. Each `subject` is checked against the FACTS and labelled anchored or not."),
});

const inputSchema = z.object({
  repo: z.string().describe("Repository as 'owner/repo'."),
  number: z.number().int().positive().describe("PR number."),
  narration: narrationSchema.describe("The fresh_eyes_review verdict, passed through unchanged. Do NOT write your own — it renders as a model opinion either way, and rewriting it just makes it a worse one."),
  factsRunId: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("The config-diff run id walk_pr reported. Supplied ⇒ a staleness check: if the facts have since been recomputed, the render says so."),
});

function adminChannel(): string | undefined {
  try {
    return getConfig().loadAccessRequests?.()?.adminChannel ?? undefined;
  } catch {
    return undefined;
  }
}

export default defineTool({
  description:
    "Render the PR walkthrough and post it to the governance admin channel. Pass the fresh_eyes_review verdict as `narration`; the resolved-config FACTS are re-fetched here from CI's own artifact and are not something you can supply, alter or omit. The document labels every computed fact and every model opinion differently, and always states what it cannot establish. It approves and merges nothing — the merge stays with the human. Call walk_pr first.",
  inputSchema,
  outputSchema: z.object({
    walkthrough: z.string().describe("The rendered document, exactly as posted."),
    factsState: z.enum(["artifact", "not-triggered", "unavailable"]),
    factsRunId: z.number().optional(),
    factsStale: z.boolean().describe("True when factsRunId was supplied and does not match the run now backing these facts."),
    delivered: z.boolean(),
    outcome: z.string(),
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

    const narration: WalkthroughNarration = {
      recommendation: input.narration.recommendation,
      summary: input.narration.summary,
      evidenceSeen: input.narration.evidenceSeen,
      findings: input.narration.findings,
      ...(input.narration.meaning ? { meaning: input.narration.meaning } : {}),
    };

    const walkthrough = renderWalkthrough({
      pr: {
        repo: input.repo,
        number: input.number,
        url: status.url,
        title: status.title,
        stateLabel: prStateLabel(status),
        baseRef: diff.baseRef,
        headSha: diff.headSha,
      },
      diff,
      facts,
      narration,
      ...(input.factsRunId !== undefined ? { expectedFactsRunId: input.factsRunId } : {}),
    });

    const runId = facts.kind === "artifact" ? facts.provenance.runId : undefined;
    const factsStale = input.factsRunId !== undefined && runId !== undefined && input.factsRunId !== runId;

    await appendAudit({
      org: deploymentOrg(),
      platform: "review",
      workspace: input.repo,
      action: "review.pr_walkthrough",
      detail: {
        repo: input.repo,
        number: input.number,
        headSha: diff.headSha,
        factsState: facts.kind,
        factsRunId: runId ?? null,
        factsStale,
        recommendation: input.narration.recommendation,
        evidenceSeen: input.narration.evidenceSeen,
        findings: input.narration.findings.length,
        severities: input.narration.findings.reduce<Record<string, number>>((acc, f) => ({ ...acc, [f.severity]: (acc[f.severity] ?? 0) + 1 }), {}),
        diffClipped: diff.diffClipped,
      },
    }).catch(() => undefined);

    const channel = adminChannel();
    let delivered = false;
    let deliveryNote: string;
    if (!channel) {
      deliveryNote =
        "no governance admin channel is configured on this deployment (AppConfig.loadAccessRequests / OE_ACCESS_ADMIN_CHANNEL), " +
        "so the walkthrough was not posted anywhere — relay it yourself, and say that it was not delivered to the admins";
    } else {
      try {
        const body = new URLSearchParams();
        body.set("channel", channel);
        body.set("text", walkthrough);
        const res = await bridgeSlackForm("chat.postMessage", body.toString());
        delivered = res?.ok === true;
        deliveryNote = delivered ? `posted to the governance admin channel` : `the admin-channel post did not confirm ok — relay it yourself and flag that delivery failed`;
      } catch (err) {
        deliveryNote = `the admin-channel post failed (${err instanceof Error ? err.message : String(err)}) — relay it yourself and flag that delivery failed`;
      }
    }

    return {
      walkthrough,
      factsState: facts.kind,
      ...(runId !== undefined ? { factsRunId: runId } : {}),
      factsStale,
      delivered,
      outcome:
        `Walkthrough for ${input.repo}#${input.number} rendered from ${facts.kind === "artifact" ? `config-diff run ${runId}` : `NO config facts (${facts.kind})`} — ${deliveryNote}. ` +
        `Nothing was approved or merged; the merge is still the reviewer's.`,
    };
  },
});
