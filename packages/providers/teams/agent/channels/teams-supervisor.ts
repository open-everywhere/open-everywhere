import {
  spreadVendorTs,
  type VendorEventTime,
  renderWake,
  mkMessageTrigger,
  mintWakeId,
  singleWindowMentionPolicy,
  type NormalizedWake,
  type WakeEngagementTier,
  type WakeTrust,
  type SingleWindowMentionPolicy,
  type UnifiedWindowWake,
  type WakeMessageInput,
  type SessionTailEntry,
  seatCatchUpSinceMs,
  catchUpUnavailableReason,
  type SeatCatchUpRequest,
  type SeatCatchUpResult,
} from "@open-everywhere/core/agent/adapter-api.js";
import type { OpenEverywhereTeamsAuth } from "./teams-identity.js";

const TEAMS_CATCH_UP_REACHBACK_HOURS = 168;

function teamsSupervisorSentinel(generation: number): string {
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

function teamsSingleWindowMentionPolicy(singleWindow: boolean, isMention: boolean, facts: TeamsSingleWindowFacts): SingleWindowMentionPolicy {
  return singleWindowMentionPolicy(singleWindow, isMention, teamsSingleWindowPrivacyOk(facts));
}

export interface TeamsSingleWindowTarget {
  readonly serviceUrl: string;
  readonly conversationId: string;
  readonly replyToActivityId?: string;
  readonly tenantId?: string;
  readonly vendorTs?: VendorEventTime;
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
    ...spreadVendorTs(target.vendorTs),
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
    readonly trust: WakeTrust;
  };
  readonly threadRootId?: string;
  readonly directMention: boolean;
  readonly wakeId: string;
  readonly engagementTier?: WakeEngagementTier;
  readonly tail?: readonly WakeMessageInput[];
  readonly catchUpUnavailable?: string;
}

export function buildTeamsSupervisorWake(input: TeamsSupervisorWakeInput): NormalizedWake {
  return {
    platform: "teams",
    reason: input.directMention ? "mention" : "channel-activity",
    addressing: input.directMention ? "direct-mention" : "channel-watch",
    engagementTier: input.directMention ? undefined : input.engagementTier,
    wakeId: input.wakeId,
    locus: {
      channel: { id: input.channelId },
      ...(input.threadRootId ? { thread: { ts: input.threadRootId } } : {}),
    },
    ...(input.trigger.authorName ? { participants: [{ id: input.trigger.authorId, name: input.trigger.authorName }] } : {}),
    backscroll: input.tail && input.tail.length > 0 ? input.tail : undefined,
    ...(input.catchUpUnavailable !== undefined ? { catchUpUnavailable: input.catchUpUnavailable } : {}),
    trigger: mkMessageTrigger({
      from: "human",
      author: input.trigger.authorName ?? input.trigger.authorId,
      authorId: input.trigger.authorId,
      id: input.trigger.id,
      sentAt: input.trigger.sentAt,
      trust: input.trigger.trust,
      mention: input.directMention,
      body: input.trigger.text,
    }),
  };
}

export interface TeamsSupervisorSession {
  readonly token: string;
  readonly generation: number;
  readonly freshGeneration: boolean;
  readonly lastWakeAt?: string | null;
  readonly tail: readonly WakeMessageInput[];
}

export interface TeamsSupervisorDeps {
  readonly getOrCreateSession: (surfaceKey: string, channelId: string, atIso: string) => Promise<TeamsSupervisorSession>;
  readonly touchSession?: (surfaceKey: string, atIso: string) => Promise<void>;
  readonly catchUp?: (req: SeatCatchUpRequest) => Promise<SeatCatchUpResult>;
  readonly recordWake?: (entry: SessionTailEntry, token: string, surfaceKey: string) => Promise<void>;

  readonly wake: (input: { token: string; auth: OpenEverywhereTeamsAuth; message: string; context: readonly string[]; window: UnifiedWindowWake }) => Promise<void>;
  readonly now?: () => string;
}

