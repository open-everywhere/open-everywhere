import { prApiHeaders, type PrFetchFn } from "./pr.js";
import { fetchCheckRuns, summarizeChecks, type CheckRun, type PrChecksSummary } from "./pr-status.js";
import { ingestUntrusted } from "../access/untrusted.js";

export const MAX_REVIEWS = 30;
export const MAX_REVIEW_COMMENTS = 50;
const MAX_ISSUE_COMMENTS = 50;
const MAX_CHECKS = 50;
export const MAX_BODY_CHARS = 2000;

export interface PrFeedbackReview {
  readonly author: string;
  readonly state: string;
  readonly body: string;
}

export interface PrFeedbackReviewComment {
  readonly path: string;
  readonly line: number | null;
  readonly author: string;
  readonly body: string;
}

export interface PrFeedbackIssueComment {
  readonly author: string;
  readonly body: string;
}

export interface PrFeedbackCheck {
  readonly name: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly summary: string;
}

export interface PrFeedbackTruncation {
  readonly truncated: boolean;
  readonly reviewsDropped: number;
  readonly reviewCommentsDropped: number;
  readonly issueCommentsDropped: number;
  readonly checksDropped: number;
  readonly bodiesClipped: number;
  readonly maxBodyChars: number;
}

export interface PrFeedbackDigest {
  readonly repo: string;
  readonly number: number;
  readonly reviews: readonly PrFeedbackReview[];
  readonly reviewComments: readonly PrFeedbackReviewComment[];
  readonly issueComments: readonly PrFeedbackIssueComment[];
  readonly checks: readonly PrFeedbackCheck[];
  readonly checksSummary: PrChecksSummary;
  readonly truncation: PrFeedbackTruncation;
  readonly repoPrivate?: boolean;
  readonly title?: string;
  readonly url?: string;
}

interface RawUser {
  login?: string;
}
interface RawReview {
  user?: RawUser;
  state?: string;
  body?: string;
}
interface RawReviewComment {
  path?: string;
  line?: number | null;
  original_line?: number | null;
  user?: RawUser;
  body?: string;
}
interface RawIssueComment {
  user?: RawUser;
  body?: string;
}

function clip(text: string | undefined, counter: { n: number }): string {
  const t = (text ?? "").trim();
  if (t.length <= MAX_BODY_CHARS) return t;
  counter.n += 1;
  return `${t.slice(0, MAX_BODY_CHARS)}… [clipped, ${t.length} chars total]`;
}

