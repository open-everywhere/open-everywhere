import { getConfig, type AccessRequestsConfig } from "../access/config.js";
import { assertProvidersValid, type Provider } from "../access/providers.js";
import {
  applyBindingOverride,
  applyOverridesToProviders,
  emptyCredentialBindingsFile,
  parseCredentialBindingsText,
  stringifyCredentialBindings,
  type ApplyBindingOverrideResult,
  type CredentialBindingsFile,
  type CredentialBindingOverride,
} from "../access/credential-bindings-codemod.js";
import { GitHubContents, type CommitId } from "../scm/contents.js";
import { createBranch, getBranchSha } from "../scm/refs.js";
import { prApiHeaders, type PrFetchFn, type PrOutcome } from "../scm/pr.js";
import { getGitHubApp } from "../scm/provider.js";
import { isSafeBranchName } from "../scm/git.js";
import { appendAudit } from "../audit/audit.js";
import { DB_BROKER } from "./db-broker.js";

export interface BindingAuditWhere {
  readonly org: string;
  readonly platform: string;
  readonly workspace: string;
  readonly surface: string;
}

export interface StageCredentialBindingPrArgs {
  readonly provider: string;
  readonly credential: string;
  readonly storedRef: string;
  readonly credentialAuditId: string;
  readonly requestedBy: string;
  readonly where: BindingAuditWhere;
}

export interface CredentialBindingPrDeps {
  readonly config?: AccessRequestsConfig | null;
  readonly baseProviders?: () => readonly Provider[];
  readonly bindingsPath?: string;
  readonly dryRun?: boolean;
  readonly contents?: Pick<GitHubContents, "getFile" | "putFile">;
  readonly getBranchSha?: typeof getBranchSha;
  readonly createBranch?: typeof createBranch;
  readonly prFetch?: PrFetchFn;
  readonly resolveToken?: (repo: string) => Promise<string>;
  readonly committer?: CommitId;
  readonly apiBase?: string;
}

export interface StageCredentialBindingPrResult {
  readonly staged: boolean;
  readonly dryRun: boolean;
  readonly url?: string;
  readonly skipped?: string;
}

async function resolveWriteToken(repo: string): Promise<string> {
  const app = getGitHubApp();
  if (app) {
    const { tokens, ungranted } = await app.tokensForRepos([repo]);
    if (!ungranted.length) return tokens.get(repo.slice(0, repo.indexOf("/")))!.token;
  }
  const pat = process.env.GITHUB_TOKEN;
  if (!pat) {
    throw new Error("no GitHub credential for the config repo: configure the GitHub App (OE_GITHUB_APP_*) or set GITHUB_TOKEN.");
  }
  return pat;
}

function bindingPrBody(args: StageCredentialBindingPrArgs, broker: string): string {
  return [
    `Re-stamp credential **${args.provider} / ${args.credential}** custody to \`broker: "${broker}"\`, resolving via ref \`${args.storedRef}\`.`,
    "",
    `This binds the value pasted through the "Set API key" intake (audit \`credential.stored\` id \`${args.credentialAuditId}\`), so`,
    "egress and host paths resolve it from the db broker instead of an env var. **The pasted secret is NOT in this diff** —",
    `only the custody reference. Requested by \`${args.requestedBy}\`.`,
    "",
    "> ⚠️ The previous env var may still have OTHER consumers (e.g. a channel-plumbing path reading the same key). Merging",
    "> re-points THIS credential only; remove the env var upstream only once nothing else reads it.",
    "",
    "---",
    "This diff was produced by the deterministic credential-bindings codemod from the stored-credential ref — no model",
    "authored any part of it. Merging this PR IS the approval (CODEOWNERS + branch protection on the overlay path): the",
    "custody flip goes live on the next deploy of the merged config. Closing it unmerged declines the migration; the pasted",
    "ciphertext stays inert until it merges (nothing resolves the ref).",
  ].join("\n");
}

async function openOrReopenBindingPr(
  opts: { repo: string; head: string; base: string; title: string; body: string; token: string },
  fetchFn: PrFetchFn,
  apiBase: string,
): Promise<PrOutcome & { reopened: boolean }> {
  const post = await fetchFn(`${apiBase}/repos/${opts.repo}/pulls`, {
    method: "POST",
    headers: prApiHeaders(opts.token),
    body: JSON.stringify({ title: opts.title, body: opts.body, head: opts.head, base: opts.base }),
  });
  if (post.ok) {
    const pr = (await post.json()) as { html_url: string; number: number };
    return { url: pr.html_url, number: pr.number, updated: false, reopened: false };
  }
  const text = await post.text();
  if (!(post.status === 422 && text.includes("A pull request already exists"))) {
    throw new Error(`github binding PR create failed: ${post.status} ${text}`);
  }
  const owner = opts.repo.slice(0, opts.repo.indexOf("/"));
  const q = await fetchFn(`${apiBase}/repos/${opts.repo}/pulls?head=${encodeURIComponent(`${owner}:${opts.head}`)}&state=all`, {
    method: "GET",
    headers: prApiHeaders(opts.token),
  });
  if (!q.ok) throw new Error(`github binding PR lookup failed: ${q.status} ${await q.text()}`);
  const list = (await q.json()) as { html_url: string; number: number; state: string }[];
  const pr = list[0];
  if (!pr) throw new Error(`github binding PR: 422 already-exists but no PR found for ${owner}:${opts.head}`);
  if (pr.state === "open") return { url: pr.html_url, number: pr.number, updated: true, reopened: false };
  const patch = await fetchFn(`${apiBase}/repos/${opts.repo}/pulls/${pr.number}`, {
    method: "PATCH",
    headers: prApiHeaders(opts.token),
    body: JSON.stringify({ state: "open", body: opts.body }),
  });
  if (!patch.ok) throw new Error(`github binding PR reopen failed: ${patch.status} ${await patch.text()}`);
  const reopened = (await patch.json()) as { html_url: string; number: number };
  return { url: reopened.html_url, number: reopened.number, updated: true, reopened: true };
}

