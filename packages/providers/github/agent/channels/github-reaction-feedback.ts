import {
  buildIngestedReaction,
  ingestReaction,
  liveReactionSink,
  readAudit,
  resolvePartition,
  REACTION_FEEDBACK_ACTION,
  type ReactionIngestOutcome,
  type PrFetchFn,
  type ReactionSinkDeps,
} from "@open-everywhere/core/agent/adapter-api.js";
import { buildGitHubAuth } from "./github-identity.js";
import { GITHUB_API_BASE, installationTokenFor } from "./github-post-arm.js";
import { getJson, liveGithubReadFetch } from "./github-read.js";

const POLL_EVENT_TYPES: ReadonlySet<string> = new Set(["issue_comment", "issues"]);

export interface GitHubReactionPollTarget {
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
  readonly installationId?: number;
  readonly repoPrivate?: boolean;
}

export interface GitHubPolledComment {
  readonly id: number;
  readonly authorLogin?: string;
  readonly authorType?: string;
  readonly reactionCount?: number;
}

export interface GitHubPolledReaction {
  readonly content: string;
  readonly userLogin?: string;
}

export interface GitHubReactionFeedbackDeps {
  readonly sink: ReactionSinkDeps;
  readonly botLogin?: string;
  readonly listComments: (target: GitHubReactionPollTarget) => Promise<readonly GitHubPolledComment[]>;
  readonly listReactions: (target: GitHubReactionPollTarget, commentId: number) => Promise<readonly GitHubPolledReaction[]>;
  readonly seenKeys: (partition: GitHubReactionPartition) => Promise<ReadonlySet<string>>;
  readonly commentBudget?: number;
}

export interface GitHubReactionPartition {
  readonly org: string;
  readonly workspace: string;
  readonly surfaceKey: string;
}

export const GITHUB_REACTION_POLL_COMMENT_BUDGET = 10;

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function pick(o: unknown, k: string): unknown {
  return isObject(o) ? o[k] : undefined;
}

export function parseGitHubReactionPollTarget(body: string, eventType: string): GitHubReactionPollTarget | null {
  if (!POLL_EVENT_TYPES.has(eventType)) return null;
  let ev: unknown;
  try {
    ev = JSON.parse(body);
  } catch {
    return null;
  }
  if (!isObject(ev)) return null;
  const repository = ev["repository"];
  const owner = str(pick(pick(repository, "owner"), "login"));
  const repo = str(pick(repository, "name"));
  const number = num(pick(ev["issue"], "number")) ?? num(pick(ev["pull_request"], "number"));
  if (!owner || !repo || number === undefined) return null;
  const installationId = num(pick(ev["installation"], "id"));
  const repoPrivate = pick(repository, "private");
  return {
    owner,
    repo,
    number,
    ...(installationId === undefined ? {} : { installationId }),
    ...(typeof repoPrivate === "boolean" ? { repoPrivate } : {}),
  };
}

export function githubCommentIsOwn(comment: GitHubPolledComment, botLogin: string | undefined): boolean {
  const login = botLogin?.trim().toLowerCase();
  if (!login) return false;
  if (comment.authorType?.toLowerCase() !== "bot") return false;
  return comment.authorLogin?.toLowerCase() === login;
}

export function githubReactionKey(messageId: string, reactorId: string, emoji: string): string {
  return [messageId, reactorId, emoji].join("\u001f");
}

export async function routeGitHubReactionFeedback(
  target: GitHubReactionPollTarget,
  deps: GitHubReactionFeedbackDeps,
): Promise<readonly ReactionIngestOutcome[]> {
  const botLogin = deps.botLogin?.trim().toLowerCase();
  if (!botLogin) return [];

  const comments = await deps.listComments(target).catch(() => []);
  const own = comments
    .filter((c) => githubCommentIsOwn(c, botLogin) && (c.reactionCount ?? 0) > 0)
    .slice(0, deps.commentBudget ?? GITHUB_REACTION_POLL_COMMENT_BUDGET);
  if (own.length === 0) return [];

  const partition = resolvePartition({
    channel: { kind: "github" },
    session: {
      auth: {
        current: buildGitHubAuth({
          owner: target.owner,
          repo: target.repo,
          issueNumber: target.number,
          actorLogin: botLogin,
          ...(target.repoPrivate === undefined ? {} : { isPrivate: target.repoPrivate }),
        }),
      },
    },
  });
  const coords: GitHubReactionPartition = { org: partition.org, workspace: partition.workspace, surfaceKey: partition.surfaceKey };
  const seen = new Set<string>(await deps.seenKeys(coords).catch(() => new Set<string>()));

  const outcomes: ReactionIngestOutcome[] = [];
  for (const comment of own) {
    const reactions = await deps.listReactions(target, comment.id).catch(() => []);
    for (const reaction of reactions) {
      const reactorId = reaction.userLogin;
      if (!reactorId || reactorId.toLowerCase() === botLogin) continue;
      const messageId = String(comment.id);
      const key = githubReactionKey(messageId, reactorId, reaction.content);
      if (seen.has(key)) continue;
      const ingested = buildIngestedReaction({
        surface: "github",
        verb: "added",
        reactorId,
        emoji: reaction.content,
        target: { channelId: `${target.owner}/${target.repo}#${target.number}`, messageId },
        onBotReply: true,
        partition,
      });
      outcomes.push(await ingestReaction(ingested, deps.sink).catch(() => ({ recorded: false, onBotReply: true, reason: "sink failed" })));
      seen.add(key);
    }
  }
  return outcomes;
}