async function getJson<T>(fetchFn: PrFetchFn, url: string, token: string): Promise<T> {
  const res = await fetchFn(url, { method: "GET", headers: prApiHeaders(token) });
  if (!res.ok) {
    throw new Error(`GitHub feedback read failed for ${url}: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as T;
}

export async function fetchPrFeedback(opts: {
  repo: string;
  number: number;
  token: string;
  fetchFn?: PrFetchFn;
  apiBase?: string;
}): Promise<PrFeedbackDigest> {
  const fetchFn = opts.fetchFn ?? (globalThis.fetch as unknown as PrFetchFn);
  const apiBase = opts.apiBase ?? "https://api.github.com";
  const { repo, number, token } = opts;
  const bodies = { n: 0 };

  const pr = await getJson<{ head?: { sha?: string }; base?: { repo?: { private?: boolean } }; title?: unknown; html_url?: unknown }>(
    fetchFn,
    `${apiBase}/repos/${repo}/pulls/${number}`,
    token,
  );
  const [rawReviews, rawReviewComments, rawIssueComments] = await Promise.all([
    getJson<RawReview[]>(fetchFn, `${apiBase}/repos/${repo}/pulls/${number}/reviews?per_page=100`, token),
    getJson<RawReviewComment[]>(fetchFn, `${apiBase}/repos/${repo}/pulls/${number}/comments?per_page=100`, token),
    getJson<RawIssueComment[]>(fetchFn, `${apiBase}/repos/${repo}/issues/${number}/comments?per_page=100`, token),
  ]);

  const reviewsAll = (rawReviews ?? []).filter((r) => {
    const state = (r.state ?? "").toUpperCase();
    if (state === "PENDING") return false;
    if (state === "COMMENTED" && !(r.body ?? "").trim()) return false;
    return true;
  });
  const reviews = mostRecent(reviewsAll, MAX_REVIEWS).map((r) => ({
    author: r.user?.login ?? "(unknown)",
    state: (r.state ?? "COMMENTED").toUpperCase(),
    body: clip(r.body, bodies),
  }));

  const reviewComments = mostRecent(rawReviewComments ?? [], MAX_REVIEW_COMMENTS).map((c) => ({
    path: c.path ?? "(unknown)",
    line: c.line ?? c.original_line ?? null,
    author: c.user?.login ?? "(unknown)",
    body: clip(c.body, bodies),
  }));

  const issueComments = mostRecent(rawIssueComments ?? [], MAX_ISSUE_COMMENTS).map((c) => ({
    author: c.user?.login ?? "(unknown)",
    body: clip(c.body, bodies),
  }));

  let runs: CheckRun[] = [];
  const headSha = pr.head?.sha;
  if (headSha) {
    try {
      runs = await fetchCheckRuns({ repo, ref: headSha, token, fetchFn, apiBase });
    } catch {
      runs = [];
    }
  }
  const checksSummary = summarizeChecks(runs);
  const failingNames = new Set(checksSummary.failing);
  const checks = runs.slice(0, MAX_CHECKS).map((r) => ({
    name: r.name,
    status: r.status,
    conclusion: r.conclusion,
    summary: failingNames.has(r.name) ? clip(r.summary, bodies) : "",
  }));

  const reviewCommentsDropped = Math.max(0, (rawReviewComments ?? []).length - MAX_REVIEW_COMMENTS);
  const issueCommentsDropped = Math.max(0, (rawIssueComments ?? []).length - MAX_ISSUE_COMMENTS);
  const reviewsDropped = Math.max(0, reviewsAll.length - MAX_REVIEWS);
  const checksDropped = Math.max(0, runs.length - MAX_CHECKS);

  const truncation: PrFeedbackTruncation = {
    truncated: bodies.n > 0 || reviewsDropped > 0 || reviewCommentsDropped > 0 || issueCommentsDropped > 0 || checksDropped > 0,
    reviewsDropped,
    reviewCommentsDropped,
    issueCommentsDropped,
    checksDropped,
    bodiesClipped: bodies.n,
    maxBodyChars: MAX_BODY_CHARS,
  };

  const repoPrivate = pr.base?.repo?.private;
  const title = typeof pr.title === "string" && pr.title.length > 0 ? pr.title : undefined;
  const url = typeof pr.html_url === "string" && pr.html_url.length > 0 ? pr.html_url : undefined;
  return {
    repo,
    number,
    reviews,
    reviewComments,
    issueComments,
    checks,
    checksSummary,
    truncation,
    ...(typeof repoPrivate === "boolean" ? { repoPrivate } : {}),
    ...(title !== undefined ? { title } : {}),
    ...(url !== undefined ? { url } : {}),
  };
}

function mostRecent<T>(items: readonly T[], max: number): T[] {
  return items.length <= max ? [...items] : items.slice(items.length - max);
}

function truncNote(n: number, unit: string): string {
  return n > 0 ? `, ${n} older ${unit} dropped` : "";
}

export function renderPrFeedbackForModel(d: PrFeedbackDigest): string {
  const ingestion = {
    kind: "github",
    label: `get_pr_feedback:${d.repo}`,
    ...(d.repoPrivate !== undefined ? { repoPrivate: d.repoPrivate } : {}),
  } as const;
  const out: string[] = [`PR feedback for ${d.repo}#${d.number}`];

  out.push("", `Reviews (${d.reviews.length}${truncNote(d.truncation.reviewsDropped, "reviews")}):`);
  if (d.reviews.length === 0) out.push("  (none)");
  d.reviews.forEach((r, i) => {
    const head = `  [${i + 1}] ${r.author} — ${r.state}`;
    if (r.body.trim()) out.push(`${head}:`, ingestUntrusted(r.body, { source: `pr review by ${r.author}`, ingestion }));
    else out.push(`${head} (no comment)`);
  });

  out.push("", `Inline review comments (${d.reviewComments.length}${truncNote(d.truncation.reviewCommentsDropped, "comments")}):`);
  if (d.reviewComments.length === 0) out.push("  (none)");
  d.reviewComments.forEach((c, i) => {
    const loc = `${c.path}:${c.line ?? "?"}`;
    const head = `  [${i + 1}] ${loc} — ${c.author}`;
    if (c.body.trim()) out.push(`${head}:`, ingestUntrusted(c.body, { source: `pr review comment by ${c.author} on ${loc}`, ingestion }));
    else out.push(`${head} (no body)`);
  });

  out.push("", `Issue-thread comments (${d.issueComments.length}${truncNote(d.truncation.issueCommentsDropped, "comments")}):`);
  if (d.issueComments.length === 0) out.push("  (none)");
  d.issueComments.forEach((c, i) => {
    const head = `  [${i + 1}] ${c.author}`;
    if (c.body.trim()) out.push(`${head}:`, ingestUntrusted(c.body, { source: `pr comment by ${c.author}`, ingestion }));
    else out.push(`${head} (empty)`);
  });

  const s = d.checksSummary;
  const byConclusion = Object.entries(s.byConclusion).map(([k, v]) => `${k}:${v}`).join(", ") || "none";
  out.push(
    "",
    `Checks: ${s.total} total (${byConclusion})${s.pending ? `, ${s.pending} pending` : ""}` +
      `${s.failing.length ? `; failing: ${s.failing.join(", ")}${s.failingTruncated ? " (…more)" : ""}` : ""}`,
  );
  d.checks.forEach((c) => {
    const head = `  - ${c.name}: ${c.status}${c.conclusion ? `/${c.conclusion}` : ""}`;
    if (c.summary.trim()) out.push(`${head} —`, ingestUntrusted(c.summary, { source: `pr check ${c.name}`, ingestion }));
    else out.push(head);
  });

  if (d.truncation.truncated) {
    out.push(
      "",
      `Note: this digest was truncated (bodies clipped at ${d.truncation.maxBodyChars} chars${
        d.truncation.checksDropped ? `; ${d.truncation.checksDropped} checks dropped` : ""
      }). Re-read a specific item on GitHub if you need the full text.`,
    );
  }
  return out.join("\n");
}