export async function stageCredentialBindingPr(
  args: StageCredentialBindingPrArgs,
  deps: CredentialBindingPrDeps = {},
): Promise<StageCredentialBindingPrResult> {
  let cfg: AccessRequestsConfig | null;
  try {
    cfg = deps.config ?? getConfig().loadAccessRequests?.() ?? null;
  } catch {
    cfg = null;
  }
  if (!cfg?.configRepo) {
    return { staged: false, dryRun: true, skipped: "config repo not configured (loadAccessRequests / OE_ACCESS_CONFIG_REPO) — credential-binding PR skipped" };
  }
  const baseProvidersFn = deps.baseProviders ?? cfg.baseProviders;
  if (!baseProvidersFn) {
    return { staged: false, dryRun: true, skipped: "base providers not registered (AccessRequestsConfig.baseProviders) — credential-binding PR skipped" };
  }

  const repo = cfg.configRepo;
  const base = cfg.configBase ?? "main";
  const bindingsPath = deps.bindingsPath ?? process.env.OE_CREDENTIAL_BINDINGS_PATH ?? "agent/access/credential-bindings.json";
  const liveArmed = process.env.OE_CREDENTIAL_BINDING_LIVE === "1" && cfg.dryRun !== true;
  const dryRun = deps.dryRun ?? !liveArmed;

  const broker = DB_BROKER;
  const override: CredentialBindingOverride = { provider: args.provider, credential: args.credential, broker, secretRef: args.storedRef };
  const branch = `credential-binding/${args.provider}-${args.credential}`;
  if (!isSafeBranchName(branch)) {
    throw new Error(`unsafe credential-binding branch name "${branch}"`);
  }

  const validateMerged = (file: CredentialBindingsFile): ApplyBindingOverrideResult => {
    const applied = applyBindingOverride(file, override);
    assertProvidersValid(applyOverridesToProviders(baseProvidersFn(), applied.file.overrides));
    return applied;
  };

  const proposedDetail = (extra: Record<string, unknown>) => ({
    credentialAuditId: args.credentialAuditId,
    provider: args.provider,
    credential: args.credential,
    storedRef: args.storedRef,
    broker,
    repo,
    branch,
    ...extra,
  });

  if (dryRun) {
    const applied = validateMerged(emptyCredentialBindingsFile());
    await appendAudit({
      ...args.where,
      principalId: args.requestedBy,
      action: "credential.binding_proposed",
      detail: proposedDetail({ dryRun: true, changed: applied.changed }),
    });
    return { staged: true, dryRun: true };
  }

  const token = await (deps.resolveToken ?? resolveWriteToken)(repo);
  const contents = deps.contents ?? new GitHubContents();
  const refSha = deps.getBranchSha ?? getBranchSha;
  const mkBranch = deps.createBranch ?? createBranch;
  const fetchFn = deps.prFetch ?? (globalThis.fetch as unknown as PrFetchFn);
  const apiBase = deps.apiBase ?? "https://api.github.com";

  let branchSha = await refSha({ repo, branch, token });
  if (branchSha === null) {
    const baseSha = await refSha({ repo, branch: base, token });
    if (baseSha === null) throw new Error(`config repo ${repo} has no base branch "${base}" — check accessRequests.configBase.`);
    await mkBranch({ repo, branch, sha: baseSha, token });
    branchSha = baseSha;
  }

  const existing = await contents.getFile(repo, bindingsPath, branch, token);
  const file = existing?.content ? parseCredentialBindingsText(existing.content) : emptyCredentialBindingsFile();
  const applied = validateMerged(file);

  await appendAudit({
    ...args.where,
    principalId: args.requestedBy,
    action: "credential.binding_proposed",
    detail: proposedDetail({ dryRun: false, changed: applied.changed }),
  });

  if (applied.changed) {
    const committer = deps.committer ?? getGitHubApp()?.committer() ?? { name: "open-everywhere[bot]", email: "open-everywhere@users.noreply.github.com" };
    await contents.putFile(
      repo,
      bindingsPath,
      stringifyCredentialBindings(applied.file),
      `credential binding: ${args.provider}/${args.credential} → db broker`,
      branch,
      token,
      committer,
      existing?.sha,
    );
  }

  const pr = await openOrReopenBindingPr(
    { repo, head: branch, base, title: `Bind credential: ${args.provider}/${args.credential} → db broker`, body: bindingPrBody(args, broker), token },
    fetchFn,
    apiBase,
  );

  await appendAudit({
    ...args.where,
    principalId: args.requestedBy,
    action: "credential.binding_opened",
    detail: proposedDetail({ pr: pr.number, url: pr.url, updated: pr.updated, reopened: pr.reopened }),
  });

  return { staged: true, dryRun: false, url: pr.url };
}
