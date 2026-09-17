import {
  spreadVendorTs,
  type VendorEventTime,
  renderWake,
  mkMessageTrigger,
  shouldRotate,
  mintWakeId,
  singleWindowMentionPolicy,
  matchesAgentName,
  stampNonMemberChatAuth,
  resolveExternalPolicy,
  withholdsBody,
  withholdWakeBodies,
  ingestedAfterWithholding,
  type ExternalPolicy,
  type IngestedChatMessage,
  type NormalizedWake,
  type WakeEngagementTier,
  type WakeMessageInput,
  type WakeTrust,
  type UnifiedWindowWake,
  tailAuthorGrain,
  type SessionTailWakeRow,
  seatCatchUpSinceMs,
  type SeatCatchUpRequest,
  type SeatCatchUpResult,
  engagedFollowUpContract,
} from "@open-everywhere/core/agent/adapter-api.js";
import { mentionsUser, richTextToPlainText, type NotionComment } from "./notion-api.js";
import type { OpenEverywhereNotionAuth } from "./notion-identity.js";
import type { NotionDeliveryTrust } from "./notion-ancestry-trust.js";
import type { NotionSessionState } from "./notion-webhook.js";
import type { NotionVia } from "./notion-scope.js";
import { markNotionEngaged, type NotionSeamFacts } from "./notion-engagement.js";

const NOTION_CATCH_UP_REACHBACK_HOURS = 168;

export function notionSupervisorSentinel(generation: number): string {
  return `oe-sup:g${generation}`;
}

export function notionSupervisorToken(pageId: string, generation: number): string {
  return `notion:${pageId}:${notionSupervisorSentinel(generation)}`;
}

export type NotionAddressing = "direct" | "channel-watch" | "drop";

export interface NotionClassification {
  readonly addressing: NotionAddressing;
  readonly reason: string;
}

export function notionNameDrop(text: string, botName?: string): boolean {
  return matchesAgentName(text, botName);
}

export function classifyNotionComment(comment: NotionComment, botUserId: string | undefined, botName?: string): NotionClassification {
  if (!botUserId) return { addressing: "drop", reason: "unresolved bot user id — fail-closed loop guard" };
  const author = comment.created_by;
  if (author?.id === botUserId) return { addressing: "drop", reason: "self-authored comment (our own reply)" };
  if (!author?.id) return { addressing: "drop", reason: "unidentified author (no created_by.id) — fail-closed loop guard" };
  if (author.type && author.type !== "person") return { addressing: "drop", reason: `bot/integration-authored (${author.type})` };
  if (mentionsUser(comment.rich_text, botUserId)) return { addressing: "direct", reason: "structured bot @mention" };
  if (notionNameDrop(richTextToPlainText(comment.rich_text), botName)) {
    return { addressing: "direct", reason: "bot name-drop (synthetic mention — Notion has no @mention for integrations)" };
  }
  return { addressing: "channel-watch", reason: "ambient comment — judged by the doc supervisor" };
}

export interface NotionSingleWindowTarget {
  readonly discussionId: string;
  readonly pageId?: string;
  readonly workspaceId?: string | null;
  readonly credentialId?: string;
  readonly vendorTs?: VendorEventTime;
}

export function planNotionSingleWindow(
  singleWindow: boolean,
  isMention: boolean,
  privacyOk: boolean,
  target: NotionSingleWindowTarget,
): UnifiedWindowWake | undefined {
  const policy = singleWindowMentionPolicy(singleWindow, isMention, privacyOk);
  const divert = isMention ? policy.suppressNative : singleWindow && privacyOk;
  if (!divert) return undefined;
  if (!target.discussionId) return undefined;
  return {
    wakeId: mintWakeId(),
    origin: {
      platform: "notion",
      discussionId: target.discussionId,
      ...(target.pageId ? { pageId: target.pageId } : {}),
      ...(target.workspaceId ? { workspaceId: target.workspaceId } : {}),
      ...(target.credentialId ? { credentialId: target.credentialId } : {}),
    },
    ...(policy.addressing !== undefined ? { addressing: policy.addressing } : {}),
    ...spreadVendorTs(target.vendorTs),
  };
}

export interface NotionWakeMessage {
  readonly from: "human" | "self";
  readonly id: string;
  readonly authorId?: string;
  readonly sentAt: string;
  readonly text: string;
  readonly anchorId?: string;
  readonly trust: WakeTrust;
}

export type NotionUntieredWakeMessage = Omit<NotionWakeMessage, "trust">;

export interface NotionSupervisorWakeInput {
  readonly addressing: Exclude<NotionAddressing, "drop">;
  readonly pageId: string;
  readonly discussionId: string;
  readonly trigger: NotionWakeMessage;
  readonly threadComments?: readonly NotionWakeMessage[];
  readonly tail?: readonly WakeMessageInput[];
  readonly catchUpUnavailable?: string;
  readonly engagementTier?: WakeEngagementTier;
  readonly wakeId?: string;
  readonly directMention?: boolean;
  readonly threadEngaged?: boolean;
}

