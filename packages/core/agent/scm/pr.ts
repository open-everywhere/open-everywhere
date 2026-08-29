import { withRetryAfterLoose, type RetryPolicy } from "../channels/rate-limit-retry.js";

export type PrFetchFn = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; text(): Promise<string>; json(): Promise<unknown> }>;

export interface PrOutcome {
  url: string;
  number: number;
  updated: boolean;
}

export function prApiHeaders(token: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
  };
}

export async function createOrUpdatePullRequest(opts: {
  repo: string;
  head: string;
  base: string;
  title: string;
  body: string;
  token: string;
  fetchFn?: PrFetchFn;
  apiBase?: string;
  retry?: RetryPolicy;
}): Promise<PrOutcome> {
  const fetchFn = opts.fetchFn ?? (globalThis.fetch as unknown as PrFetchFn);
  const apiBase = opts.apiBase ?? "https://api.github.com";

  const res = await withRetryAfterLoose(
    () =>
      fetchFn(`${apiBase}/repos/${opts.repo}/pulls`, {
        method: "POST",
        headers: prApiHeaders(opts.token),
        body: JSON.stringify({ title: opts.title, body: opts.body, head: opts.head, base: opts.base }),
      }),
    { ...opts.retry, surface: "github", operation: "pulls.create" },
  );
  if (res.ok) {
    const pr = (await res.json()) as { html_url: string; number: number };
    return { url: pr.html_url, number: pr.number, updated: false };
  }

  const text = await res.text();
  if (res.status === 422 && text.includes("A pull request already exists")) {
    const owner = opts.repo.slice(0, opts.repo.indexOf("/"));
    const q = await withRetryAfterLoose(
      () =>
        fetchFn(`${apiBase}/repos/${opts.repo}/pulls?head=${encodeURIComponent(`${owner}:${opts.head}`)}&state=open`, {
          method: "GET",
          headers: prApiHeaders(opts.token),
        }),
      { ...opts.retry, surface: "github", operation: "pulls.list" },
    );
    if (q.ok) {
      const list = (await q.json()) as { html_url: string; number: number }[];
      if (list.length) {
        const number = list[0].number;
        const patch = await withRetryAfterLoose(
          () =>
            fetchFn(`${apiBase}/repos/${opts.repo}/pulls/${number}`, {
              method: "PATCH",
              headers: prApiHeaders(opts.token),
              body: JSON.stringify({ title: opts.title, body: opts.body }),
            }),
          { ...opts.retry, surface: "github", operation: "pulls.update" },
        );
        if (!patch.ok) throw new Error(`GitHub PR update failed: ${patch.status} ${await patch.text()}`);
        const pr = (await patch.json()) as { html_url: string; number: number };
        return { url: pr.html_url, number: pr.number, updated: true };
      }
    }
  }
  throw new Error(`GitHub PR creation failed: ${res.status} ${text}`);
}
