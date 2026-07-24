import {
  renderWake,
  mkMessageTrigger,
  shouldRotate,
  classifySessionSendError,
  mintWakeId,
  singleWindowMentionPolicy,
  type NormalizedWake,
  type WakeEngagementTier,
  type WakeMessageInput,
  type WakeTrust,
  type UnifiedWindowWake,
} from "@open-everywhere/core/agent/adapter-api.js";
import { mentionsUser, richTextToPlainText, type NotionComment } from "./notion-api.js";
import type { OpenEverywhereNotionAuth } from "./notion-identity.js";
import type { NotionSessionState } from "./notion-webhook.js";

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
  if (!text) return false;
  const patterns: RegExp[] = [/\bopen\s?everywhere\b/iu, /\boe\b/iu];
  const name = botName?.trim();
  if (name && name.length >= 2) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    patterns.push(new RegExp(`\\b${escaped}\\b`, "iu"));
  }
  return patterns.some((re) => re.test(text));
}

export function classifyNotionComment(comment: NotionComment, botUserId: string | undefined, botName?: string): NotionClassification {
  if (!botUserId) return { addressing: "drop", reason: "unresolved bot user id — fail-closed loop guard" };
  const author = comment.created_by;
  if (author?.id === botUserId) return { addressing: "drop", reason: "self-authored comment (our own reply)" };
  if (author?.type && author.type !== "person") return { addressing: "drop", reason: `bot/integration-authored (${author.type})` };
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
    },
    ...(policy.addressing !== undefined ? { addressing: policy.addressing } : {}),
  };
}

export interface NotionWakeMessage {
  readonly from: "human" | "self";
  readonly id: string;
  readonly authorId?: string;
  readonly sentAt: string;
  readonly text: string;
  readonly trust?: WakeTrust;
}

export interface NotionSupervisorWakeInput {
  readonly addressing: Exclude<NotionAddressing, "drop">;
  readonly pageId: string;
  readonly discussionId: string;
  readonly trigger: NotionWakeMessage;
  readonly threadComments?: readonly NotionWakeMessage[];
  readonly handoffNote?: string | null;
  readonly handoffFromGeneration?: number;
  readonly engagementTier?: WakeEngagementTier;
  readonly unified?: boolean;
  readonly wakeId?: string;
  readonly directMention?: boolean;
}

function toWakeSibling(m: NotionWakeMessage): WakeMessageInput {
  return {
    from: m.from,
    author: m.authorId ?? (m.from === "self" ? "the doc agent" : "unknown"),
    authorId: m.authorId,
    id: m.id,
    sentAt: m.sentAt,
    trust: m.trust ?? "peer",
    body: m.text,
  };
}

export function buildNotionSupervisorWake(input: NotionSupervisorWakeInput): NormalizedWake {
  const directMention = input.directMention === true && input.addressing === "direct";
  const judged = input.addressing === "channel-watch";
  const enveloped = judged || directMention;
  const backscroll = enveloped ? (input.threadComments ?? []).map(toWakeSibling) : undefined;
  const handoff =
    enveloped && input.handoffNote
      ? { note: input.handoffNote, fromGeneration: input.handoffFromGeneration ?? 0 }
      : undefined;
  return {
    platform: "notion",
    reason: input.addressing === "direct" ? "mention" : "channel-activity",
    addressing: directMention ? "direct-mention" : input.addressing,
    containerNoun: "doc",
    engagementTier: judged ? input.engagementTier : undefined,
    unifiedDisclosure: enveloped && input.unified === true ? true : undefined,
    wakeId: input.wakeId,
    locus: {
      channel: { id: input.pageId, ...(input.unified ? { platform: "notion" } : {}) },
      thread: { ts: input.discussionId },
    },
    backscroll,
    handoff,
    trigger: mkMessageTrigger({
      from: input.trigger.from,
      author: input.trigger.authorId ?? "unknown",
      authorId: input.trigger.authorId,
      id: input.trigger.id,
      sentAt: input.trigger.sentAt,
      trust: input.trigger.trust ?? (input.addressing === "direct" ? "principal" : "peer"),
      mention: input.addressing === "direct",
      body: input.trigger.text,
    }),
  };
}

export interface NotionSupervisorSession {
  readonly token: string;
  readonly generation: number;
  readonly freshGeneration: boolean;
  readonly handoffNote?: string | null;
  readonly lastWakeAt?: string | null;
}

export interface NotionSupervisorDeps {
  readonly getOrCreateSession: (surfaceKey: string, pageId: string, atIso: string) => Promise<NotionSupervisorSession>;
  readonly touchSession?: (surfaceKey: string, atIso: string) => Promise<void>;
  readonly forceRotate?: (surfaceKey: string, pageId: string, atIso: string) => Promise<{ token: string; generation: number; handoffNote: string | null }>;
  readonly wake: (input: {
    token: string;
    auth: OpenEverywhereNotionAuth;
    message: string;
    context: readonly string[];
    state: NotionSessionState;
    window?: UnifiedWindowWake;
  }) => Promise<void>;
  readonly audit?: (action: string, detail: Record<string, unknown>) => Promise<void>;
  readonly memoryDelta?: (sinceIso: string, atIso: string, selfKey?: string) => Promise<string | null>;
  readonly now?: () => string;
}

export interface NotionSupervisorDispatch {
  readonly surfaceKey: string;
  readonly addressing: Exclude<NotionAddressing, "drop">;
  readonly pageId: string;
  readonly discussionId: string;
  readonly workspaceId: string | null;
  readonly auth: OpenEverywhereNotionAuth;
  readonly trigger: NotionWakeMessage;
  readonly threadComments: readonly NotionWakeMessage[];
  readonly engagementTier?: WakeEngagementTier;
  readonly unified?: boolean;
  readonly window?: UnifiedWindowWake;
  readonly directMention?: boolean;
}

export async function handleNotionSupervisorDispatch(d: NotionSupervisorDispatch, deps: NotionSupervisorDeps): Promise<void> {
  const atIso = deps.now ? deps.now() : new Date().toISOString();
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

  const doWake = async (token: string, generation: number, handoffNote: string | null | undefined) => {
    const nw: NormalizedWake = {
      ...buildNotionSupervisorWake({
        addressing: d.addressing,
        pageId: d.pageId,
        discussionId: d.discussionId,
        trigger: d.trigger,
        threadComments: d.threadComments,
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
    await deps.wake({ token, auth: d.auth, message, context: context ?? [], state, window: d.window });
  };

  try {
    await doWake(session.token, session.generation, session.freshGeneration ? session.handoffNote : undefined);
  } catch (err) {
    if (classifySessionSendError(err) !== "terminal" || !deps.forceRotate) throw err;
    if (deps.audit) await deps.audit("notion.session_terminal_death", { surfaceKey: d.surfaceKey, token: session.token, generation: session.generation });
    const fresh = await deps.forceRotate(d.surfaceKey, d.pageId, atIso);
    await doWake(fresh.token, fresh.generation, fresh.handoffNote);
  }
  if (deps.touchSession) await deps.touchSession(d.surfaceKey, atIso);
}

export { shouldRotate };
