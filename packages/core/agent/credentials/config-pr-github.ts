import { GitHubContents } from "../scm/contents.js";
import { createBranch, getBranchSha } from "../scm/refs.js";
import { prApiHeaders, type PrFetchFn } from "../scm/pr.js";
import { getGitHubApp } from "../scm/provider.js";
import {
  registerConfigPrProvider,
  type CommitIdentity,
  type ConfigFileContent,
  type ConfigPrOutcome,
  type ConfigPrProvider,
} from "./config-pr.js";

const GITHUB_API_BASE = "https://api.github.com";

const DEFAULT_COMMITTER: CommitIdentity = {
  name: "open-everywhere[bot]",
  email: "open-everywhere@users.noreply.github.com",
};

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

async function openOrReopenPr(
  opts: { repo: string; head: string; base: string; title: string; body: string; token: string },
  fetchFn: PrFetchFn,
  apiBase: string,
): Promise<ConfigPrOutcome> {
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

export function makeGitHubConfigPrProvider(
  deps: {
    contents?: Pick<GitHubContents, "getFile" | "putFile">;
    getBranchSha?: typeof getBranchSha;
    createBranch?: typeof createBranch;
    prFetch?: PrFetchFn;
    committer?: () => CommitIdentity;
    apiBase?: string;
  } = {},
): ConfigPrProvider {
  const contents = deps.contents ?? new GitHubContents();
  const refSha = deps.getBranchSha ?? getBranchSha;
  const mkBranch = deps.createBranch ?? createBranch;
  const fetchFn = deps.prFetch ?? (globalThis.fetch as unknown as PrFetchFn);
  const apiBase = deps.apiBase ?? GITHUB_API_BASE;
  const committerFn = deps.committer ?? (() => getGitHubApp()?.committer() ?? DEFAULT_COMMITTER);

  return {
    resolveWriteToken,
    committer: committerFn,
    async getBranchSha(args): Promise<string | null> {
      return refSha({ repo: args.repo, branch: args.branch, token: args.token });
    },
    async ensureBranch(args): Promise<void> {
      await mkBranch({ repo: args.repo, branch: args.branch, sha: args.sha, token: args.token });
    },
    async getFile(args): Promise<ConfigFileContent | null> {
      return contents.getFile(args.repo, args.path, args.branch, args.token);
    },
    async putFile(args): Promise<void> {
      await contents.putFile(args.repo, args.path, args.content, args.message, args.branch, args.token, args.committer, args.sha);
    },
    async openOrReopenPr(args): Promise<ConfigPrOutcome> {
      return openOrReopenPr(args, fetchFn, apiBase);
    },
  };
}

export function registerGitHubConfigPrProvider(): void {
  registerConfigPrProvider(makeGitHubConfigPrProvider());
}
