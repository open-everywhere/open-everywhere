import {
  appendAudit,
  deploymentOrg,
  getOperationalStore,
} from "@open-everywhere/core/agent/adapter-api.js";
import { githubConversationKey } from "./github-identity.js";

const GITHUB_REACTION_POLL_HOURLY_BUDGET = 60;

const GITHUB_POLL_BUDGET_TTL_MS = 6 * 60 * 60 * 1000;

export const GITHUB_REACTION_POLL_BUDGET_ACTION = "github.reaction_poll_budget";

export const GITHUB_REACTION_CLAIM_UNREADABLE_ACTION = "github.reaction_claim_unreadable";

export const GITHUB_POSTED_MARK_TIMEOUT_MS = 2000;

const BUDGET_AUDIT_TTL_MS = 2 * 60 * 60 * 1000;

function githubPostedClaimKey(owner: string | undefined, repo: string | undefined, number: number | undefined): string | undefined {
  const anchor = githubConversationKey(owner, repo, number);
  return anchor ? `github-posted:${anchor}` : undefined;
}

export function githubPollBudgetKey(owner: string, repo: string, atIso: string): string {
  return `github-reaction-poll-budget:${owner}/${repo}:${atIso.slice(0, 13)}`;
}

export async function markGitHubConversationPosted(owner: string | undefined, repo: string | undefined, number: number | undefined, atIso: string): Promise<void> {
  const key = githubPostedClaimKey(owner, repo, number);
  if (!key) return;
  let write: Promise<void>;
  try {
    write = getOperationalStore()
      .claimNotice(deploymentOrg(), key, atIso)
      .then(
        () => undefined,
        () => undefined,
      );
  } catch {
    return;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const ceiling = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, GITHUB_POSTED_MARK_TIMEOUT_MS);
    timer.unref?.();
  });
  try {
    await Promise.race([write, ceiling]);
  } finally {
    clearTimeout(timer);
  }
}

export async function githubConversationInScope(surfaceKey: string, owner: string | undefined, repo: string | undefined, number: number | undefined): Promise<boolean> {
  const key = githubPostedClaimKey(owner, repo, number);
  const anchor = githubConversationKey(owner, repo, number);
  if (!key || !anchor) return true;
  const org = deploymentOrg();
  try {
    if (await getOperationalStore().noticeClaimed(org, key)) return true;
    return (await getOperationalStore().getEngagement(org, surfaceKey, anchor)) !== null;
  } catch {
    return true;
  }
}

export interface GitHubPollBudgetVerdict {
  readonly admitted: boolean;
  readonly polls: number;
}

export async function spendGitHubPollBudget(owner: string, repo: string, atIso: string, budget = GITHUB_REACTION_POLL_HOURLY_BUDGET): Promise<GitHubPollBudgetVerdict> {
  const org = deploymentOrg();
  const key = githubPollBudgetKey(owner, repo, atIso);
  let used = 0;
  try {
    const raw = await getOperationalStore().getTaskResult(org, key);
    const parsed = raw ? (JSON.parse(raw) as { readonly polls?: unknown }) : undefined;
    used = typeof parsed?.polls === "number" && Number.isFinite(parsed.polls) ? parsed.polls : 0;
  } catch {
    return { admitted: true, polls: 0 };
  }
  if (used >= budget) {
    await auditBudgetTrip(org, owner, repo, atIso, used, budget);
    return { admitted: false, polls: used };
  }
  const polls = used + 1;
  try {
    await getOperationalStore().putTaskResult(org, key, JSON.stringify({ polls }), atIso, GITHUB_POLL_BUDGET_TTL_MS);
  } catch {
  }
  return { admitted: true, polls };
}

export async function auditGitHubReactionClaimUnreadable(owner: string, repo: string, atIso: string, skipped: number): Promise<void> {
  try {
    await appendAudit({
      ts: atIso,
      org: deploymentOrg(),
      platform: "github",
      workspace: owner,
      surface: `github/${owner}/${repo}`,
      action: GITHUB_REACTION_CLAIM_UNREADABLE_ACTION,
      detail: { skipped, hour: atIso.slice(0, 13) },
    });
  } catch {
  }
}

async function auditBudgetTrip(org: string, owner: string, repo: string, atIso: string, used: number, budget: number): Promise<void> {
  try {
    const first = await getOperationalStore().markEventSeen(org, `${githubPollBudgetKey(owner, repo, atIso)}:tripped`, atIso, BUDGET_AUDIT_TTL_MS);
    if (!first) return;
    await appendAudit({
      ts: atIso,
      org,
      platform: "github",
      workspace: owner,
      surface: `github/${owner}/${repo}`,
      action: GITHUB_REACTION_POLL_BUDGET_ACTION,
      detail: { budget, polls: used, hour: atIso.slice(0, 13) },
    });
  } catch {
  }
}
