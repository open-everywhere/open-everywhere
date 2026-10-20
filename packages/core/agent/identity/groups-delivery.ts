import { getConfig, type AccessRequestsConfig } from "../access/config.js";
import { GitHubContents, type CommitId } from "../scm/contents.js";
import { createBranch, getBranchSha } from "../scm/refs.js";
import { createOrUpdatePullRequest } from "../scm/pr.js";
import { getGitHubApp } from "../scm/provider.js";
import { resolveConfigRepoWriteToken } from "../scm/config-repo-token.js";
import { isSafeBranchName } from "../scm/git.js";
import { emitGroupsModule } from "./groups-codemod.js";
import { groupPlanIsNoop, renderGroupPlan, type GroupSyncPlan } from "./group-sync.js";
import { directoryMode, directoryObserveRefusal } from "./directory-sync.js";

const DEFAULT_GROUPS_OVERLAY_PATH = "agent/identity/groups.generated.ts";

export type GroupsDeliveryConfig = AccessRequestsConfig & { readonly configRepo: string };

export function requireGroupsDeliveryConfig(override?: AccessRequestsConfig): GroupsDeliveryConfig {
  const cfg = override ?? getConfig().loadAccessRequests?.() ?? undefined;
  if (!cfg?.configRepo) {
    throw new Error(
      "IdP group-overlay bot-PR delivery isn't configured on this deployment — an operator must set the config repo " +
        "(AppConfig.loadAccessRequests; env OE_ACCESS_CONFIG_REPO). Until then, directory_groups_plan still returns the " +
        "overlay content for an admin to commit by hand.",
    );
  }
  return cfg as GroupsDeliveryConfig;
}

export interface GroupsDeliveryDeps {
  readonly config?: AccessRequestsConfig;
  readonly contents?: Pick<GitHubContents, "getFile" | "putFile">;
  readonly getBranchSha?: typeof getBranchSha;
  readonly createBranch?: typeof createBranch;
  readonly createPr?: typeof createOrUpdatePullRequest;
  readonly resolveToken?: (repo: string) => Promise<string>;
  readonly committer?: CommitId;
}

export interface GroupsDeliveryOutcome {
  readonly outcome: "no-op" | "dry-run" | "opened" | "updated";
  readonly repo: string;
  readonly branch: string;
  readonly committed: boolean;
  readonly pr?: { readonly number: number; readonly url: string };
  readonly note: string;
}

export function groupsPrBody(plan: GroupSyncPlan): string {
  const diff = renderGroupPlan(plan);
  return [
    `Sync the person-group overlay against the \`${plan.provider}\` directory.`,
    "",
    `${plan.people} directory person(s) diffed — ${plan.counts.addGroup} group(s) added, ${plan.counts.dropGroup} dropped, ` +
      `${plan.counts.addMember} member(s) added, ${plan.counts.removeMember} removed.`,
    "",
    ...(diff.length ? diff : ["(no changes)"]),
    ...(plan.warnings.length ? ["", "Warnings (the planner refused to act on these):", ...plan.warnings.map((w) => `- ${w}`)] : []),
    "",
    "---",
    "This diff was produced by the deterministic person-group codemod from a directory snapshot — no model authored any",
    "part of it. The groups are `directory:`-namespaced (they cannot collide with hand-written ones) and every member is a",
    "link-set reference, so a person contributes only the accounts they have CONFIRMED. Merging this PR IS the approval:",
    "the memberships take effect on the next deploy of the merged config. Closing it unmerged declines the sync.",
    "See docs/how-it-works/access-and-scoping.md.",
  ].join("\n");
}

export async function deliverGroupsOverlay(plan: GroupSyncPlan, deps: GroupsDeliveryDeps = {}): Promise<GroupsDeliveryOutcome> {
  if (directoryMode() === "observe") throw new Error(directoryObserveRefusal("a group bot-PR"));
  const cfg = requireGroupsDeliveryConfig(deps.config);
  const repo = cfg.configRepo;
  const base = cfg.configBase ?? "main";
  const groupsPath = cfg.groupsPath ?? DEFAULT_GROUPS_OVERLAY_PATH;
  const branch = `directory-groups/${plan.provider}`;
  if (!isSafeBranchName(branch)) {
    throw new Error(`unsafe directory-groups branch name "${branch}" (from provider id "${plan.provider}")`);
  }

  if (groupPlanIsNoop(plan)) {
    return {
      outcome: "no-op",
      repo,
      branch,
      committed: false,
      note: "the overlay already matches the directory — no PR opened.",
    };
  }

  const overlayContent = emitGroupsModule(plan.next);
  if (cfg.dryRun === true) {
    return {
      outcome: "dry-run",
      repo,
      branch,
      committed: false,
      note: `dry run (accessRequests.dryRun) — would commit ${groupsPath} to ${repo}#${branch} and open a PR against ${base}; no branch, no PR.`,
    };
  }
  const token = await (deps.resolveToken ?? resolveConfigRepoWriteToken)(repo);
  const contents = deps.contents ?? new GitHubContents();
  const refSha = deps.getBranchSha ?? getBranchSha;
  const mkBranch = deps.createBranch ?? createBranch;
  const openPr = deps.createPr ?? createOrUpdatePullRequest;

  let branchSha = await refSha({ repo, branch, token });
  if (branchSha === null) {
    const baseSha = await refSha({ repo, branch: base, token });
    if (baseSha === null) throw new Error(`config repo ${repo} has no base branch "${base}" — check accessRequests.configBase.`);
    await mkBranch({ repo, branch, sha: baseSha, token });
    branchSha = baseSha;
  }

  const existing = await contents.getFile(repo, groupsPath, branch, token);
  let committed = false;
  if (!existing || existing.content !== overlayContent) {
    const committer = deps.committer ?? getGitHubApp()?.committer() ?? { name: "open-everywhere[bot]", email: "open-everywhere@users.noreply.github.com" };
    await contents.putFile(repo, groupsPath, overlayContent, `directory group sync: ${plan.provider}`, branch, token, committer, existing?.sha);
    committed = true;
  }

  const pr = await openPr({
    repo,
    head: branch,
    base,
    title: `Directory group sync: ${plan.provider}`,
    body: groupsPrBody(plan),
    token,
  });

  return {
    outcome: pr.updated ? "updated" : "opened",
    repo,
    branch,
    committed,
    pr: { number: pr.number, url: pr.url },
    note: `${pr.updated ? "updated" : "opened"} PR #${pr.number} — ${pr.url}; an admin merges it in GitHub to apply the group overlay (nothing takes effect until they do).`,
  };
}
