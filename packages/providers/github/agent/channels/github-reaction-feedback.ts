import {
  buildIngestedReaction,
  deploymentOrg,
  getOperationalStore,
  ingestReaction,
  liveReactionSink,
  resolvePartition,
  type ReactionIngestOutcome,
  type PrFetchFn,
  type ReactionSinkDeps,
} from "@open-everywhere/core/agent/adapter-api.js";
import { buildGitHubAuth } from "./github-identity.js";
import { GITHUB_API_BASE, installationTokenFor } from "./github-post-arm.js";
import { getJson, liveGithubReadFetch } from "./github-read.js";
import { auditGitHubReactionClaimUnreadable, githubConversationInScope, spendGitHubPollBudget } from "./github-reaction-scope.js";

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
  readonly recorded: (partition: GitHubReactionPartition, key: string) => Promise<boolean>;
  readonly markRecorded: (partition: GitHubReactionPartition, key: string, atIso: string) => Promise<void>;
  readonly inScope: (target: GitHubReactionPollTarget, partition: GitHubReactionPartition) => Promise<boolean>;
  readonly spendBudget: (target: GitHubReactionPollTarget, partition: GitHubReactionPartition, atIso: string) => Promise<boolean>;
  readonly auditClaimUnreadable?: (target: GitHubReactionPollTarget, partition: GitHubReactionPartition, atIso: string, skipped: number) => Promise<void>;
  readonly commentBudget?: number;
  readonly now?: () => string;
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

  const atIso = deps.now?.() ?? new Date().toISOString();
  if (!(await deps.inScope(target, coords).catch(() => true))) return [];
  if (!(await deps.spendBudget(target, coords, atIso).catch(() => true))) return [];

  const comments = await deps.listComments(target).catch(() => []);
  const own = comments
    .filter((c) => githubCommentIsOwn(c, botLogin) && (c.reactionCount ?? 0) > 0)
    .slice(0, deps.commentBudget ?? GITHUB_REACTION_POLL_COMMENT_BUDGET);
  if (own.length === 0) return [];

  const asked = new Set<string>();

  let claimUnreadable = 0;

  const outcomes: ReactionIngestOutcome[] = [];
  for (const comment of own) {
    const reactions = await deps.listReactions(target, comment.id).catch(() => []);
    for (const reaction of reactions) {
      const reactorId = reaction.userLogin;
      if (!reactorId || reactorId.toLowerCase() === botLogin) continue;
      const messageId = String(comment.id);
      const key = githubReactionKey(messageId, reactorId, reaction.content);
      if (asked.has(key)) continue;
      asked.add(key);
      const claimed = await deps.recorded(coords, key).catch(() => {
        claimUnreadable++;
        return true;
      });
      if (claimed) continue;
      const ingested = buildIngestedReaction({
        surface: "github",
        verb: "added",
        reactorId,
        emoji: reaction.content,
        target: { channelId: `${target.owner}/${target.repo}#${target.number}`, messageId },
        onBotReply: true,
        partition,
      });
      const outcome = await ingestReaction(ingested, deps.sink).catch(() => ({ recorded: false, onBotReply: true, reason: "sink failed" }));
      outcomes.push(outcome);
      if (outcome.recorded) await deps.markRecorded(coords, key, atIso).catch(() => undefined);
    }
  }
  if (claimUnreadable > 0) await deps.auditClaimUnreadable?.(target, coords, atIso, claimUnreadable).catch(() => undefined);
  return outcomes;
}

function githubReactionClaimKey(p: GitHubReactionPartition, key: string): string {
  return `github-reaction:${p.surfaceKey}\u001f${key}`;
}

async function liveGitHubReactionRecorded(p: GitHubReactionPartition, key: string): Promise<boolean> {
  return getOperationalStore().noticeClaimed(deploymentOrg(), githubReactionClaimKey(p, key));
}

async function liveGitHubReactionMarkRecorded(p: GitHubReactionPartition, key: string, atIso: string): Promise<void> {
  await getOperationalStore().claimNotice(deploymentOrg(), githubReactionClaimKey(p, key), atIso);
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
    recorded: (partition, key) => liveGitHubReactionRecorded(partition, key),
    markRecorded: (partition, key, atIso) => liveGitHubReactionMarkRecorded(partition, key, atIso),
    inScope: (target, partition) => githubConversationInScope(partition.surfaceKey, target.owner, target.repo, target.number),
    spendBudget: async (target, _partition, atIso) => (await spendGitHubPollBudget(target.owner, target.repo, atIso)).admitted,
    auditClaimUnreadable: (target, _partition, atIso, skipped) => auditGitHubReactionClaimUnreadable(target.owner, target.repo, atIso, skipped),
  };
}
