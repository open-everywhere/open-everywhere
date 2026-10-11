import { getConfig, type AccessRequestsConfig } from "../access/config.js";
import { findDomainRuleEntry, upsertDomainRuleEntry, type DomainRuleEntry } from "../access/domain-rules.js";
import { ruleInstanceProblems } from "../access/pre-approval-rules.js";
import { GitHubContents, type CommitId } from "../scm/contents.js";
import { createBranch, getBranchSha } from "../scm/refs.js";
import { createOrUpdatePullRequest } from "../scm/pr.js";
import { getGitHubApp } from "../scm/provider.js";
import { resolveConfigRepoWriteToken } from "../scm/config-repo-token.js";
import { isSafeBranchName } from "../scm/git.js";
import { appendAudit } from "../audit/audit.js";
import { bridgeSlackForm } from "../channels/slack-bridge.js";
import { inlineForReview } from "./review-surface.js";
import { summarizeFrozenRow, whereFromScope } from "./actions.js";
import { plainSummaryForRow } from "./plain-summary.js";
import { allowRuleText, parseAllowRuleSubject, widenAllowRuleSubject, type AllowRuleProposal, type AllowRuleSubject } from "./allow-rule.js";
import type { PendingActionRow } from "./types.js";

const DOMAIN_RULES_DEFAULT_PATH = "agent/access/domain-rules.ts";

export interface DomainRulePrDeps {
  readonly config?: AccessRequestsConfig;
  readonly contents?: Pick<GitHubContents, "getFile" | "putFile">;
  readonly getBranchSha?: typeof getBranchSha;
  readonly createBranch?: typeof createBranch;
  readonly createPr?: typeof createOrUpdatePullRequest;
  readonly post?: (method: string, body: string) => Promise<Record<string, unknown> | undefined>;
  readonly resolveToken?: (repo: string) => Promise<string>;
  readonly committer?: CommitId;
}

export interface DomainRulePrInput {
  readonly proposal: AllowRuleProposal;
  readonly row: PendingActionRow;
  readonly clickerId: string;
  readonly venue: object;
}

function domainRulePrBody(input: DomainRulePrInput, entry: DomainRuleEntry, previous: DomainRuleEntry | undefined): string {
  const { row } = input;
  return [
    `A person asked to allow things like this in the \`${inlineForReview(entry.domain)}\` domain without a card, from an approval card. Merging adds this rule for the approval judge:`,
    "",
    `> ${inlineForReview(entry.rule)}`,
    "",
    previous
      ? `This WIDENS the existing rule \`${inlineForReview(entry.id)}\` (merge before add). It said:\n\n> ${inlineForReview(previous.rule)}`
      : `This ADDS the rule \`${inlineForReview(entry.id)}\`.`,
    "",
    "**Provenance**",
    `- Asked for by \`${inlineForReview(row.requestedBy)}\` (the person whose turn proposed the act)`,
    `- Rule confirmed by \`${inlineForReview(input.clickerId)}\`, who clicked "Approve, and allow things like this" and read the rule above in the confirmation dialog`,
    `- From approval card \`${inlineForReview(row.id)}\` (\`${inlineForReview(row.kind)}\`) in \`${inlineForReview(row.scopeKey)}\``,
    "",
    "**The original act, as the card showed it**",
    `> ${inlineForReview(plainSummaryForRow(row))}`,
    ...summarizeFrozenRow(row).map((l) => `> ${inlineForReview(l)}`),
    "",
    "---",
    "The rule text is written by code from the card's frozen act — the tool, the kind of action and the kind of object, never one object. The agent never proposes a rule on its own: this pull request exists only because a person chose the option and confirmed it.",
    "That one act was approved on the click. Merging is what allows the next ones. Closing this pull request unmerged declines the rule. To remove a merged rule later, delete its line.",
    "See docs/how-it-works/pre-approval-rules.md#7-approve-and-allow-things-like-this.",
  ].join("\n");
}