export interface TeamsSupervisorDispatch {
  readonly surfaceKey: string;
  readonly containerKey: string;
  readonly channelId: string;
  readonly teamId?: string;
  readonly auth: OpenEverywhereTeamsAuth;
  readonly trigger: TeamsSupervisorWakeInput["trigger"];
  readonly threadRootId?: string;
  readonly engagementTier?: WakeEngagementTier;
  readonly window: UnifiedWindowWake;
}

export async function handleTeamsSingleWindowDispatch(d: TeamsSupervisorDispatch, deps: TeamsSupervisorDeps): Promise<void> {
  const atIso = deps.now ? deps.now() : new Date().toISOString();
  const session = await deps.getOrCreateSession(d.surfaceKey, d.channelId, atIso);

  const doWake = async (token: string, generation: number, tail: readonly WakeMessageInput[], catchUpUnavailable?: string) => {
    const nw = buildTeamsSupervisorWake({
      channelId: d.channelId,
      trigger: d.trigger,
      threadRootId: d.threadRootId,
      directMention: d.window.addressing === "direct-mention",
      wakeId: d.window.wakeId,
      engagementTier: d.engagementTier,
      tail,
      catchUpUnavailable,
    });
    const { message, context } = renderWake(nw, deps.now);
    await deps.wake({ token, auth: d.auth, message, context: context ?? [], window: d.window });
  };

  const catchUp =
    session.freshGeneration || !deps.catchUp
      ? undefined
      : !d.teamId
        ? { messages: [] as readonly WakeMessageInput[], unavailable: catchUpUnavailableReason("teams") }
        : await deps.catchUp({
            container: `${d.teamId}/${d.channelId}`,
            ...(d.threadRootId ? { threadRoot: d.threadRootId } : {}),
            sinceMs: seatCatchUpSinceMs(session.lastWakeAt, Date.parse(atIso) || Date.now(), TEAMS_CATCH_UP_REACHBACK_HOURS),
            untilMs: Date.parse(d.trigger.sentAt) || Date.parse(atIso) || Date.now(),
            excludeId: d.trigger.id,
            channelKey: d.surfaceKey,
          });
  await doWake(session.token, session.generation, session.freshGeneration ? session.tail : (catchUp?.messages ?? []), catchUp?.unavailable);
  if (deps.touchSession) await deps.touchSession(d.surfaceKey, atIso);
  if (deps.recordWake) {
    await deps.recordWake(
      {
        kind: "wake",
        at: atIso,
        from: "human",
        trust: d.trigger.trust,
        author: d.trigger.authorName ?? d.trigger.authorId,
        authorId: d.trigger.authorId,
        id: d.trigger.id,
        platform: "teams",
        container: d.containerKey,
        ...(d.threadRootId ? { threadRoot: d.threadRootId } : {}),
        text: d.trigger.text,
      },
      session.token,
      d.surfaceKey,
    );
  }
}

export interface TeamsDmWakeInput {
  readonly conversationId: string;
  readonly wakeId: string;
  readonly tail?: readonly WakeMessageInput[];
  readonly trigger: {
    readonly id: string;
    readonly author: string;
    readonly authorId: string;
    readonly sentAt: string;
    readonly text: string;
    readonly trust: WakeTrust;
  };
}

export function buildTeamsDmWake(input: TeamsDmWakeInput): NormalizedWake {
  return {
    platform: "teams",
    reason: "dm",
    addressing: "direct-mention",
    wakeId: input.wakeId,
    locus: { channel: { id: input.conversationId } },
    backscroll: input.tail && input.tail.length > 0 ? input.tail : undefined,
    trigger: mkMessageTrigger({
      from: "human",
      author: input.trigger.author,
      authorId: input.trigger.authorId,
      id: input.trigger.id,
      sentAt: input.trigger.sentAt,
      trust: input.trigger.trust,
      mention: true,
      body: input.trigger.text,
    }),
  };
}

