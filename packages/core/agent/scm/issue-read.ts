import { prApiHeaders, type PrFetchFn } from "./pr.js";
import { ingestUntrusted } from "../access/untrusted.js";

export const MAX_ISSUE_COMMENTS = 30;
export const MAX_COMMENT_CHARS = 2000;
export const MAX_OPENING_BODY_CHARS = 8000;
const COMMENTS_PER_PAGE = 100;

export interface GithubIssueComment {
  readonly author: string;
  readonly createdAt: string;
  readonly body: string;
}

export interface GithubIssueDigest {
  readonly repo: string;
  readonly number: number;
  readonly kind: "issue" | "pull_request";
  readonly title: string;
  readonly state: string;
  readonly author: string;
  readonly url?: string;
  readonly body: string;
  readonly repoPrivate?: boolean;
  readonly comments: readonly GithubIssueComment[];
  readonly totalComments: number;
  readonly truncation: {
    readonly truncated: boolean;
    readonly commentsDropped: number;
    readonly bodiesClipped: number;
    readonly maxCommentChars: number;
    readonly maxOpeningBodyChars: number;
  };
}

interface RawUser {
  login?: unknown;
}
interface RawIssue {
  title?: unknown;
  state?: unknown;
  body?: unknown;
  html_url?: unknown;
  user?: RawUser;
  comments?: unknown;
  pull_request?: unknown;
}
interface RawComment {
  user?: RawUser;
  body?: unknown;
  created_at?: unknown;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const login = (u: RawUser | undefined): string => (typeof u?.login === "string" && u.login.length > 0 ? u.login : "(unknown)");

function clip(text: string, max: number, counter: { n: number }): string {
  const t = text.trim();
  if (t.length <= max) return t;
  counter.n += 1;
  return `${t.slice(0, max)}… [clipped, ${t.length} chars total]`;
}

async function getJson<T>(fetchFn: PrFetchFn, url: string, token: string): Promise<T> {
  const res = await fetchFn(url, { method: "GET", headers: prApiHeaders(token) });
  if (!res.ok) {
    if (res.status === 404 || res.status === 410) {
      throw new Error(`GitHub has no readable issue at ${url} (${res.status}): it does not exist, or this deployment's App installation cannot see it.`);
    }
    throw new Error(`GitHub issue read failed for ${url}: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as T;
}

async function fetchRepoPrivate(fetchFn: PrFetchFn, url: string, token: string): Promise<boolean | undefined> {
  try {
    const res = await fetchFn(url, { method: "GET", headers: prApiHeaders(token) });
    if (!res.ok) return undefined;
    const raw = (await res.json()) as { private?: unknown };
    return typeof raw.private === "boolean" ? raw.private : undefined;
  } catch {
    return undefined;
  }
}

export async function fetchGithubIssue(opts: {
  repo: string;
  number: number;
  token: string;
  fetchFn?: PrFetchFn;
  apiBase?: string;
}): Promise<GithubIssueDigest> {
  const fetchFn = opts.fetchFn ?? (globalThis.fetch as unknown as PrFetchFn);
  const apiBase = opts.apiBase ?? "https://api.github.com";
  const { repo, number, token } = opts;
  const base = `${apiBase}/repos/${repo}/issues/${number}`;
  const clipped = { n: 0 };

  const issue = await getJson<RawIssue>(fetchFn, base, token);
  const repoPrivate = await fetchRepoPrivate(fetchFn, `${apiBase}/repos/${repo}`, token);
  const totalComments = typeof issue.comments === "number" && issue.comments > 0 ? issue.comments : 0;

  let raw: RawComment[] = [];
  if (totalComments > 0) {
    const page = (n: number): Promise<RawComment[]> =>
      getJson<RawComment[]>(fetchFn, `${base}/comments?per_page=${COMMENTS_PER_PAGE}&page=${n}`, token).then((r) => (Array.isArray(r) ? r : []));
    const lastPage = Math.ceil(totalComments / COMMENTS_PER_PAGE);
    raw = await page(lastPage);
    if (raw.length < MAX_ISSUE_COMMENTS && lastPage > 1) raw = [...(await page(lastPage - 1)), ...raw];
  }
  const kept = raw.slice(-MAX_ISSUE_COMMENTS);
  const comments = kept.map((c) => ({
    author: login(c.user),
    createdAt: str(c.created_at),
    body: clip(str(c.body), MAX_COMMENT_CHARS, clipped),
  }));
  const commentsDropped = Math.max(0, totalComments - comments.length);
  const url = str(issue.html_url);

  return {
    repo,
    number,
    kind: typeof issue.pull_request === "object" && issue.pull_request !== null ? "pull_request" : "issue",
    title: str(issue.title) || "(untitled)",
    state: str(issue.state) || "unknown",
    author: login(issue.user),
    ...(url ? { url } : {}),
    body: clip(str(issue.body), MAX_OPENING_BODY_CHARS, clipped),
    ...(repoPrivate !== undefined ? { repoPrivate } : {}),
    comments,
    totalComments,
    truncation: {
      truncated: commentsDropped > 0 || clipped.n > 0,
      commentsDropped,
      bodiesClipped: clipped.n,
      maxCommentChars: MAX_COMMENT_CHARS,
      maxOpeningBodyChars: MAX_OPENING_BODY_CHARS,
    },
  };
}

export function renderGithubIssueForModel(d: GithubIssueDigest): string {
  const ingestion = {
    kind: "github",
    label: `read_github_issue:${d.repo}`,
    ...(d.repoPrivate !== undefined ? { repoPrivate: d.repoPrivate } : {}),
  } as const;
  const kindWord = d.kind === "pull_request" ? "Pull request" : "Issue";
  const out: string[] = [`${kindWord} ${d.repo}#${d.number} — ${d.state}, opened by ${d.author}${d.url ? ` (${d.url})` : ""}`];
  out.push("Title:", ingestUntrusted(d.title, { source: `github ${d.kind} title by ${d.author}`, ingestion }));
  if (d.body) out.push("Body:", ingestUntrusted(d.body, { source: `github ${d.kind} body by ${d.author}`, ingestion }));
  else out.push("Body: (empty)");

  const older = d.truncation.commentsDropped > 0 ? `; ${d.truncation.commentsDropped} older not shown` : "";
  out.push("", `Comments (${d.comments.length} newest of ${d.totalComments}${older}, oldest first):`);
  if (d.comments.length === 0) out.push("  (none)");
  d.comments.forEach((c, i) => {
    const head = `  [${i + 1}] ${c.author}${c.createdAt ? ` at ${c.createdAt}` : ""}`;
    if (c.body) out.push(`${head}:`, ingestUntrusted(c.body, { source: `github comment by ${c.author}`, ingestion }));
    else out.push(`${head} (empty)`);
  });

  if (d.truncation.bodiesClipped > 0) {
    out.push(
      "",
      `Note: ${d.truncation.bodiesClipped} bod${d.truncation.bodiesClipped === 1 ? "y was" : "ies were"} clipped (opening post at ${d.truncation.maxOpeningBodyChars} chars, comments at ${d.truncation.maxCommentChars}).`,
    );
  }
  return out.join("\n");
}
