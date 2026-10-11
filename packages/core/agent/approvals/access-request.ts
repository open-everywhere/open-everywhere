import { getConfig, type AccessRequestsConfig } from "../access/config.js";
import { grantSentence, renderDelta, type AccessDelta } from "../access/delta.js";
import { applyDelta, emitGrantsModule, emptyGrantsFile, parseGrantsModule } from "../access/grants-codemod.js";
import { assertBindingsValid, assertBundlesValid } from "../access/bundle.js";
import { GitHubContents, type CommitId } from "../scm/contents.js";
import { createBranch, getBranchSha } from "../scm/refs.js";
import { createOrUpdatePullRequest } from "../scm/pr.js";
import { getGitHubApp } from "../scm/provider.js";
import { resolveConfigRepoWriteToken } from "../scm/config-repo-token.js";
import { isSafeBranchName } from "../scm/git.js";
import { appendAudit } from "../audit/audit.js";
import { bridgeSlackForm } from "../channels/slack-bridge.js";
import { postSurfaceText } from "../channels/surface-message-ops.js";
import { platformOfScopeKey } from "../access/scope-key.js";
import { inlineForReview } from "./review-surface.js";
import { registerActionKind, whereFromScope } from "./actions.js";
import type { ActionKind } from "./types.js";
import { plainValue } from "./plain-text.js";

export interface AccessRequestArgs {
  readonly org: string;
  readonly scopeKey: string;
  readonly requestId: string;
  readonly delta: AccessDelta;
  readonly requestedBy: string;
  readonly reason?: string;
  readonly channelId: string;
  readonly threadTs: string | null;
  readonly permalink?: string;
  readonly configRepo: string;
  readonly universe?: string;
  readonly exposure?: readonly string[];
}

export interface AccessRequestExecuteDeps {
  readonly config?: AccessRequestsConfig;
  readonly contents?: Pick<GitHubContents, "getFile" | "putFile">;
  readonly getBranchSha?: typeof getBranchSha;
  readonly createBranch?: typeof createBranch;
  readonly createPr?: typeof createOrUpdatePullRequest;
  readonly post?: (method: string, body: string) => Promise<Record<string, unknown> | undefined>;
  readonly postThreadNote?: (platform: string, target: { channelId: string; text: string; threadTs?: string | null }) => Promise<string | undefined>;
  readonly resolveToken?: (repo: string) => Promise<string>;
  readonly committer?: CommitId;
}

export type EnabledAccessRequestsConfig = AccessRequestsConfig & {
  readonly adminChannel: string;
  readonly configRepo: string;
};

export function requireAccessRequestsConfig(override?: AccessRequestsConfig): EnabledAccessRequestsConfig {
  const cfg = override ?? getConfig().loadAccessRequests?.();
  if (!cfg?.adminChannel || !cfg.configRepo) {
    throw new Error(
      "access requests aren't enabled on this deployment — an operator must configure the admin channel + config repo " +
        "(AppConfig.loadAccessRequests; env OE_ACCESS_ADMIN_CHANNEL / OE_ACCESS_CONFIG_REPO). Until then, an admin can PR the grant by hand.",
    );
  }
  return cfg as EnabledAccessRequestsConfig;
}

function prBody(args: AccessRequestArgs, decidedBy: string): string {
  const threadRef = args.permalink ?? `channel ${args.channelId}${args.threadTs ? `, thread ${args.threadTs}` : ""} (scope ${args.scopeKey})`;
  return [
    grantSentence(args.delta) + ".",
    "",
    ...(args.universe ? [args.universe, ""] : []),
    ...(args.exposure?.length ? [...args.exposure, ""] : []),
    ...renderDelta(args.delta).join("\n").split("\n"),
    "",
    `Requested by \`${args.requestedBy}\` · sent by \`${decidedBy}\` · scope \`${args.scopeKey}\``,
    ...(args.reason ? [`Reason: ${inlineForReview(args.reason)}`] : []),
    `Slack thread: ${threadRef}`,
    "",
    "---",
    "This diff was produced by the deterministic grants codemod from a frozen, validated delta — no model authored any",
    "part of it after the request card was posted. Merging this PR IS the approval: the grant goes live on the next",
    "deploy of the merged config. Closing it unmerged declines the request. See docs/how-it-works/access-requests.md.",
  ].join("\n");
}

