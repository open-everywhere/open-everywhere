import type { GitHubApp } from "./app.js";
import { getGitHubApp } from "./provider.js";
import { READ_PERMISSIONS } from "./mint.js";
import { prApiHeaders, type PrFetchFn } from "./pr.js";

export interface PrStatusSnapshot {
  readonly repo: string;
  readonly number: number;
  readonly url: string;
  readonly title: string;
  readonly state: "open" | "closed";
  readonly merged: boolean;
  readonly draft: boolean;
  readonly updatedAt: string;
}

export async function fetchPullRequestStatus(opts: {
  repo: string;
  number: number;
  token: string;
  fetchFn?: PrFetchFn;
  apiBase?: string;
}): Promise<PrStatusSnapshot> {
  const fetchFn = opts.fetchFn ?? (globalThis.fetch as unknown as PrFetchFn);
  const apiBase = opts.apiBase ?? "https://api.github.com";
  const res = await fetchFn(`${apiBase}/repos/${opts.repo}/pulls/${opts.number}`, {
    method: "GET",
    headers: prApiHeaders(opts.token),
  });
  if (!res.ok) {
    throw new Error(`GitHub PR lookup failed for ${opts.repo}#${opts.number}: ${res.status} ${await res.text()}`);
  }
  const pr = (await res.json()) as {
    html_url: string;
    title: string;
    state: string;
    merged: boolean;
    draft: boolean;
    updated_at: string;
  };
  return {
    repo: opts.repo,
    number: opts.number,
    url: pr.html_url,
    title: pr.title,
    state: pr.state === "closed" ? "closed" : "open",
    merged: Boolean(pr.merged),
    draft: Boolean(pr.draft),
    updatedAt: pr.updated_at,
  };
}

export function describePrStatus(s: PrStatusSnapshot): string {
  const label = s.merged ? "MERGED" : s.state === "closed" ? "CLOSED (not merged)" : s.draft ? "OPEN (draft)" : "OPEN";
  return `${label} — "${s.title}" (updated ${s.updatedAt}) ${s.url}`;
}

export function prIsSettled(s: PrStatusSnapshot): boolean {
  return s.merged || s.state === "closed";
}

export async function resolveReadToken(repo: string, app: GitHubApp | null = getGitHubApp()): Promise<string> {
  if (app) {
    const { tokens, ungranted } = await app.tokensForRepos([repo], READ_PERMISSIONS);
    if (!ungranted.length) return tokens.get(repo.slice(0, repo.indexOf("/")))!.token;
  }
  const pat = process.env.GITHUB_TOKEN;
  if (!pat) {
    throw new Error("no GitHub credential: configure the GitHub App (OE_GITHUB_APP_*) or set GITHUB_TOKEN.");
  }
  return pat;
}
