import { renderWake, mkMessageTrigger, type NormalizedWake, type WakeEngagementTier } from "./normalized-wake.js";
import type { ContextLine } from "./context-render.js";
import { shouldRotate } from "./slack-events.js";
import { classifySessionSendError } from "./session-death.js";
import type { OpenEverywhereLinearAuth } from "./linear-identity.js";

export function linearSupervisorSentinel(generation: number): string {
  return `oe-sup:g${generation}`;
}

export function linearSupervisorToken(teamId: string, generation: number): string {
  return `linear:${teamId}:${linearSupervisorSentinel(generation)}`;
}

export interface LinearCommentSignal {
  readonly commentId: string;
  readonly organizationId?: string;
}

function pick(o: unknown, k: string): unknown {
  return o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined;
}
function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

export function extractLinearCommentSignal(event: {
  readonly kind?: string;
  readonly type?: string;
  readonly action?: string;
  readonly organizationId?: string;
  readonly raw?: unknown;
}): LinearCommentSignal | null {
  if (event.kind !== "data") return null;
  if (event.type !== "Comment" || event.action !== "create") return null;
  const commentId = str(pick(pick(event.raw, "data"), "id"));
  if (!commentId) return null;
  return { commentId, organizationId: event.organizationId };
}

export interface LinearViewerIdentity {
  readonly id?: string;
  readonly name?: string;
}

export interface LinearAmbientComment {
  readonly body?: string;
  readonly authorId?: string;
  readonly parentAuthorId?: string;
}

export type LinearAmbientAddressing = "channel-watch" | "drop";

export interface LinearAmbientClassification {
  readonly addressing: LinearAmbientAddressing;
  readonly reason: string;
}

function mentionsApp(body: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`@${escaped}(?=$|[^A-Za-z0-9_-])`, "iu").test(body);
}

export function classifyLinearAmbientComment(c: LinearAmbientComment, viewer: LinearViewerIdentity): LinearAmbientClassification {
  if (!viewer.id || !viewer.name) {
    return { addressing: "drop", reason: "unresolved app viewer identity — fail-closed loop/partition guard" };
  }
  if (!c.authorId) return { addressing: "drop", reason: "no comment author (bot/integration-authored)" };
  if (c.authorId === viewer.id) return { addressing: "drop", reason: "self-authored comment (our own reply)" };
  if (c.parentAuthorId && c.parentAuthorId === viewer.id) {
    return { addressing: "drop", reason: "reply inside the app's own comment thread — owned by the agent-session path" };
  }
  if (c.body && mentionsApp(c.body, viewer.name)) {
    return { addressing: "drop", reason: "app @mention — owned by the agent-session path" };
  }
  return { addressing: "channel-watch", reason: "ambient comment — judged by the team supervisor" };
}

export interface LinearSupervisorWakeInput {
  readonly teamId: string;
  readonly issueId: string;
  readonly issueIdentifier?: string;
  readonly issueTitle?: string;
  readonly trigger: {
    readonly id: string;
    readonly authorId?: string;
    readonly authorName?: string;
    readonly sentAt: string;
    readonly text: string;
  };
  readonly engagementTier?: WakeEngagementTier;
  readonly handoffNote?: string | null;
  readonly handoffFromGeneration?: number;
  readonly unified?: boolean;
}

export function buildLinearSupervisorWake(input: LinearSupervisorWakeInput): NormalizedWake {
  const issueLabel = input.issueIdentifier ?? input.issueId;
  const contextLines: ContextLine[] | undefined = input.issueTitle
    ? [{ senderType: "user", ts: issueLabel, text: `issue ${issueLabel}: ${input.issueTitle}` }]
    : undefined;
  const handoff = input.handoffNote
    ? { note: input.handoffNote, fromGeneration: input.handoffFromGeneration ?? 0 }
    : undefined;
  return {
    platform: "linear",
    reason: "channel-activity",
    addressing: "channel-watch",
    containerNoun: "team",
    engagementTier: input.engagementTier,
    unifiedDisclosure: input.unified === true ? true : undefined,
    locus: {
      channel: { id: input.teamId, ...(input.unified ? { platform: "linear" } : {}) },
      thread: { ts: issueLabel },
    },
    contextLines,
    contextSource: contextLines ? "the issue this comment is on" : undefined,
    handoff,
    trigger: mkMessageTrigger({
      from: "human",
      author: input.trigger.authorName ?? input.trigger.authorId ?? "unknown",
      authorId: input.trigger.authorId,
      id: input.trigger.id,
      sentAt: input.trigger.sentAt,
      trust: "peer",
      body: input.trigger.text,
    }),
  };
}

export interface LinearSupervisorSession {
  readonly token: string;
  readonly generation: number;
  readonly freshGeneration: boolean;
  readonly handoffNote?: string | null;
}

export interface LinearSupervisorDeps {
  readonly getOrCreateSession: (surfaceKey: string, teamId: string, atIso: string) => Promise<LinearSupervisorSession>;
  readonly touchSession?: (surfaceKey: string, atIso: string) => Promise<void>;
  readonly forceRotate?: (surfaceKey: string, teamId: string, atIso: string) => Promise<{ token: string; generation: number; handoffNote: string | null }>;
  readonly wake: (input: {
    token: string;
    auth: OpenEverywhereLinearAuth;
    message: string;
    context: readonly string[];
  }) => Promise<void>;
  readonly audit?: (action: string, detail: Record<string, unknown>) => Promise<void>;
  readonly now?: () => string;
}

export interface LinearSupervisorDispatch {
  readonly surfaceKey: string;
  readonly teamId: string;
  readonly issueId: string;
  readonly issueIdentifier?: string;
  readonly issueTitle?: string;
  readonly auth: OpenEverywhereLinearAuth;
  readonly trigger: LinearSupervisorWakeInput["trigger"];
  readonly engagementTier?: WakeEngagementTier;
  readonly unified?: boolean;
}

export async function handleLinearSupervisorDispatch(d: LinearSupervisorDispatch, deps: LinearSupervisorDeps): Promise<void> {
  const atIso = deps.now ? deps.now() : new Date().toISOString();
  const session = await deps.getOrCreateSession(d.surfaceKey, d.teamId, atIso);

  const doWake = async (token: string, generation: number, handoffNote: string | null | undefined) => {
    const nw = buildLinearSupervisorWake({
      teamId: d.teamId,
      issueId: d.issueId,
      issueIdentifier: d.issueIdentifier,
      issueTitle: d.issueTitle,
      trigger: d.trigger,
      engagementTier: d.engagementTier,
      unified: d.unified,
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
    if (deps.audit) await deps.audit("linear.session_terminal_death", { surfaceKey: d.surfaceKey, token: session.token, generation: session.generation });
    const fresh = await deps.forceRotate(d.surfaceKey, d.teamId, atIso);
    await doWake(fresh.token, fresh.generation, fresh.handoffNote);
  }
  if (deps.touchSession) await deps.touchSession(d.surfaceKey, atIso);
}

export { shouldRotate };