export async function executeAccessRequest(args: AccessRequestArgs, decidedBy: string, deps: AccessRequestExecuteDeps = {}): Promise<string> {
  const cfg = requireAccessRequestsConfig(deps.config);
  const repo = cfg.configRepo;
  const base = cfg.configBase ?? "main";
  const grantsPath = cfg.grantsPath ?? "agent/access/grants.generated.ts";
  const branch = `access-request/${args.requestId}`;
  if (!isSafeBranchName(branch)) {
    throw new Error(`unsafe access-request branch name "${branch}"`);
  }
  const sentence = grantSentence(args.delta);

  if (args.delta.scope.level === "domain") {
    const domainName = args.delta.scope.domain;
    const domains = cfg.domainRegistry?.();
    if (!domains) {
      throw new Error(
        `cannot revalidate frozen domain "${domainName}" — this deployment doesn't expose its merged domain registry (AccessRequestsConfig.domainRegistry), so no PR was opened`,
      );
    }
    if (!domains.some((domain) => domain.name === domainName)) {
      throw new Error(
        `frozen domain "${domainName}" is no longer declared — it may have been deleted or renamed after this card was posted. Nothing was changed; request access again from the channel so its current canonical domain is reviewed.`,
      );
    }
  }

  const validateMerged = (grantsText: string): ReturnType<typeof applyDelta> => {
    const grants = grantsText ? parseGrantsModule(grantsText) : emptyGrantsFile();
    const result = applyDelta(grants, args.delta);
    const mergedBundles = [...cfg.baseBundles(), ...result.grants.bundles];
    assertBundlesValid(mergedBundles);
    assertBindingsValid([...cfg.baseBindings(), ...result.grants.bindings], mergedBundles, cfg.groupRegistry?.());
    return result;
  };

  if (cfg.dryRun) {
    const result = validateMerged("");
    await appendAudit({
      ...whereFromScope(args.org, args.scopeKey),
      principalId: decidedBy,
      action: "access.request.pr_opened",
      detail: { requestId: args.requestId, dryRun: true, sentence, bundle: result.bundleName, repo, branch },
    });
    return `dry-run — would commit the grant to ${repo}#${branch} (bundle "${result.bundleName}") and open a PR against ${base}; validation passed`;
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
    if (baseSha === null) throw new Error(`config repo ${repo} has no base branch "${base}" — check accessRequests.configBase.`);
    await mkBranch({ repo, branch, sha: baseSha, token });
    branchSha = baseSha;
  }

  const existing = await contents.getFile(repo, grantsPath, branch, token);
  const result = validateMerged(existing?.content ?? "");

  if (result.changed) {
    const committer = deps.committer ?? getGitHubApp()?.committer() ?? { name: "open-everywhere[bot]", email: "open-everywhere@users.noreply.github.com" };
    await contents.putFile(repo, grantsPath, emitGrantsModule(result.grants), `access request: ${sentence}`, branch, token, committer, existing?.sha);
  }

  const pr = await openPr({
    repo,
    head: branch,
    base,
    title: `Access request: ${sentence}`,
    body: prBody(args, decidedBy),
    token,
  });

  await appendAudit({
    ...whereFromScope(args.org, args.scopeKey),
    principalId: decidedBy,
    action: "access.request.pr_opened",
    detail: {
      requestId: args.requestId,
      sentence,
      bundle: result.bundleName,
      repo,
      branch,
      pr: pr.number,
      url: pr.url,
      updated: pr.updated,
      requestedBy: args.requestedBy,
    },
  });

  const adminBody = new URLSearchParams();
  adminBody.set("channel", cfg.adminChannel);
  adminBody.set(
    "text",
    `:inbox_tray: Access request — ${sentence}.\nRequested by <@${args.requestedBy}> · sent by <@${decidedBy}>` +
      `${args.reason ? ` · reason: ${inlineForReview(args.reason)}` : ""}\nReview and merge to grant: ${pr.url}`,
  );
  const adminRes = await post("chat.postMessage", adminBody.toString());
  const adminOk = adminRes?.ok === true;

  const askingPlatform = platformOfScopeKey(args.scopeKey);
  if (askingPlatform) {
    const threadNote = deps.postThreadNote ?? postSurfaceText;
    await threadNote(askingPlatform, {
      channelId: args.channelId,
      threadTs: args.threadTs,
      text: `Access request sent — PR ${pr.url} is with the admins. Merging it grants: ${sentence.charAt(0).toLowerCase()}${sentence.slice(1)}.`,
    });
  }

  return (
    `${pr.updated ? `updated PR #${pr.number}` : `opened PR #${pr.number}`} — ${pr.url}; an admin merges it in GitHub to grant` +
    (adminOk ? "" : " (admin-channel notification failed — flag it to an admin directly)")
  );
}

const accessRequest: ActionKind<AccessRequestArgs> = {
  kind: "access.request",
  policy: "member",
  plainSummary(args) {
    return `Open a pull request for an admin to review: ${plainValue(grantSentence(args.delta), 110)}`;
  },
  summarize(args) {
    return [
      `Request wider access — ${grantSentence(args.delta)}`,
      ...(args.universe ? [args.universe] : []),
      ...(args.exposure ?? []),
      ...renderDelta(args.delta),
      ...(args.reason ? [`Reason: ${inlineForReview(args.reason)}`] : []),
      `Sending opens a bot-PR against \`${args.configRepo}\` for an admin to merge — nothing is granted until they do.`,
    ];
  },
  async execute(args, decidedBy) {
    return executeAccessRequest(args, decidedBy);
  },
};

registerActionKind(accessRequest);
