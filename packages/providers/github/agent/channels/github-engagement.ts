import {
  getOperationalStore,
  getThreadEngagement,
  markThreadEngaged,
  resolvePartition,
  shouldDeliverReply,
  type EngagementRow,
  type Partition,
} from "@open-everywhere/core/agent/adapter-api.js";
import { buildGitHubAuth, githubConversationKey } from "./github-identity.js";

export function githubEngagementAnchor(owner: string | undefined, repo: string | undefined, num: number | undefined): string | undefined {
  return githubConversationKey(owner, repo, num);
}

export function githubSeamPartition(f: GitHubSeamFacts): Partition | null {
  try {
    const auth = buildGitHubAuth({
      owner: f.owner,
      repo: f.repo,
      isPrivate: f.isPrivate,
      actorLogin: f.actorLogin,
    });
    return resolvePartition({ channel: { kind: "github" }, session: { auth: { current: auth } } });
  } catch {
    return null;
  }
}

export interface GitHubSeamFacts {
  readonly owner: string;
  readonly repo: string;
  readonly number: number | undefined;
  readonly isPrivate?: boolean;
  readonly actorLogin: string;
  readonly isMention: boolean;
  readonly authorIsBot: boolean;
  readonly conversationKind: string | undefined;
}

export function githubEngagedFollowUpReach(f: GitHubSeamFacts): { readonly reachable: boolean; readonly reason: string } {
  if (f.isPrivate !== true) {
    return { reachable: false, reason: "the repo is public or of unknown privacy — an engaged follow-up wakes a native turn, which is private-repo only" };
  }
  if (f.conversationKind === "review_thread") {
    return { reachable: false, reason: "an inline review comment shares its pull request's anchor — a review thread is not a container of its own" };
  }
  return { reachable: true, reason: "a private repo, and not an inline review comment" };
}

export type GitHubEngagementVerdict =
  | { readonly kind: "unanchored"; readonly reason: string }
  | { readonly kind: "engage"; readonly anchor: string }
  | { readonly kind: "deliver"; readonly anchor: string; readonly reason: string }
  | { readonly kind: "hold"; readonly anchor: string; readonly reason: string; readonly stopped: boolean };

export interface GitHubEngagementDeps {
  readonly getEngagement?: (p: Partition, anchor: string) => Promise<EngagementRow | null>;
  readonly markEngaged?: (p: Partition, anchor: string, atIso: string) => Promise<void>;
  readonly markEventSeen?: (org: string, key: string, atIso: string) => Promise<boolean>;
  readonly now?: () => string;
}

export async function resolveGitHubEngagement(f: GitHubSeamFacts, deps: GitHubEngagementDeps = {}): Promise<GitHubEngagementVerdict> {
  const anchor = githubEngagementAnchor(f.owner, f.repo, f.number);
  if (!anchor) return { kind: "unanchored", reason: "the delivery names no issue or pull-request number — no row to address" };
  const partition = githubSeamPartition(f);
  if (!partition) return { kind: "unanchored", reason: "the delivery has no resolvable partition — no row to address" };

  if (f.isMention) return { kind: "engage", anchor };

  const read = deps.getEngagement ?? ((p, key) => getThreadEngagement(p, key));
  const row = await read(partition, anchor);
  const decision = shouldDeliverReply({
    isEngaged: row !== null,
    stopped: row?.stopped ?? false,
    authorIsBot: f.authorIsBot,
    isAppMention: false,
    inThread: true,
  });
  if (decision.deliver) return { kind: "deliver", anchor, reason: decision.reason };
  return { kind: "hold", anchor, reason: decision.reason, stopped: row?.stopped === true };
}

export async function markGitHubEngaged(f: GitHubSeamFacts, commentId: string | number | undefined, deps: GitHubEngagementDeps = {}): Promise<string | null> {
  const anchor = githubEngagementAnchor(f.owner, f.repo, f.number);
  if (!anchor) return null;
  const partition = githubSeamPartition(f);
  if (!partition) return null;
  const now = deps.now ?? (() => new Date().toISOString());
  const atIso = now();
  if (commentId !== undefined) {
    const seen = deps.markEventSeen ?? liveMarkEngageSeen;
    if (!(await seen(partition.org, `github-engage:${anchor}:${String(commentId)}`, atIso))) return null;
  }
  const mark = deps.markEngaged ?? ((p, key, at) => markThreadEngaged(p, key, at, { participating: true }));
  await mark(partition, anchor, atIso);
  return anchor;
}

const ENGAGE_DEDUPE_TTL_MS = 10 * 60_000;
let warnedEngageDedupe = false;
async function liveMarkEngageSeen(org: string, key: string, atIso: string): Promise<boolean> {
  try {
    return await getOperationalStore().markEventSeen(org, key, atIso, ENGAGE_DEDUPE_TTL_MS);
  } catch (err) {
    if (!warnedEngageDedupe) {
      warnedEngageDedupe = true;
      console.warn(`[open-everywhere:github-engagement] engage dedupe unavailable — a redelivered @mention may re-mark: ${String(err)}`);
    }
    return true;
  }
}

export function githubMachineAuthored(authorLogin: string | undefined, authorType: string | undefined, botSlug: string | undefined): boolean {
  const slug = botSlug?.trim();
  if (!slug) return true;
  if (authorType === "Bot") return true;
  return authorLogin !== undefined && authorLogin.toLowerCase() === `${slug}[bot]`.toLowerCase();
}

export async function githubEngagedAdmits(f: GitHubSeamFacts, deps: GitHubEngagementDeps = {}): Promise<boolean> {
  if (f.isMention) return true;
  if (!githubEngagedFollowUpReach(f).reachable) return false;
  const verdict = await resolveGitHubEngagement(f, deps);
  return verdict.kind === "deliver";
}
