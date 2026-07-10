import { renderWake, mkMessageTrigger, type NormalizedWake, type WakeEngagementTier } from "./normalized-wake.js";
import type { ContextLine } from "./context-render.js";
import { shouldRotate } from "./slack-events.js";
import { classifySessionSendError } from "./session-death.js";
import { githubBotMentioned, type OpenEverywhereGitHubAuth } from "./github-identity.js";

export function githubSupervisorSentinel(generation: number): string {
  return `oe-sup:g${generation}`;
}

export function githubSupervisorToken(owner: string, repo: string, generation: number): string {
  return `github:${owner}/${repo}:${githubSupervisorSentinel(generation)}`;
}

export type GitHubAmbientAddressing = "channel-watch" | "drop";

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

export function classifyGitHubAmbientComment(c: GitHubAmbientComment, botSlug: string | undefined): GitHubAmbientClassification {
  const slug = botSlug?.trim();
  if (!slug) return { addressing: "drop", reason: "no bot slug configured — fail-closed loop guard" };
  if (c.authorType === "Bot") return { addressing: "drop", reason: "bot-authored comment (loop guard)" };
  if (c.authorLogin && c.authorLogin.toLowerCase() === `${slug}[bot]`.toLowerCase()) {
    return { addressing: "drop", reason: "self-authored comment (our own reply)" };
  }
  if (githubBotMentioned(c.body, slug, { login: c.authorLogin, type: c.authorType })) {
    return { addressing: "drop", reason: "bot @mention — owned by the native githubChannel path" };
  }
  if (c.repoPrivate !== true) return { addressing: "drop", reason: "repo not positively private — fail-closed (no public-repo ambient)" };
  return { addressing: "channel-watch", reason: "ambient comment on a private repo — judged by the repo supervisor" };
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
  };
  readonly engagementTier?: WakeEngagementTier;
  readonly handoffNote?: string | null;
  readonly handoffFromGeneration?: number;
}

export function buildGitHubSupervisorWake(input: GitHubSupervisorWakeInput): NormalizedWake {
  const contextLines: ContextLine[] | undefined = input.issueTitle
    ? [{ senderType: "user", ts: `#${input.issueNumber}`, text: `issue/PR #${input.issueNumber}: ${input.issueTitle}` }]
    : undefined;
  const handoff = input.handoffNote
    ? { note: input.handoffNote, fromGeneration: input.handoffFromGeneration ?? 0 }
    : undefined;
  return {
    platform: "github",
    reason: "channel-activity",
    addressing: "channel-watch",
    containerNoun: "repo",
    engagementTier: input.engagementTier,
    locus: { channel: { id: `${input.owner}/${input.repo}` }, thread: { ts: `#${input.issueNumber}` } },
    contextLines,
    contextSource: contextLines ? "the issue/PR this comment is on" : undefined,
    handoff,
    trigger: mkMessageTrigger({
      from: "human",
      author: input.trigger.authorLogin ?? "unknown",
      authorId: input.trigger.authorLogin,
      id: input.trigger.id,
      sentAt: input.trigger.sentAt,
      trust: "peer",
      body: input.trigger.text,
    }),
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
  readonly forceRotate?: (surfaceKey: string, owner: string, repo: string, atIso: string) => Promise<{ token: string; generation: number; handoffNote: string | null }>;
  readonly wake: (input: {
    token: string;
    auth: OpenEverywhereGitHubAuth;
    message: string;
    context: readonly string[];
  }) => Promise<void>;
  readonly audit?: (action: string, detail: Record<string, unknown>) => Promise<void>;
  readonly now?: () => string;
}

export interface GitHubSupervisorDispatch {
  readonly surfaceKey: string;
  readonly owner: string;
  readonly repo: string;
  readonly issueNumber: number;
  readonly issueTitle?: string;
  readonly auth: OpenEverywhereGitHubAuth;
  readonly trigger: GitHubSupervisorWakeInput["trigger"];
  readonly engagementTier?: WakeEngagementTier;
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
      handoffNote: handoffNote ?? undefined,
      handoffFromGeneration: generation - 1,
    });
    const { message, context } = renderWake(nw, deps.now);
    await deps.wake({ token, auth: d.auth, message, context: context ?? [] });
  };

  try {
    await doWake(session.token, session.generation, session.freshGeneration ? session.handoffNote : undefined);
  } catch (err) {
    if (classifySessionSendError(err) !== "terminal" || !deps.forceRotate) throw err;
    if (deps.audit) await deps.audit("github.session_terminal_death", { surfaceKey: d.surfaceKey, token: session.token, generation: session.generation });
    const fresh = await deps.forceRotate(d.surfaceKey, d.owner, d.repo, atIso);
    await doWake(fresh.token, fresh.generation, fresh.handoffNote);
  }
  if (deps.touchSession) await deps.touchSession(d.surfaceKey, atIso);
}

export { shouldRotate };