function toWakeSibling(m: NotionWakeMessage): WakeMessageInput {
  return {
    from: m.from,
    author: m.authorId ?? (m.from === "self" ? "the doc agent" : "unknown"),
    authorId: m.authorId,
    id: m.id,
    sentAt: m.sentAt,
    trust: m.trust,
    body: m.text,
  };
}

export function buildNotionSupervisorWake(input: NotionSupervisorWakeInput): NormalizedWake {
  const directMention = input.directMention === true && input.addressing === "direct";
  const judged = input.addressing === "channel-watch";
  const enveloped = judged || directMention;
  const backscroll = enveloped ? [...(input.tail ?? []), ...(input.threadComments ?? []).map(toWakeSibling)] : undefined;
  return {
    platform: "notion",
    reason: input.addressing === "direct" ? "mention" : "channel-activity",
    addressing: directMention ? "direct-mention" : input.addressing,
    containerNoun: "doc",
    engagementTier: judged ? input.engagementTier : undefined,
    followUp: engagedFollowUpContract({
      addressing: directMention ? "direct-mention" : input.addressing,
      threadEngaged: input.threadEngaged,
    }),
    wakeId: input.wakeId,
    locus: {
      channel: { id: input.pageId },
      thread: { ts: input.discussionId },
    },
    backscroll,
    ...(input.catchUpUnavailable !== undefined ? { catchUpUnavailable: input.catchUpUnavailable } : {}),
    trigger: mkMessageTrigger({
      from: input.trigger.from,
      author: input.trigger.authorId ?? "unknown",
      authorId: input.trigger.authorId,
      id: input.trigger.id,
      sentAt: input.trigger.sentAt,
      trust: input.trigger.trust,
      mention: input.addressing === "direct",
      body: input.trigger.text,
    }),
  };
}

export interface NotionSupervisorSession {
  readonly token: string;
  readonly generation: number;
  readonly freshGeneration: boolean;
  readonly tail: readonly WakeMessageInput[];
  readonly lastWakeAt?: string | null;
}

export interface NotionSupervisorDeps {
  readonly getOrCreateSession: (surfaceKey: string, pageId: string, atIso: string) => Promise<NotionSupervisorSession>;
  readonly touchSession?: (surfaceKey: string, atIso: string) => Promise<void>;
  readonly catchUp?: (req: SeatCatchUpRequest) => Promise<SeatCatchUpResult>;
  readonly markEngaged?: (d: NotionSupervisorDispatch) => Promise<void>;
  readonly recordWake?: (entry: SessionTailWakeRow, token: string, surfaceKey: string) => Promise<void>;

  readonly wake: (input: {
    token: string;
    auth: OpenEverywhereNotionAuth;
    message: string;
    context: readonly string[];
    state: NotionSessionState;
    window?: UnifiedWindowWake;
  }) => Promise<void>;
  readonly memoryDelta?: (sinceIso: string, atIso: string, selfKey?: string) => Promise<string | null>;
  readonly now?: () => string;
}

export interface NotionSupervisorDispatch {
  readonly surfaceKey: string;
  readonly credentialId: string;
  readonly addressing: Exclude<NotionAddressing, "drop">;
  readonly pageId: string;
  readonly discussionId: string;
  readonly workspaceId: string | null;
  readonly auth: OpenEverywhereNotionAuth;
  readonly trigger: NotionWakeMessage;
  readonly threadComments: readonly NotionWakeMessage[];
  readonly engagementTier?: WakeEngagementTier;
  readonly externalPolicy?: ExternalPolicy;
  readonly unified?: boolean;
  readonly window?: UnifiedWindowWake;
  readonly trust?: NotionDeliveryTrust;
  readonly directMention?: boolean;
  readonly engagedFollowUp?: boolean;
  readonly domainVia?: NotionVia;
}

export interface NotionUntieredSupervisorDispatch extends Omit<NotionSupervisorDispatch, "trigger" | "threadComments"> {
  readonly trigger: NotionUntieredWakeMessage;
  readonly threadComments: readonly NotionUntieredWakeMessage[];
}

export function notionIngestedMessages(d: {
  readonly workspaceId: string | null;
  readonly trigger: NotionWakeMessage;
  readonly threadComments: readonly NotionWakeMessage[];
}): readonly IngestedChatMessage[] {
  const tenantKey = d.workspaceId ? `notion/${d.workspaceId}` : undefined;
  const grade = (m: NotionWakeMessage): IngestedChatMessage => ({
    ...(m.trust === undefined ? {} : { trust: m.trust }),
    ...(tenantKey === undefined ? {} : { authorTrust: { tenantKey, ...(m.authorId === undefined ? {} : { authorId: m.authorId }) } }),
  });
  return [grade(d.trigger), ...d.threadComments.map(grade)];
}