export async function executeDomainRulePr(input: DomainRulePrInput, deps: DomainRulePrDeps = {}): Promise<string> {
  const { proposal, row } = input;
  const domain = proposal.domain;
  if (proposal.venue !== "domain" || domain === undefined) throw new Error("a domain rule needs a domain");
  const cfg = deps.config ?? getConfig().loadAccessRequests?.() ?? undefined;
  if (!cfg?.configRepo || !cfg.adminChannel) {
    throw new Error("this deployment has no config repo and admin channel for a rule pull request (agent/access/access-requests.ts)");
  }
  const repo = cfg.configRepo;
  const base = cfg.configBase ?? "main";
  const path = cfg.domainRulesPath ?? DOMAIN_RULES_DEFAULT_PATH;
  const branch = `domain-rule/${row.id}`;
  if (!isSafeBranchName(branch)) throw new Error(`unsafe domain-rule branch name "${branch}"`);

  if (cfg.dryRun) {
    await appendAudit({
      ...whereFromScope(row.org, row.scopeKey),
      principalId: input.clickerId,
      action: "approval.rule.proposed",
      detail: { id: row.id, kind: row.kind, ruleId: proposal.id, domain, dryRun: true, repo, branch, requestedBy: row.requestedBy, ...input.venue },
    });
    return `dry-run — would open a pull request on ${repo} that adds the rule "${proposal.rule}" for the ${domain} domain`;
  }

  const token = await (deps.resolveToken ?? resolveConfigRepoWriteToken)(repo);
  const contents = deps.contents ?? new GitHubContents();
  const refSha = deps.getBranchSha ?? getBranchSha;
  const mkBranch = deps.createBranch ?? createBranch;
  const openPr = deps.createPr ?? createOrUpdatePullRequest;
  const post = deps.post ?? bridgeSlackForm;

  let branchSha = await refSha({ repo, branch, token });
  if (branchSha === null) {
    const baseSha = await refSha({ repo, branch: base, token });
    if (baseSha === null) throw new Error(`config repo ${repo} has no base branch "${base}" — check accessRequests.configBase`);
    await mkBranch({ repo, branch, sha: baseSha, token });
    branchSha = baseSha;
  }
  const existing = await contents.getFile(repo, path, branch, token);
  if (existing === null) {
    throw new Error(`config repo ${repo} has no ${path} — add the file and its two bundles.ts lines from the app template to take domain rules (docs/how-it-works/pre-approval-rules.md §7)`);
  }

  const previous = findDomainRuleEntry(existing.content, domain, proposal.id);
  const previousSubject = previous?.subject ? parseAllowRuleSubject(JSON.stringify(previous.subject)) : undefined;
  const subject: AllowRuleSubject = previousSubject ? widenAllowRuleSubject(previousSubject, proposal.subject) : proposal.subject;
  const rule = allowRuleText("domain", subject);
  if (ruleInstanceProblems(rule).length > 0) throw new Error("the widened rule would name one object");
  const entry: DomainRuleEntry = { domain, id: proposal.id, rule, subject };
  const result = upsertDomainRuleEntry(existing.content, entry);
  if (result.change !== "unchanged") {
    const committer = deps.committer ?? getGitHubApp()?.committer() ?? { name: "open-everywhere[bot]", email: "open-everywhere@users.noreply.github.com" };
    await contents.putFile(repo, path, result.text, `domain rule (${domain}): ${proposal.id}`, branch, token, committer, existing.sha);
  }
  const title = `Allow without a card in ${domain}: ${subject.action} ${subject.objects.join(" and ")} (${subject.tool})`;
  const pr = await openPr({ repo, head: branch, base, title, body: domainRulePrBody(input, entry, result.change === "widened" ? result.previous : undefined), token });

  await appendAudit({
    ...whereFromScope(row.org, row.scopeKey),
    principalId: input.clickerId,
    action: "approval.rule.proposed",
    detail: { id: row.id, kind: row.kind, ruleId: proposal.id, domain, change: result.change, repo, branch, pr: pr.number, url: pr.url, requestedBy: row.requestedBy, ...input.venue },
  });

  const adminBody = new URLSearchParams();
  adminBody.set("channel", cfg.adminChannel);
  adminBody.set("text", `:pencil: Rule request for the ${domain} domain — "${rule}"\nAsked for by <@${row.requestedBy}> · confirmed by <@${input.clickerId}>\nReview and merge to allow it: ${pr.url}`);
  const adminOk = (await post("chat.postMessage", adminBody.toString()).catch(() => undefined))?.ok === true;

  return (
    `rule proposed in ${pr.updated ? "updated" : "new"} pull request #${pr.number} (${pr.url}) — it applies after an admin merges it` +
    (adminOk ? "" : " (the admin-channel note failed — tell an admin directly)")
  );
}
