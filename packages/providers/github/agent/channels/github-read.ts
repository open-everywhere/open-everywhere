import {
  assertSurfaceAllowed,
  bindFrom,
  prApiHeaders,
  resolveConversationReadToken,
  ChannelScopeError,
  type BindableContext,
  type PrFetchFn,
  type RenderedLine,
  type WakeReadAddress,
} from "@open-everywhere/core/agent/adapter-api.js";
import { githubReviewThreadRoot } from "./github-identity.js";

const GITHUB_CHANNEL_DEFAULT_LIMIT = 50;
const GITHUB_THREAD_DEFAULT_LIMIT = 100;
const GITHUB_MAX_PAGE = 100;
const MAX_REVIEW_PAGES = 5;

const API_BASE = "https://api.github.com";

export interface GitHubContainer {
  readonly owner: string;
  readonly repo: string;
  readonly repoFull: string;
  readonly number: number;
}

export function parseGithubContainer(container: string): GitHubContainer | undefined {
  const hash = container.lastIndexOf("#");
  if (hash <= 0) return undefined;
  const repoFull = container.slice(0, hash);
  const rest = container.slice(hash + 1);
  if (!/^[0-9]+$/u.test(rest)) return undefined;
  const parts = repoFull.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return undefined;
  const number = Number(rest);
  if (!Number.isSafeInteger(number) || number <= 0) return undefined;
  return { owner: parts[0], repo: parts[1], repoFull, number };
}

const liveGithubFetch = globalThis.fetch as unknown as PrFetchFn;

async function getJson<T>(fetchFn: PrFetchFn, url: string, token: string): Promise<T> {
  const res = await fetchFn(url, { method: "GET", headers: prApiHeaders(token) });
  if (!res.ok) throw new Error(`read: GitHub GET failed (HTTP ${res.status}) for ${url}.`);
  return (await res.json()) as T;
}

interface RawGitHubUser {
  readonly login?: string;
  readonly type?: string;
}
interface RawIssue {
  readonly title?: string;
  readonly body?: string | null;
  readonly user?: RawGitHubUser;
  readonly created_at?: string;
  readonly comments?: number;
}
interface RawComment {
  readonly id?: number;
  readonly body?: string | null;
  readonly user?: RawGitHubUser;
  readonly created_at?: string;
  readonly in_reply_to_id?: number | null;
}

function authorFields(user: RawGitHubUser | undefined): Pick<RenderedLine, "author" | "authorId" | "bot"> {
  const login = user?.login;
  if (!login) return { author: "(unknown)" };
  return { author: login, ...(user?.type === "Bot" ? { bot: true } : { authorId: login }) };
}

function openingLine(issue: RawIssue): RenderedLine {
  const title = (issue.title ?? "").trim();
  const body = (issue.body ?? "").trim();
  return {
    ...authorFields(issue.user),
    ts: issue.created_at ?? "",
    text: [title, body].filter((part) => part.length > 0).join("\n\n"),
  };
}

function commentLine(comment: RawComment): RenderedLine {
  return { ...authorFields(comment.user), ts: comment.created_at ?? "", text: (comment.body ?? "").trim() };
}

export async function assertGithubContainerAllowed(ctx: BindableContext, target: GitHubContainer): Promise<void> {
  const bound = bindFrom(ctx).target as { owner?: unknown } | undefined;
  const boundOwner = typeof bound?.owner === "string" ? bound.owner : undefined;
  if (boundOwner === undefined || boundOwner.toLowerCase() !== target.owner.toLowerCase()) {
    throw new ChannelScopeError(
      `owner "${target.owner}" is not the owner this turn arrived under (${boundOwner ?? "none"}). A GitHub read ` +
        "reads the conversation its own turn is in.",
    );
  }
  await assertSurfaceAllowed(ctx, "github", target.repo);
}

