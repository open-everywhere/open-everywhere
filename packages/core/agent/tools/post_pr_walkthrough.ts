import { defineTool } from "eve/tools";
import { z } from "zod";
import { appendAudit } from "../audit/audit.js";
import { getConfig } from "../access/config.js";
import { resolveAccessFor } from "../access/request.js";
import { sessionMountedTool } from "../access/window-gated.js";
import { deploymentOrg, type BindableContext } from "../identity/binding.js";
import { githubWorkMount } from "../scm/github-work.js";
import { bridgeSlackForm } from "../channels/slack-bridge.js";
import { repoAllowed } from "../scm/provider.js";
import { fetchPullRequestStatus, prStateLabel, resolveReadToken } from "../scm/pr-status.js";
import { fetchPrDiff } from "../scm/pr-diff.js";
import { fetchConfigFacts } from "../review/facts-artifact.js";
import { renderWalkthrough, type WalkthroughNarration } from "../review/pr-walkthrough.js";
import { readSubagentAttestation } from "../spend/subagent-runs.js";
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
  narration: narrationSchema.describe(
    "The fresh_eyes_review verdict, passed through unchanged. The host checks its own spend ledger for a delegated subagent run in this session: without one the document renders this as UNATTESTED and tells the reader to treat it as your words about your own change.",
  ),
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

export const postPrWalkthroughEntry = defineTool({
  description:
    "Render the PR walkthrough and post it to the governance admin channel. Pass the fresh_eyes_review verdict as `narration`; the resolved-config FACTS are re-fetched here — from the CODEOWNED workflow's own artifact, or from the document the `oe/config-diff` commit status vouches for by sha256 — and are not something you can supply, alter or omit. The document labels every computed fact and every model opinion differently, states whether the spend ledger shows a delegated subagent run behind the narration, and always states what it cannot establish. It approves and merges nothing — the merge stays with the human. Call walk_pr first.",
  inputSchema,
  outputSchema: z.object({
    walkthrough: z.string().describe("The rendered document, exactly as posted."),
    factsState: z.enum(["artifact", "cloud-status", "not-triggered", "unavailable"]),
    factsRunId: z.number().optional(),
    factsStale: z.boolean().describe("True when factsRunId was supplied and does not match the run now backing these facts. Always false for `cloud-status` facts, which carry no workflow run id — a staleness check there is UNPERFORMED, not passed."),
    narrationAttested: z
      .boolean()
      .describe("True when the spend ledger records a delegated subagent run under this session. It attests that a delegated session RAN — not which one, and not that the narration is its text."),
    narrationAttestation: z.string().describe("One line: what the ledger showed, or why it showed nothing."),
    delivered: z.boolean(),
    outcome: z.string(),
  }),
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

    const attestation = await readSubagentAttestation(deploymentOrg(), ctx.session.id);

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
      attestation,
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
        narrationAttested: attestation.kind === "ledger",
        ...(attestation.kind === "ledger" ? { subagentRuns: attestation.runs, subagentEvents: attestation.events } : {}),
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
        "no governance admin channel is configured on this deployment (AppConfig.loadAccessRequests / accessRequests.adminChannel), " +
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

    const attestationNote =
      attestation.kind === "ledger"
        ? `the spend ledger records ${attestation.events} model call(s) from ${attestation.runs} delegated subagent session(s) under this session — a delegated run happened; which subagent, and whether the narration is its text, are not established`
        : `NARRATION UNATTESTED — ${attestation.reason}`;

    return {
      walkthrough,
      factsState: facts.kind,
      ...(runId !== undefined ? { factsRunId: runId } : {}),
      factsStale,
      narrationAttested: attestation.kind === "ledger",
      narrationAttestation: attestationNote,
      delivered,
      outcome:
        `Walkthrough for ${input.repo}#${input.number} rendered from ${facts.kind === "artifact" ? `config-diff run ${runId}` : facts.kind === "cloud-status" ? `the ${facts.provenance.statusContext} commit status (sha256:${facts.provenance.digest.slice(0, 12)}…)` : `NO config facts (${facts.kind})`} — ${deliveryNote}. ` +
        `Narration provenance: ${attestationNote}. ` +
        `Nothing was approved or merged; the merge is still the reviewer's.`,
    };
  },
});

export default sessionMountedTool("post_pr_walkthrough", postPrWalkthroughEntry, (ctx) => githubWorkMount(ctx));
