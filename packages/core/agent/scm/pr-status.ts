import type { GitHubApp } from "./app.js";
import { getGitHubApp } from "./provider.js";
import { githubAuthMode, resolveRepoToken } from "./credential.js";
import { CONVERSATION_READ_PERMISSIONS, PR_READ_PERMISSIONS } from "./mint.js";
import type { MintPermissions } from "./types.js";
import { prApiHeaders, type PrFetchFn } from "./pr.js";
import {
  describeActivity,
  fetchPrReviews,
  prHasActivity,
  summarizeReviews,
  type PrActivitySummary,
} from "./pr-activity.js";

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
  readonly activity?: PrActivitySummary;
  readonly repoPrivate?: boolean;
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
    base?: { repo?: { private?: boolean } };
    comments?: number;
    review_comments?: number;
    commits?: number;
  };
  const counts = {
    issueComments: num(pr.comments),
    reviewComments: num(pr.review_comments),
    commits: num(pr.commits),
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
    activity: { reviews: 0, approvals: 0, changesRequested: 0, ...counts },
    ...(typeof pr.base?.repo?.private === "boolean" ? { repoPrivate: pr.base.repo.private } : {}),
  };
  const headSha = pr.head?.sha;
  if (!headSha) return base;
  const [runs, reviews] = await Promise.all([
    fetchCheckRuns({ repo: opts.repo, ref: headSha, token: opts.token, fetchFn, apiBase }).catch(() => null),
    fetchPrReviews({ repo: opts.repo, number: opts.number, token: opts.token, fetchFn, apiBase }).catch(() => null),
  ]);
  const activity: PrActivitySummary = { ...summarizeReviews(reviews ?? []), ...counts };
  const checks = runs && runs.length > 0 ? summarizeChecks(runs) : undefined;
  return checks ? { ...base, checks, activity } : { ...base, activity };
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
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
  const checks = s.checks ? ` — ${describeChecks(s.checks)}` : "";
  const act = s.activity && prHasActivity(s.activity) ? ` — ${describeActivity(s.activity)}` : "";
  return `${prStateLabel(s)} — "${s.title}" (updated ${s.updatedAt}) ${s.url}${checks}${act}`;
}

export function prStateLabel(s: PrStatusSnapshot): string {
  return s.merged ? "MERGED" : s.state === "closed" ? "CLOSED (not merged)" : s.draft ? "OPEN (draft)" : "OPEN";
}

export function describePrStatusStructural(s: PrStatusSnapshot): string {
  const checks = s.checks ? ` — ${describeChecks(s.checks)}` : "";
  const act = s.activity && prHasActivity(s.activity) ? ` — ${describeActivity(s.activity)}` : "";
  return `${prStateLabel(s)} (updated ${s.updatedAt}) ${s.url}${checks}${act}`;
}

export function prIsSettled(s: PrStatusSnapshot): boolean {
  return s.merged || s.state === "closed";
}

export async function resolveReadToken(repo: string, app: GitHubApp | null = getGitHubApp()): Promise<string> {
  return await resolveTokenWith(repo, PR_READ_PERMISSIONS, app);
}

export async function resolveConversationReadToken(
  repo: string,
  app: GitHubApp | null = getGitHubApp(),
): Promise<string> {
  return await resolveTokenWith(repo, CONVERSATION_READ_PERMISSIONS, app);
}

async function resolveTokenWith(
  repo: string,
  permissions: MintPermissions,
  app: GitHubApp | null,
): Promise<string> {
  return resolveRepoToken(repo, permissions, { app });
}

export async function resolveSurfaceReadToken(
  repo: string,
  app: GitHubApp | null = getGitHubApp(),
): Promise<string> {
  if (githubAuthMode() === "token") {
    throw new Error(
      `the GitHub conversation surface needs the GitHub App, and this deployment signs in with a personal access token (github.auth "token"), so ${repo} cannot be read here.`,
    );
  }
  return resolveRepoToken(repo, CONVERSATION_READ_PERMISSIONS, { app });
}
