import { getGitHubApp, repoAllowed } from "./provider.js";
import type { GitHubApp } from "./app.js";
import { CONVERSATION_READ_PERMISSIONS } from "./mint.js";
import { prApiHeaders, type PrFetchFn } from "./pr.js";
import { resolveAccessFor } from "../access/request.js";
import type { BindableContext } from "../identity/binding.js";
import { registerCoreWorkSearchAdapter, type WorkSearchAdapter, type WorkSearchHit } from "../channels/work-search.js";
import type { Domain } from "../memory/domain.js";

export interface GithubSearchOpts {
  readonly fetchFn?: PrFetchFn;
  readonly apiBase?: string;
  readonly app?: GitHubApp | null;
}

interface RawSearchItem {
  readonly number?: unknown;
  readonly title?: unknown;
  readonly html_url?: unknown;
  readonly repository_url?: unknown;
}

export async function searchGithubIssues(
  repos: readonly string[],
  query: string,
  limit: number,
  opts: GithubSearchOpts = {},
): Promise<readonly WorkSearchHit[]> {
  const app = opts.app === undefined ? getGitHubApp() : opts.app;
  if (!app) throw new Error("no GitHub App configured — GitHub search is unavailable.");
  const { tokens, ungranted } = await app.tokensForRepos(repos, CONVERSATION_READ_PERMISSIONS);
  if (tokens.size === 0) {
    throw new Error(`no installation token for any of this domain's granted repos (${(ungranted.length ? ungranted : repos).join(", ")}).`);
  }
  const fetchFn = opts.fetchFn ?? (globalThis.fetch as unknown as PrFetchFn);
  const apiBase = opts.apiBase ?? "https://api.github.com";
  const perPage = Math.min(Math.max(limit, 1), 100);

  const byOwner = new Map<string, string[]>();
  for (const r of repos) {
    const slash = r.indexOf("/");
    if (slash <= 0) continue;
    const owner = r.slice(0, slash);
    if (!tokens.has(owner)) continue;
    const list = byOwner.get(owner);
    if (list) list.push(r);
    else byOwner.set(owner, [r]);
  }

  const hits: WorkSearchHit[] = [];
  for (const [owner, ownerRepos] of byOwner) {
    const token = tokens.get(owner)!.token;
    const qualifiers = ownerRepos.map((r) => `repo:${r}`).join(" ");
    const q = `${query} ${qualifiers}`.trim();
    const url = `${apiBase}/search/issues?q=${encodeURIComponent(q)}&per_page=${perPage}`;
    const res = await fetchFn(url, { method: "GET", headers: prApiHeaders(token) });
    if (!res.ok) throw new Error(`GitHub search failed for "${owner}": ${res.status} ${await res.text()}`);
    const data = (await res.json()) as { items?: unknown };
    const items = Array.isArray(data.items) ? (data.items as RawSearchItem[]) : [];
    for (const item of items) {
      if (typeof item.number !== "number" || typeof item.repository_url !== "string") continue;
      const repoMatch = /\/repos\/(.+)$/.exec(item.repository_url);
      const repo = repoMatch ? repoMatch[1] : `${owner}/?`;
      if (!repoAllowed(repo, repos)) continue;
      hits.push({
        connector: "github",
        id: `${repo}#${item.number}`,
        title: typeof item.title === "string" && item.title.length > 0 ? item.title : "(untitled)",
        ...(typeof item.html_url === "string" ? { url: item.html_url } : {}),
      });
    }
  }
  return hits.slice(0, limit);
}

export const githubWorkSearchAdapter: WorkSearchAdapter = {
  connector: "github",
  async search(ctx: BindableContext, _domain: Domain, query: string, opts: { limit: number; insideDomain: boolean }): Promise<readonly WorkSearchHit[]> {
    const repos = resolveAccessFor(ctx).repos;
    if (repos.length === 0) throw new Error("this domain holds no GitHub repo grant.");
    return searchGithubIssues(repos, query, opts.limit);
  },
};

let registered = false;

export function registerGithubWorkSearch(): void {
  if (registered) return;
  registered = true;
  registerCoreWorkSearchAdapter(githubWorkSearchAdapter);
}
