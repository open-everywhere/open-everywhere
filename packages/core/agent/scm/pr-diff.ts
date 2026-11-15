import { prApiHeaders, type PrFetchFn } from "./pr.js";

export const MAX_DIFF_CHARS = 100_000;

const MAX_DIFF_FILES = 500;

export interface PrDiffSnapshot {
  readonly repo: string;
  readonly number: number;
  readonly headSha: string;
  readonly baseRef: string;
  readonly diff: string;
  readonly diffClipped: boolean;
  readonly diffChars: number;
  readonly files: readonly string[];
  readonly filesCapped: boolean;
}

export function filesFromUnifiedDiff(diff: string): string[] {
  const out = new Set<string>();
  for (const m of diff.matchAll(/^diff --git (?:"?a\/(.+?)"?) (?:"?b\/(.+?)"?)$/gmu)) {
    if (m[1]) out.add(m[1]);
    if (m[2]) out.add(m[2]);
  }
  return [...out].sort((a, b) => a.localeCompare(b));
}

async function fetchPrRefs(opts: {
  repo: string;
  number: number;
  token: string;
  fetchFn: PrFetchFn;
  apiBase: string;
}): Promise<{ headSha: string; baseRef: string }> {
  const res = await opts.fetchFn(`${opts.apiBase}/repos/${opts.repo}/pulls/${opts.number}`, {
    method: "GET",
    headers: prApiHeaders(opts.token),
  });
  if (!res.ok) throw new Error(`GitHub PR lookup failed for ${opts.repo}#${opts.number}: ${res.status} ${await res.text()}`);
  const pr = (await res.json()) as { head?: { sha?: string }; base?: { ref?: string } };
  const headSha = pr.head?.sha;
  if (!headSha) throw new Error(`GitHub returned no head sha for ${opts.repo}#${opts.number} — the facts artifact cannot be located without it`);
  return { headSha, baseRef: pr.base?.ref ?? "(unknown)" };
}

export async function fetchPrDiff(opts: {
  repo: string;
  number: number;
  token: string;
  fetchFn?: PrFetchFn;
  apiBase?: string;
}): Promise<PrDiffSnapshot> {
  const fetchFn = opts.fetchFn ?? (globalThis.fetch as unknown as PrFetchFn);
  const apiBase = opts.apiBase ?? "https://api.github.com";
  const { headSha, baseRef } = await fetchPrRefs({ repo: opts.repo, number: opts.number, token: opts.token, fetchFn, apiBase });

  const res = await fetchFn(`${apiBase}/repos/${opts.repo}/pulls/${opts.number}`, {
    method: "GET",
    headers: { ...prApiHeaders(opts.token), accept: "application/vnd.github.v3.diff" },
  });
  if (!res.ok) {
    throw new Error(
      `GitHub diff read failed for ${opts.repo}#${opts.number}: ${res.status} ${await res.text()}` +
        (res.status === 406 ? " (406 means the diff is too large for GitHub to render — review it in the UI; nothing here may claim to have read it)" : ""),
    );
  }
  const raw = await res.text();
  const files = filesFromUnifiedDiff(raw);
  return {
    repo: opts.repo,
    number: opts.number,
    headSha,
    baseRef,
    diff: raw.length > MAX_DIFF_CHARS ? `${raw.slice(0, MAX_DIFF_CHARS)}\n…[diff clipped at ${MAX_DIFF_CHARS} chars of ${raw.length}]` : raw,
    diffClipped: raw.length > MAX_DIFF_CHARS,
    diffChars: raw.length,
    files: files.slice(0, MAX_DIFF_FILES),
    filesCapped: files.length > MAX_DIFF_FILES,
  };
}
