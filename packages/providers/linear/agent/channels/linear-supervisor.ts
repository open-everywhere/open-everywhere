import {
  renderWake,
  mkMessageTrigger,
  shouldRotate,
  type NormalizedWake,
  type WakeEngagementTier,
  type ContextLine,
  type UnifiedWindowWake,
  type WakeTrust,
} from "@open-everywhere/core/agent/adapter-api.js";
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
    readonly trust?: WakeTrust;
  };
  readonly engagementTier?: WakeEngagementTier;
  readonly handoffNote?: string | null;
  readonly handoffFromGeneration?: number;
  readonly unified?: boolean;
  readonly wakeId?: string;
  readonly directMention?: boolean;
}

export function buildLinearSupervisorWake(input: LinearSupervisorWakeInput): NormalizedWake {
  const directMention = input.directMention === true;
  const issueLabel = input.issueIdentifier ?? input.issueId;
  const contextLines: ContextLine[] | undefined = input.issueTitle
    ? [{ senderType: "user", ts: issueLabel, text: `issue ${issueLabel}: ${input.issueTitle}` }]
    : undefined;
  const handoff = input.handoffNote
    ? { note: input.handoffNote, fromGeneration: input.handoffFromGeneration ?? 0 }
    : undefined;
  return {
    platform: "linear",
    reason: directMention ? "mention" : "channel-activity",
    addressing: directMention ? "direct-mention" : "channel-watch",
    containerNoun: "team",
    engagementTier: directMention ? undefined : input.engagementTier,
    unifiedDisclosure: input.unified === true ? true : undefined,
    wakeId: input.wakeId,
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
      trust: input.trigger.trust ?? (directMention ? "principal" : "peer"),
      mention: directMention ? true : undefined,
      body: input.trigger.text,
    }),
  };
}

export interface LinearAgentSessionSignal {
  readonly action: string;
  readonly agentSessionId?: string;
  readonly organizationId?: string;
  readonly teamId?: string;
  readonly sourceCommentId?: string;
  readonly promptSourceCommentId?: string;
}

export function linearAgentSessionSignal(
  event: {
    readonly action: string;
    readonly organizationId?: string;
    readonly agentSession: {
      readonly id?: string;
      readonly organizationId?: string;
      readonly sourceCommentId?: string | null;
      readonly commentId?: string | null;
    };
    readonly agentActivity?: { readonly sourceCommentId?: string | null };
  },
  teamId: string | undefined,
): LinearAgentSessionSignal {
  const s = event.agentSession;
  const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);
  return {
    action: event.action,
    agentSessionId: str(s.id),
    organizationId: str(event.organizationId) ?? str(s.organizationId),
    teamId,
    sourceCommentId: str(s.sourceCommentId) ?? str(s.commentId),
    promptSourceCommentId: str(event.agentActivity?.sourceCommentId),
  };
}

export type LinearAgentSessionRouting = "native" | "suppress-and-divert";

export function routeLinearAgentSession(
  sig: LinearAgentSessionSignal,
  singleWindow: boolean,
  vouched: boolean,
): LinearAgentSessionRouting {
  if (!singleWindow || !vouched) return "native";
  if (!sig.agentSessionId || !sig.organizationId || !sig.teamId) return "native";
  if (sig.action === "created") return sig.sourceCommentId ? "suppress-and-divert" : "native";
  if (sig.action === "prompted") return sig.promptSourceCommentId ? "suppress-and-divert" : "native";
  return "native";
}

export interface LinearSupervisorSession {
  readonly token: string;
  readonly generation: number;
  readonly freshGeneration: boolean;
  readonly handoffNote?: string | null;
  readonly lastWakeAt?: string | null;
}

export interface LinearSupervisorDeps {
  readonly getOrCreateSession: (surfaceKey: string, teamId: string, atIso: string) => Promise<LinearSupervisorSession>;
  readonly touchSession?: (surfaceKey: string, atIso: string) => Promise<void>;
  readonly wake: (input: {
    token: string;
    auth: OpenEverywhereLinearAuth;
    message: string;
    context: readonly string[];
    window?: UnifiedWindowWake;
  }) => Promise<void>;
  readonly memoryDelta?: (sinceIso: string, atIso: string, selfKey?: string) => Promise<string | null>;
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
  readonly window?: UnifiedWindowWake;
  readonly directMention?: boolean;
}

export async function handleLinearSupervisorDispatch(d: LinearSupervisorDispatch, deps: LinearSupervisorDeps): Promise<void> {
  const atIso = deps.now ? deps.now() : new Date().toISOString();
  const session = await deps.getOrCreateSession(d.surfaceKey, d.teamId, atIso);

  let memoryDelta: string | undefined;
  if (deps.memoryDelta && session.lastWakeAt) {
    try {
      memoryDelta = (await deps.memoryDelta(session.lastWakeAt, atIso, session.token)) ?? undefined;
    } catch {
      memoryDelta = undefined;
    }
  }

  const doWake = async (token: string, generation: number, handoffNote: string | null | undefined) => {
    const nw: NormalizedWake = {
      ...buildLinearSupervisorWake({
        teamId: d.teamId,
        issueId: d.issueId,
        issueIdentifier: d.issueIdentifier,
        issueTitle: d.issueTitle,
        trigger: d.trigger,
        engagementTier: d.engagementTier,
        unified: d.unified,
        wakeId: d.window?.wakeId,
        directMention: d.directMention,
        handoffNote: handoffNote ?? undefined,
        handoffFromGeneration: generation - 1,
      }),
      ...(memoryDelta ? { memoryDelta } : {}),
    };
    const { message, context } = renderWake(nw, deps.now);
    await deps.wake({ token, auth: d.auth, message, context: context ?? [], window: d.window });
  };

  await doWake(session.token, session.generation, session.freshGeneration ? session.handoffNote : undefined);
  if (deps.touchSession) await deps.touchSession(d.surfaceKey, atIso);
}

export { shouldRotate };
