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
  readonly checks?: PrChecksSummary;
}

export interface CheckRun {
  readonly name: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly summary: string;
}

export interface PrChecksSummary {
  readonly total: number;
  readonly byConclusion: Readonly<Record<string, number>>;
  readonly failing: readonly string[];
  readonly failingTruncated: boolean;
  readonly pending: number;
}

export const CHECK_FAILURE_CONCLUSIONS: ReadonlySet<string> = new Set([
  "failure",
  "timed_out",
  "action_required",
  "cancelled",
  "stale",
]);

export const MAX_FAILING_CHECK_NAMES = 20;

export function summarizeChecks(runs: readonly CheckRun[]): PrChecksSummary {
  const byConclusion: Record<string, number> = {};
  const failing: string[] = [];
  let pending = 0;
  for (const r of runs) {
    const bucket = r.conclusion ?? (r.status === "completed" ? "neutral" : "pending");
    byConclusion[bucket] = (byConclusion[bucket] ?? 0) + 1;
    if (r.conclusion !== null && CHECK_FAILURE_CONCLUSIONS.has(r.conclusion)) failing.push(r.name);
    if (r.conclusion === null && r.status !== "completed") pending++;
  }
  return {
    total: runs.length,
    byConclusion,
    failing: failing.slice(0, MAX_FAILING_CHECK_NAMES),
    failingTruncated: failing.length > MAX_FAILING_CHECK_NAMES,
    pending,
  };
}

export async function fetchCheckRuns(opts: {
  repo: string;
  ref: string;
  token: string;
  fetchFn?: PrFetchFn;
  apiBase?: string;
}): Promise<CheckRun[]> {
  const fetchFn = opts.fetchFn ?? (globalThis.fetch as unknown as PrFetchFn);
  const apiBase = opts.apiBase ?? "https://api.github.com";
  const res = await fetchFn(`${apiBase}/repos/${opts.repo}/commits/${opts.ref}/check-runs?per_page=100`, {
    method: "GET",
    headers: prApiHeaders(opts.token),
  });
  if (!res.ok) {
    throw new Error(`GitHub check-runs lookup failed for ${opts.repo}@${opts.ref}: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as {
    check_runs?: { name?: string; status?: string; conclusion?: string | null; output?: { title?: string; summary?: string } }[];
  };
  return (body.check_runs ?? []).map((c) => ({
    name: c.name ?? "(unnamed)",
    status: c.status ?? "unknown",
    conclusion: c.conclusion ?? null,
    summary: (c.output?.summary ?? c.output?.title ?? "").trim(),
  }));
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
    head?: { sha?: string };
  };
  const base: PrStatusSnapshot = {
    repo: opts.repo,
    number: opts.number,
    url: pr.html_url,
    title: pr.title,
    state: pr.state === "closed" ? "closed" : "open",
    merged: Boolean(pr.merged),
    draft: Boolean(pr.draft),
    updatedAt: pr.updated_at,
  };
  const headSha = pr.head?.sha;
  if (!headSha) return base;
  try {
    const runs = await fetchCheckRuns({ repo: opts.repo, ref: headSha, token: opts.token, fetchFn, apiBase });
    if (runs.length === 0) return base;
    return { ...base, checks: summarizeChecks(runs) };
  } catch {
    return base;
  }
}

export function describeChecks(c: PrChecksSummary): string {
  const parts: string[] = [];
  const ok = (c.byConclusion.success ?? 0) + (c.byConclusion.neutral ?? 0) + (c.byConclusion.skipped ?? 0);
  if (ok > 0) parts.push(`${ok} ok`);
  if (c.failing.length > 0 || c.failingTruncated) {
    const names = c.failing.length > 0 ? ` (${c.failing.join(", ")}${c.failingTruncated ? ", …" : ""})` : "";
    const failCount = c.total - ok - c.pending;
    parts.push(`${failCount} failing${names}`);
  }
  if (c.pending > 0) parts.push(`${c.pending} pending`);
  return `checks: ${parts.length > 0 ? parts.join(", ") : `${c.total} run(s)`}`;
}

export function describePrStatus(s: PrStatusSnapshot): string {
  const label = s.merged ? "MERGED" : s.state === "closed" ? "CLOSED (not merged)" : s.draft ? "OPEN (draft)" : "OPEN";
  const checks = s.checks ? ` — ${describeChecks(s.checks)}` : "";
  return `${label} — "${s.title}" (updated ${s.updatedAt}) ${s.url}${checks}`;
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
