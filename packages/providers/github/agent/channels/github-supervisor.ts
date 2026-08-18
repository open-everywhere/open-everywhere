import {
  renderWake,
  mkMessageTrigger,
  shouldRotate,
  singleWindowMentionPolicy,
  stampNonMemberChatAuth,
  type NormalizedWake,
  type WakeEngagementTier,
  type ContextLine,
  type UnifiedWindowWake,
  type WakeTrust,
  type IngestedChatMessage,
} from "@open-everywhere/core/agent/adapter-api.js";
import { githubBotMentioned, type OpenEverywhereGitHubAuth } from "./github-identity.js";

export function githubSupervisorSentinel(generation: number): string {
  return `oe-sup:g${generation}`;
}

export function githubSupervisorToken(owner: string, repo: string, generation: number): string {
  return `github:${owner}/${repo}:${githubSupervisorSentinel(generation)}`;
}

export type GitHubAmbientAddressing = "direct" | "channel-watch" | "drop";

export interface GitHubAmbientClassification {
  readonly addressing: GitHubAmbientAddressing;
  readonly reason: string;
}

export interface GitHubAmbientComment {
  readonly body?: string;
  readonly authorLogin?: string;
  readonly authorType?: string;
  readonly repoPrivate?: boolean;
}

export function classifyGitHubAmbientComment(
  c: GitHubAmbientComment,
  botSlug: string | undefined,
  opts?: { treatMentionAsDirect?: boolean; vouched?: boolean },
): GitHubAmbientClassification {
  const slug = botSlug?.trim();
  if (!slug) return { addressing: "drop", reason: "no bot slug configured — fail-closed loop guard" };
  if (c.authorType === "Bot") return { addressing: "drop", reason: "bot-authored comment (loop guard)" };
  if (c.authorLogin && c.authorLogin.toLowerCase() === `${slug}[bot]`.toLowerCase()) {
    return { addressing: "drop", reason: "self-authored comment (our own reply)" };
  }
  const vouched = opts?.vouched === true;
  if (githubBotMentioned(c.body, slug, { login: c.authorLogin, type: c.authorType })) {
    if (singleWindowMentionPolicy(opts?.treatMentionAsDirect === true, true, vouched).addressing === "direct-mention") {
      return { addressing: "direct", reason: "bot @mention on a single-window vouched repo — answered by the unified window" };
    }
    return { addressing: "drop", reason: "bot @mention — owned by the native githubChannel path" };
  }
  if (c.repoPrivate !== true && !vouched) {
    return { addressing: "drop", reason: "repo neither positively private nor operator-vouched — fail-closed (no drive-by ambient)" };
  }
  return { addressing: "channel-watch", reason: `ambient comment — judged by the repo supervisor (private=${c.repoPrivate === true}, vouched=${vouched})` };
}

export interface GitHubSupervisorWakeInput {
  readonly owner: string;
  readonly repo: string;
  readonly issueNumber: number;
  readonly issueTitle?: string;
  readonly trigger: {
    readonly id: string;
    readonly authorLogin?: string;
    readonly sentAt: string;
    readonly text: string;
    readonly trust: WakeTrust;
  };
  readonly engagementTier?: WakeEngagementTier;
  readonly handoffNote?: string | null;
  readonly handoffFromGeneration?: number;
  readonly wakeId?: string;
  readonly directMention?: boolean;
}

export function buildGitHubSupervisorWake(input: GitHubSupervisorWakeInput): NormalizedWake {
  const directMention = input.directMention === true;
  const contextLines: ContextLine[] | undefined = input.issueTitle
    ? [{ senderType: "user", ts: `#${input.issueNumber}`, text: `issue/PR #${input.issueNumber}: ${input.issueTitle}` }]
    : undefined;
  const handoff = input.handoffNote
    ? { note: input.handoffNote, fromGeneration: input.handoffFromGeneration ?? 0 }
    : undefined;
  return {
    platform: "github",
    reason: directMention ? "mention" : "channel-activity",
    addressing: directMention ? "direct-mention" : "channel-watch",
    containerNoun: "repo",
    engagementTier: directMention ? undefined : input.engagementTier,
    wakeId: input.wakeId,
    locus: {
      channel: { id: `${input.owner}/${input.repo}` },
      thread: { ts: `#${input.issueNumber}` },
    },
    contextLines,
    contextSource: contextLines ? "the issue/PR this comment is on" : undefined,
    handoff,
    trigger: mkMessageTrigger({
      from: "human",
      author: input.trigger.authorLogin ?? "unknown",
      authorId: input.trigger.authorLogin,
      id: input.trigger.id,
      sentAt: input.trigger.sentAt,
      trust: input.trigger.trust,
      mention: directMention ? true : undefined,
      body: input.trigger.text,
    }),
  };
}