export function notionExternalAuthorDecision(d: {
  readonly trigger: NotionWakeMessage;
  readonly threadComments: readonly NotionWakeMessage[];
  readonly ingested: readonly IngestedChatMessage[];
  readonly policy: ExternalPolicy;
}): { readonly suppressed: boolean; readonly withheldIds: ReadonlySet<string> } {
  const ordered = [d.trigger, ...d.threadComments];
  const withheldIds = new Set<string>();
  let suppressed = false;
  for (const [i, m] of ordered.entries()) {
    const facts = d.ingested[i];
    if (facts === undefined || !withholdsBody(facts, d.policy)) continue;
    if (i === 0) suppressed = true;
    else withheldIds.add(m.id);
  }
  return { suppressed, withheldIds };
}

async function liveNotionEngagementMark(d: NotionSupervisorDispatch): Promise<void> {
  const facts: NotionSeamFacts = {
    workspaceId: d.workspaceId ?? undefined,
    pageId: d.pageId,
    ...(d.trigger.authorId ? { principalId: d.trigger.authorId } : {}),
    ...(d.credentialId ? { credentialId: d.credentialId } : {}),
  };
  await markNotionEngaged(facts, d.trigger.id);
}

export async function handleNotionSupervisorDispatch(d: NotionSupervisorDispatch, deps: NotionSupervisorDeps): Promise<void> {
  const atIso = deps.now ? deps.now() : new Date().toISOString();
  const policy = d.externalPolicy ?? resolveExternalPolicy();
  const ingested = notionIngestedMessages(d);
  const external = notionExternalAuthorDecision({ trigger: d.trigger, threadComments: d.threadComments, ingested, policy });
  if (external.suppressed) return;
  if (d.addressing === "direct") await (deps.markEngaged ?? liveNotionEngagementMark)(d);
  const session = await deps.getOrCreateSession(d.surfaceKey, d.pageId, atIso);
  const state: NotionSessionState = {
    discussionId: d.discussionId || null,
    pageId: d.pageId || null,
    workspaceId: d.workspaceId,
    ...(d.unified ? { oeUnified: true } : {}),
  };

  let memoryDelta: string | undefined;
  if (deps.memoryDelta && session.lastWakeAt) {
    try {
      memoryDelta = (await deps.memoryDelta(session.lastWakeAt, atIso, session.token)) ?? undefined;
    } catch {
      memoryDelta = undefined;
    }
  }

  const doWake = async (token: string, generation: number, tail: readonly WakeMessageInput[], catchUpUnavailable?: string) => {
    const built: NormalizedWake = {
      ...buildNotionSupervisorWake({
        addressing: d.addressing,
        pageId: d.pageId,
        discussionId: d.discussionId,
        trigger: d.trigger,
        threadComments: d.threadComments,
        engagementTier: d.engagementTier,
        wakeId: d.window?.wakeId,
        directMention: d.directMention,
        threadEngaged: d.engagedFollowUp,
        tail,
        catchUpUnavailable,
      }),
      ...(memoryDelta ? { memoryDelta } : {}),
    };
    const nw = withholdWakeBodies(built, (m) => external.withheldIds.has(m.id));
    const { message, context } = renderWake(nw, deps.now);
    const auth = stampNonMemberChatAuth(d.auth, ingestedAfterWithholding(ingested, policy), { surfaceKey: d.surfaceKey });
    await deps.wake({ token, auth, message, context: context ?? [], state, window: d.window });
  };

  const catchUp =
    session.freshGeneration || !deps.catchUp
      ? undefined
      : await deps.catchUp({
          container: d.pageId,
          ...(d.discussionId ? { threadRoot: d.discussionId } : {}),
          ...(d.trigger.anchorId ? { threadAnchor: d.trigger.anchorId } : {}),
          sinceMs: seatCatchUpSinceMs(session.lastWakeAt, Date.parse(atIso) || Date.now(), NOTION_CATCH_UP_REACHBACK_HOURS),
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
        from: d.trigger.from,
        trust: d.trigger.trust,
        ...tailAuthorGrain(ingested[0] ?? { trust: d.trigger.trust }),
        author: d.trigger.authorId ?? "unknown",
        ...(d.trigger.authorId ? { authorId: d.trigger.authorId } : {}),
        id: d.trigger.id,
        platform: "notion",
        container: d.surfaceKey,
        threadRoot: d.discussionId,
        text: d.trigger.text,
      },
      session.token,
      d.surfaceKey,
    );
  }
}

export { shouldRotate };
