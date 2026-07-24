import { prApiHeaders, type PrFetchFn } from "./pr.js";

export interface PrActivitySummary {
  readonly reviews: number;
  readonly approvals: number;
  readonly changesRequested: number;
  readonly latestReview?: { readonly author: string; readonly state: string };
  readonly issueComments: number;
  readonly reviewComments: number;
  readonly commits: number;
}

export const EMPTY_PR_ACTIVITY: PrActivitySummary = {
  reviews: 0,
  approvals: 0,
  changesRequested: 0,
  issueComments: 0,
  reviewComments: 0,
  commits: 0,
};

export type PrReviewTally = Pick<PrActivitySummary, "reviews" | "approvals" | "changesRequested" | "latestReview">;

export interface RawPrReview {
  readonly user?: { readonly login?: string };
  readonly state?: string;
}

const MAX_LOGIN_CHARS = 39;
function safeLogin(login: string | undefined): string {
  const s = (login ?? "").replace(/[^A-Za-z0-9._-]/g, "").slice(0, MAX_LOGIN_CHARS);
  return s.length > 0 ? s : "(unknown)";
}

export function summarizeReviews(raw: readonly RawPrReview[]): PrReviewTally {
  let reviews = 0;
  let approvals = 0;
  let changesRequested = 0;
  let latestReview: { author: string; state: string } | undefined;
  for (const r of raw) {
    const state = (r.state ?? "COMMENTED").toUpperCase();
    if (state === "PENDING") continue;
    reviews++;
    if (state === "APPROVED") approvals++;
    if (state === "CHANGES_REQUESTED") changesRequested++;
    latestReview = { author: safeLogin(r.user?.login), state };
  }
  return latestReview ? { reviews, approvals, changesRequested, latestReview } : { reviews, approvals, changesRequested };
}

export async function fetchPrReviews(opts: {
  repo: string;
  number: number;
  token: string;
  fetchFn?: PrFetchFn;
  apiBase?: string;
}): Promise<RawPrReview[]> {
  const fetchFn = opts.fetchFn ?? (globalThis.fetch as unknown as PrFetchFn);
  const apiBase = opts.apiBase ?? "https://api.github.com";
  const res = await fetchFn(`${apiBase}/repos/${opts.repo}/pulls/${opts.number}/reviews?per_page=100`, {
    method: "GET",
    headers: prApiHeaders(opts.token),
  });
  if (!res.ok) {
    throw new Error(`GitHub reviews lookup failed for ${opts.repo}#${opts.number}: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as unknown;
  return Array.isArray(body) ? (body as RawPrReview[]) : [];
}

export function prHasActivity(a: PrActivitySummary): boolean {
  return a.reviews > 0 || a.issueComments > 0 || a.reviewComments > 0 || a.commits > 0;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function describeActivity(a: PrActivitySummary): string {
  const parts: string[] = [];
  if (a.approvals > 0) parts.push(plural(a.approvals, "approval"));
  if (a.changesRequested > 0) parts.push(plural(a.changesRequested, "change request"));
  const otherReviews = a.reviews - a.approvals - a.changesRequested;
  if (otherReviews > 0) parts.push(plural(otherReviews, "review"));
  if (a.issueComments > 0) parts.push(plural(a.issueComments, "comment"));
  if (a.reviewComments > 0) parts.push(`${a.reviewComments} inline`);
  if (a.commits > 0) parts.push(plural(a.commits, "commit"));
  return parts.length > 0 ? `activity: ${parts.join(", ")}` : "";
}