export interface GitHubAmbientEvent {
  readonly owner: string;
  readonly repo: string;
  readonly repositoryFullName?: string;
  readonly repositoryId?: number;
  readonly repoPrivate?: boolean;
  readonly installationId?: number;
  readonly issueNumber: number;
  readonly issueTitle?: string;
  readonly isPullRequest: boolean;
  readonly comment: GitHubAmbientComment & {
    readonly id?: string;
    readonly createdAt?: string;
    readonly authorId?: number;
    readonly authorAssociation?: string;
  };
}

function pick(o: unknown, k: string): unknown {
  return o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined;
}
function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}
function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

export function extractGitHubAmbientEvent(eventType: string, payload: Record<string, unknown>): GitHubAmbientEvent | null {
  if (eventType !== "issue_comment") return null;
  if (str(pick(payload, "action")) !== "created") return null;
  const repository = pick(payload, "repository");
  const issue = pick(payload, "issue");
  const comment = pick(payload, "comment");
  const owner = str(pick(pick(repository, "owner"), "login"));
  const repo = str(pick(repository, "name"));
  const issueNumber = num(pick(issue, "number"));
  if (!owner || !repo || issueNumber === undefined || !comment) return null;
  const user = pick(comment, "user");
  const isPrivate = pick(repository, "private");
  const commentId = num(pick(comment, "id"));
  return {
    owner,
    repo,
    repositoryFullName: str(pick(repository, "full_name")),
    repositoryId: num(pick(repository, "id")),
    repoPrivate: typeof isPrivate === "boolean" ? isPrivate : undefined,
    installationId: num(pick(pick(payload, "installation"), "id")),
    issueNumber,
    issueTitle: str(pick(issue, "title")),
    isPullRequest: pick(issue, "pull_request") !== undefined,
    comment: {
      id: commentId !== undefined ? String(commentId) : undefined,
      body: str(pick(comment, "body")),
      authorLogin: str(pick(user, "login")),
      authorType: str(pick(user, "type")),
      authorId: num(pick(user, "id")),
      authorAssociation: str(pick(comment, "author_association")),
      createdAt: str(pick(comment, "created_at")),
      repoPrivate: typeof isPrivate === "boolean" ? isPrivate : undefined,
    },
  };
}

export interface GitHubSupervisorSession {
  readonly token: string;
  readonly generation: number;
  readonly freshGeneration: boolean;
  readonly handoffNote?: string | null;
}

export interface GitHubSupervisorDeps {
  readonly getOrCreateSession: (surfaceKey: string, owner: string, repo: string, atIso: string) => Promise<GitHubSupervisorSession>;
  readonly touchSession?: (surfaceKey: string, atIso: string) => Promise<void>;
  readonly wake: (input: {
    token: string;
    auth: OpenEverywhereGitHubAuth;
    message: string;
    context: readonly string[];
    window?: UnifiedWindowWake;
  }) => Promise<void>;
  readonly now?: () => string;
}

export interface GitHubSupervisorDispatch {
  readonly surfaceKey: string;
  readonly owner: string;
  readonly repo: string;
  readonly issueNumber: number;
  readonly issueTitle?: string;
  readonly auth: OpenEverywhereGitHubAuth;
  readonly ingested: readonly IngestedChatMessage[];
  readonly trigger: GitHubSupervisorWakeInput["trigger"];
  readonly engagementTier?: WakeEngagementTier;
  readonly unified?: boolean;
  readonly window?: UnifiedWindowWake;
  readonly directMention?: boolean;
}

export async function handleGitHubSupervisorDispatch(d: GitHubSupervisorDispatch, deps: GitHubSupervisorDeps): Promise<void> {
  const atIso = deps.now ? deps.now() : new Date().toISOString();
  const session = await deps.getOrCreateSession(d.surfaceKey, d.owner, d.repo, atIso);

  const doWake = async (token: string, generation: number, handoffNote: string | null | undefined) => {
    const nw = buildGitHubSupervisorWake({
      owner: d.owner,
      repo: d.repo,
      issueNumber: d.issueNumber,
      issueTitle: d.issueTitle,
      trigger: d.trigger,
      engagementTier: d.engagementTier,
      wakeId: d.window?.wakeId,
      directMention: d.directMention,
      handoffNote: handoffNote ?? undefined,
      handoffFromGeneration: generation - 1,
    });
    const { message, context } = renderWake(nw, deps.now);
    const auth = stampNonMemberChatAuth(d.auth, d.ingested, { surfaceKey: d.surfaceKey });
    await deps.wake({ token, auth, message, context: context ?? [], window: d.window });
  };

  await doWake(session.token, session.generation, session.freshGeneration ? session.handoffNote : undefined);
  if (deps.touchSession) await deps.touchSession(d.surfaceKey, atIso);
}

export { shouldRotate };
