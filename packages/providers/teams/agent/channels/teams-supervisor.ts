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
  tailAuthorGrain,
  type IngestedChatMessage,
  type SessionTailWakeRow,
  seatCatchUpSinceMs,
  catchUpUnavailableReason,
  type SeatCatchUpRequest,
  type SeatCatchUpResult,
  coverForWake,
  engagedFollowUpContract,
} from "@open-everywhere/core/agent/adapter-api.js";
import type { OpenEverywhereTeamsAuth } from "./teams-identity.js";

const TEAMS_CATCH_UP_REACHBACK_HOURS = 168;

const TEAM_ADDRESS_UNRESOLVED_NOTE =
  "teams: this team's Microsoft 365 group id could not be resolved on this wake, so the channel's history since your last wake is NOT shown. That is a failure to READ, not a quiet room — an absence of messages here says nothing about what was said.";

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
  readonly nameDrop?: boolean;
  readonly threadEngaged?: boolean;
  readonly tail?: readonly WakeMessageInput[];
  readonly catchUpUnavailable?: string;
}

export function buildTeamsSupervisorWake(input: TeamsSupervisorWakeInput): NormalizedWake {
  const nameDrop = !input.directMention && input.nameDrop === true;
  const addressing = input.directMention ? "direct-mention" : nameDrop ? "name-drop" : "channel-watch";
  return {
    platform: "teams",
    reason: input.directMention ? "mention" : "channel-activity",
    addressing,
    engagementTier: input.directMention || nameDrop ? undefined : input.engagementTier,
    ...(nameDrop
      ? { nameDrop: { followUp: input.threadEngaged === true ? ("thread-engaged" as const) : ("channel-not-following" as const) } }
      : {}),
    followUp: engagedFollowUpContract({ addressing, threadEngaged: input.threadEngaged }),
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
  readonly recordWake?: (entry: SessionTailWakeRow, token: string, surfaceKey: string) => Promise<void>;

  readonly wake: (input: { token: string; auth: OpenEverywhereTeamsAuth; message: string; context: readonly string[]; window: UnifiedWindowWake }) => Promise<void>;
  readonly now?: () => string;
}

export interface TeamsSupervisorDispatch {
  readonly surfaceKey: string;
  readonly containerKey: string;
  readonly channelId: string;
  readonly teamId?: string;
  readonly teamAddressUnresolved?: boolean;
  readonly auth: OpenEverywhereTeamsAuth;
  readonly ingested: readonly IngestedChatMessage[];
  readonly trigger: TeamsSupervisorWakeInput["trigger"];
  readonly threadRootId?: string;
  readonly replyChainRootId?: string;
  readonly engagementTier?: WakeEngagementTier;
  readonly nameDrop?: boolean;
  readonly threadEngaged?: boolean;
  readonly window: UnifiedWindowWake;
  readonly cover?: TeamsCoverFacts;
}

export interface TeamsCoverFacts {
  readonly org: string;
  readonly workspace: string;
  readonly surface: string;
  readonly mentionedIds: readonly string[];
  readonly confirmInRoom?: (id: string) => Promise<boolean>;
}

export function teamsMentionedPersonIds(mentions: ReadonlyArray<{ readonly mentioned: { readonly id: string } }>, botId?: string): string[] {
  return mentions.map((m) => m.mentioned.id).filter((id) => id !== botId && /^29:/.test(id));
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
      ...(d.nameDrop === true ? { nameDrop: true } : {}),
      ...(d.threadEngaged === true ? { threadEngaged: true } : {}),
      tail,
      catchUpUnavailable,
    });
    const cover = d.cover
      ? await coverForWake({
          org: d.cover.org,
          platform: "teams",
          workspace: d.cover.workspace,
          surface: d.cover.surface,
          surfaceKey: d.containerKey,
          channelId: d.channelId,
          roomPublic: false,
          wakeId: d.window.wakeId,
          mentionedIds: d.cover.mentionedIds,
          askerId: d.trigger.authorId,
          ...(d.trigger.authorName ? { askerName: d.trigger.authorName } : {}),
          text: d.trigger.text,
          now: new Date(atIso),
          ...(d.cover.confirmInRoom ? { confirmInRoom: d.cover.confirmInRoom } : {}),
        }).catch(() => ({ covered: [] }) as { systemNote?: string })
      : undefined;
    const wake = cover?.systemNote ? { ...nw, systemNote: nw.systemNote ? `${nw.systemNote}\n${cover.systemNote}` : cover.systemNote } : nw;
    const { message, context } = renderWake(wake, deps.now);
    await deps.wake({ token, auth: d.auth, message, context: context ?? [], window: d.window });
  };

  const catchUpRoot = d.replyChainRootId ?? d.threadRootId;
  const catchUp =
    session.freshGeneration || !deps.catchUp
      ? undefined
      : !d.teamId
        ? {
            messages: [] as readonly WakeMessageInput[],
            unavailable: d.teamAddressUnresolved ? TEAM_ADDRESS_UNRESOLVED_NOTE : catchUpUnavailableReason("teams"),
          }
        : await deps.catchUp({
            container: `${d.teamId}/${d.channelId}`,
            ...(catchUpRoot ? { threadRoot: catchUpRoot } : {}),
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
        ...tailAuthorGrain(d.ingested[0] ?? { trust: d.trigger.trust }),
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