async function admitContainer(ctx: BindableContext, channel: string): Promise<GitHubContainer> {
  const target = parseGithubContainer(channel);
  if (!target) throw new ChannelScopeError(`"${channel}" is not a GitHub conversation id (expected "owner/repo#number").`);
  await assertGithubContainerAllowed(ctx, target);
  return target;
}

async function fetchIssue(fetchFn: PrFetchFn, token: string, target: GitHubContainer): Promise<RawIssue> {
  return await getJson<RawIssue>(fetchFn, `${API_BASE}/repos/${target.repoFull}/issues/${target.number}`, token);
}

async function fetchRecentComments(
  fetchFn: PrFetchFn,
  token: string,
  target: GitHubContainer,
  total: number,
  limit: number,
): Promise<RawComment[]> {
  const url = (page: number): string =>
    `${API_BASE}/repos/${target.repoFull}/issues/${target.number}/comments?per_page=${GITHUB_MAX_PAGE}&page=${page}`;
  const lastPage = Math.max(1, Math.ceil(total / GITHUB_MAX_PAGE));
  let out = await getJson<RawComment[]>(fetchFn, url(lastPage), token);
  if (!Array.isArray(out)) return [];
  if (out.length < limit && lastPage > 1) {
    const previous = await getJson<RawComment[]>(fetchFn, url(lastPage - 1), token);
    if (Array.isArray(previous)) out = [...previous, ...out];
  }
  return out.slice(-limit);
}

async function fetchReviewComments(fetchFn: PrFetchFn, token: string, target: GitHubContainer): Promise<RawComment[]> {
  const out: RawComment[] = [];
  for (let page = 1; page <= MAX_REVIEW_PAGES; page++) {
    const batch = await getJson<RawComment[]>(
      fetchFn,
      `${API_BASE}/repos/${target.repoFull}/pulls/${target.number}/comments?per_page=${GITHUB_MAX_PAGE}&page=${page}`,
      token,
    );
    if (!Array.isArray(batch) || batch.length === 0) break;
    out.push(...batch);
    if (batch.length < GITHUB_MAX_PAGE) break;
  }
  return out;
}

export function reviewThreadLines(comments: readonly RawComment[], rootId: string): RenderedLine[] {
  const root = Number(rootId);
  return comments.filter((c) => c.id === root || c.in_reply_to_id === root).map((c) => commentLine(c));
}

export const githubReadAdapter = {
  platform: "github" as const,
  wakeAddress(ctx: BindableContext): WakeReadAddress | undefined {
    const container = bindFrom(ctx).anchorChannelId;
    if (!container || parseGithubContainer(container) === undefined) return undefined;
    const threadRoot = githubReviewThreadRoot(ctx);
    return { container, ...(threadRoot ? { threadRoot } : {}) };
  },
  async readChannel(
    ctx: BindableContext,
    channel: string,
    limit?: number,
    fetchFn: PrFetchFn = liveGithubFetch,
  ): Promise<readonly RenderedLine[]> {
    const target = await admitContainer(ctx, channel);
    const effective = Math.min(limit ?? GITHUB_CHANNEL_DEFAULT_LIMIT, GITHUB_MAX_PAGE);
    const token = await resolveConversationReadToken(target.repoFull);
    const issue = await fetchIssue(fetchFn, token, target);
    const total = typeof issue.comments === "number" && issue.comments > 0 ? issue.comments : 0;
    const comments = total === 0 ? [] : await fetchRecentComments(fetchFn, token, target, total, Math.max(1, effective - 1));
    return [openingLine(issue), ...comments.map((c) => commentLine(c))];
  },
  async readThread(
    ctx: BindableContext,
    channel: string,
    threadTs: string,
    limit?: number,
    fetchFn: PrFetchFn = liveGithubFetch,
  ): Promise<readonly RenderedLine[]> {
    const target = await admitContainer(ctx, channel);
    const token = await resolveConversationReadToken(target.repoFull);
    const comments = await fetchReviewComments(fetchFn, token, target);
    return reviewThreadLines(comments, threadTs).slice(-(limit ?? GITHUB_THREAD_DEFAULT_LIMIT));
  },
};
