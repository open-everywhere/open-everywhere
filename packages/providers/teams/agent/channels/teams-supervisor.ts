import {
  renderWake,
  mkMessageTrigger,
  classifySessionSendError,
  mintWakeId,
  singleWindowMentionPolicy,
  type NormalizedWake,
  type WakeEngagementTier,
  type WakeTrust,
  type SingleWindowMentionPolicy,
  type UnifiedWindowWake,
} from "@open-everywhere/core/agent/adapter-api.js";
import type { OpenEverywhereTeamsAuth } from "./teams-identity.js";

export function teamsSupervisorSentinel(generation: number): string {
  return `oe-sup:g${generation}`;
}

export function teamsSupervisorToken(channelKey: string, generation: number): string {
  return `teams:${channelKey}:${teamsSupervisorSentinel(generation)}`;
}

export interface TeamsSingleWindowFacts {
  readonly scope: string | undefined;
  readonly membershipType?: string;
  readonly tenantId?: string;
  readonly vouched: boolean;
}

export function teamsSingleWindowPrivacyOk(f: TeamsSingleWindowFacts): boolean {
  if (f.scope !== "channel") return false;
  if (!f.tenantId) return false;
  if (f.membershipType === "shared") return false;
  return f.vouched === true;
}

export function teamsSingleWindowMentionPolicy(singleWindow: boolean, isMention: boolean, facts: TeamsSingleWindowFacts): SingleWindowMentionPolicy {
  return singleWindowMentionPolicy(singleWindow, isMention, teamsSingleWindowPrivacyOk(facts));
}

export interface TeamsSingleWindowTarget {
  readonly serviceUrl: string;
  readonly conversationId: string;
  readonly replyToActivityId?: string;
  readonly tenantId?: string;
}

export function planTeamsSingleWindow(
  singleWindow: boolean,
  isMention: boolean,
  facts: TeamsSingleWindowFacts,
  target: TeamsSingleWindowTarget,
): UnifiedWindowWake | undefined {
  const policy = teamsSingleWindowMentionPolicy(singleWindow, isMention, facts);
  const divert = isMention ? policy.suppressNative : singleWindow && teamsSingleWindowPrivacyOk(facts);
  if (!divert) return undefined;
  if (!target.serviceUrl || !target.conversationId) return undefined;
  return {
    wakeId: mintWakeId(),
    origin: {
      platform: "teams",
      serviceUrl: target.serviceUrl,
      conversationId: target.conversationId,
      ...(target.replyToActivityId ? { replyToActivityId: target.replyToActivityId } : {}),
      ...(target.tenantId ? { tenantId: target.tenantId } : {}),
    },
    ...(policy.addressing !== undefined ? { addressing: policy.addressing } : {}),
  };
}

export interface TeamsSupervisorWakeInput {
  readonly channelId: string;
  readonly trigger: {
    readonly id: string;
    readonly authorId: string;
    readonly authorName?: string;
    readonly sentAt: string;
    readonly text: string;
    readonly trust?: WakeTrust;
  };
  readonly threadRootId?: string;
  readonly directMention: boolean;
  readonly wakeId: string;
  readonly engagementTier?: WakeEngagementTier;
  readonly handoffNote?: string | null;
  readonly handoffFromGeneration?: number;
}

export function buildTeamsSupervisorWake(input: TeamsSupervisorWakeInput): NormalizedWake {
  return {
    platform: "teams",
    reason: input.directMention ? "mention" : "channel-activity",
    addressing: input.directMention ? "direct-mention" : "channel-watch",
    engagementTier: input.directMention ? undefined : input.engagementTier,
    unifiedDisclosure: true,
    wakeId: input.wakeId,
    locus: {
      channel: { id: input.channelId, platform: "teams" },
      ...(input.threadRootId ? { thread: { ts: input.threadRootId } } : {}),
    },
    ...(input.trigger.authorName ? { participants: [{ id: input.trigger.authorId, name: input.trigger.authorName }] } : {}),
    handoff: input.handoffNote ? { note: input.handoffNote, fromGeneration: input.handoffFromGeneration ?? 0 } : undefined,
    trigger: mkMessageTrigger({
      from: "human",
      author: input.trigger.authorName ?? input.trigger.authorId,
      authorId: input.trigger.authorId,
      id: input.trigger.id,
      sentAt: input.trigger.sentAt,
      trust: input.trigger.trust ?? "relay",
      mention: input.directMention,
      body: input.trigger.text,
    }),
  };
}

export interface TeamsSupervisorSession {
  readonly token: string;
  readonly generation: number;
  readonly freshGeneration: boolean;
  readonly handoffNote?: string | null;
}

export interface TeamsSupervisorDeps {
  readonly getOrCreateSession: (surfaceKey: string, channelId: string, atIso: string) => Promise<TeamsSupervisorSession>;
  readonly touchSession?: (surfaceKey: string, atIso: string) => Promise<void>;
  readonly forceRotate?: (surfaceKey: string, channelId: string, atIso: string) => Promise<{ token: string; generation: number; handoffNote: string | null }>;
  readonly wake: (input: { token: string; auth: OpenEverywhereTeamsAuth; message: string; context: readonly string[]; window: UnifiedWindowWake }) => Promise<void>;
  readonly audit?: (action: string, detail: Record<string, unknown>) => Promise<void>;
  readonly now?: () => string;
}

export interface TeamsSupervisorDispatch {
  readonly surfaceKey: string;
  readonly channelId: string;
  readonly auth: OpenEverywhereTeamsAuth;
  readonly trigger: TeamsSupervisorWakeInput["trigger"];
  readonly threadRootId?: string;
  readonly engagementTier?: WakeEngagementTier;
  readonly window: UnifiedWindowWake;
}

export async function handleTeamsSingleWindowDispatch(d: TeamsSupervisorDispatch, deps: TeamsSupervisorDeps): Promise<void> {
  const atIso = deps.now ? deps.now() : new Date().toISOString();
  const session = await deps.getOrCreateSession(d.surfaceKey, d.channelId, atIso);

  const doWake = async (token: string, generation: number, handoffNote: string | null | undefined) => {
    const nw = buildTeamsSupervisorWake({
      channelId: d.channelId,
      trigger: d.trigger,
      threadRootId: d.threadRootId,
      directMention: d.window.addressing === "direct-mention",
      wakeId: d.window.wakeId,
      engagementTier: d.engagementTier,
      handoffNote: handoffNote ?? undefined,
      handoffFromGeneration: generation - 1,
    });
    const { message, context } = renderWake(nw, deps.now);
    await deps.wake({ token, auth: d.auth, message, context: context ?? [], window: d.window });
  };

  try {
    await doWake(session.token, session.generation, session.freshGeneration ? session.handoffNote : undefined);
  } catch (err) {
    if (classifySessionSendError(err) !== "terminal" || !deps.forceRotate) throw err;
    if (deps.audit) await deps.audit("teams.session_terminal_death", { surfaceKey: d.surfaceKey, token: session.token, generation: session.generation });
    const fresh = await deps.forceRotate(d.surfaceKey, d.channelId, atIso);
    await doWake(fresh.token, fresh.generation, fresh.handoffNote);
  }
  if (deps.touchSession) await deps.touchSession(d.surfaceKey, atIso);
}