export const REACTION_SEEN_WINDOW = 2000;

export async function liveGitHubReactionSeenKeys(p: GitHubReactionPartition, limit = REACTION_SEEN_WINDOW): Promise<ReadonlySet<string>> {
  const rows = await readAudit({
    org: p.org,
    platform: "github",
    workspace: p.workspace,
    surface: p.surfaceKey,
    action: REACTION_FEEDBACK_ACTION,
    limit,
  }).catch(() => []);
  const keys = new Set<string>();
  for (const row of rows) {
    const detail = row.detail as unknown;
    const messageId = str(pick(detail, "messageId"));
    const emoji = str(pick(detail, "emoji"));
    if (messageId && emoji && row.principalId) keys.add(githubReactionKey(messageId, row.principalId, emoji));
  }
  return keys;
}

const GITHUB_COMMENT_PAGE = 100;

interface RawPollComment {
  readonly id?: number;
  readonly user?: { readonly login?: string; readonly type?: string };
  readonly reactions?: { readonly total_count?: number };
}

interface RawPollReaction {
  readonly content?: string;
  readonly user?: { readonly login?: string; readonly type?: string };
}

function tokenFor(target: GitHubReactionPollTarget): Promise<string> {
  return installationTokenFor({
    platform: "github",
    owner: target.owner,
    repo: target.repo,
    issueNumber: target.number,
    ...(target.installationId === undefined ? {} : { installationId: target.installationId }),
  });
}

export function liveGitHubReactionFeedbackDeps(appSlug: string | undefined, fetchFn: PrFetchFn = liveGithubReadFetch): GitHubReactionFeedbackDeps {
  const slug = appSlug?.trim();
  return {
    sink: liveReactionSink(),
    ...(slug ? { botLogin: `${slug}[bot]` } : {}),
    listComments: async (target) => {
      const token = await tokenFor(target);
      const issue = await getJson<{ readonly comments?: number }>(
        fetchFn,
        `${GITHUB_API_BASE}/repos/${target.owner}/${target.repo}/issues/${target.number}`,
        token,
        "issues.get",
      );
      const total = typeof issue.comments === "number" && issue.comments > 0 ? issue.comments : 0;
      if (total === 0) return [];
      const page = (nth: number): string => `${GITHUB_API_BASE}/repos/${target.owner}/${target.repo}/issues/${target.number}/comments?per_page=${GITHUB_COMMENT_PAGE}&page=${nth}`;
      const lastPage = Math.max(1, Math.ceil(total / GITHUB_COMMENT_PAGE));
      let raw = await getJson<readonly RawPollComment[]>(fetchFn, page(lastPage), token, "issues.comments.list");
      if (!Array.isArray(raw)) return [];
      if (raw.length < GITHUB_REACTION_POLL_COMMENT_BUDGET && lastPage > 1) {
        const previous = await getJson<readonly RawPollComment[]>(fetchFn, page(lastPage - 1), token, "issues.comments.list");
        if (Array.isArray(previous)) raw = [...previous, ...raw];
      }
      return raw
        .filter((c): c is RawPollComment & { id: number } => typeof c.id === "number")
        .reverse()
        .map((c) => ({
          id: c.id,
          ...(c.user?.login ? { authorLogin: c.user.login } : {}),
          ...(c.user?.type ? { authorType: c.user.type } : {}),
          ...(typeof c.reactions?.total_count === "number" ? { reactionCount: c.reactions.total_count } : {}),
        }));
    },
    listReactions: async (target, commentId) => {
      const token = await tokenFor(target);
      const raw = await getJson<readonly RawPollReaction[]>(
        fetchFn,
        `${GITHUB_API_BASE}/repos/${target.owner}/${target.repo}/issues/comments/${commentId}/reactions?per_page=100`,
        token,
        "reactions.listForIssueComment",
      );
      return raw
        .filter((r): r is RawPollReaction & { content: string } => typeof r.content === "string" && r.content.length > 0)
        .map((r) => ({
          content: r.content,
          ...(r.user?.login ? { userLogin: r.user.login } : {}),
        }));
    },
    seenKeys: (partition) => liveGitHubReactionSeenKeys(partition),
  };
}
