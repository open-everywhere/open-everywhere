import {
  gateNotionDelivery,
  parseVerificationHandshake,
  notionEventType,
  commentIdFromEvent,
  pageIdFromEvent,
  retrieveComment,
  listBlockComments,
  richTextToPlainText,
  type FetchLike,
  type NotionWebhookEvent,
  type NotionComment,
} from "./notion-api.js";
import { buildNotionAuth, notionSurfaceKey } from "./notion-identity.js";
import { classifyNotionComment, type NotionSupervisorDispatch, type NotionWakeMessage } from "./notion-supervisor.js";

export interface NotionReplyTarget {
  readonly discussionId: string;
  readonly pageId?: string;
  readonly workspaceId?: string;
}

export interface NotionSessionState {
  readonly discussionId: string | null;
  readonly pageId: string | null;
  readonly workspaceId: string | null;
  oeReplyTarget?: NotionReplyTarget;
  readonly oeUnified?: boolean;
}

export interface HandleNotionDeliveryDeps {
  readonly secret: string | undefined;
  readonly allowUnverified: boolean;
  readonly apiKey: string | undefined;
  readonly resolveBotUserId: () => Promise<string | undefined>;
  readonly resolveBotName?: () => Promise<string | undefined>;
  readonly ambientEnabled: (surfaceKey: string) => boolean;
  readonly engagementTier?: (surfaceKey: string) => "aggressive" | "neutral" | "reserved";
  readonly fetch?: FetchLike;
  readonly version?: string;
  readonly dispatch: (d: NotionSupervisorDispatch) => Promise<void>;
  readonly onHandshakeToken?: (token: string) => void;
}

export interface NotionDeliveryOutcome {
  readonly status: number;
  readonly body: string;
  readonly action:
    | "handshake"
    | "rejected"
    | "bad-json"
    | "ignored"
    | "ambient-disabled"
    | "skipped-self"
    | "skipped-bot"
    | "dropped"
    | "dispatched"
    | "no-api-key"
    | "error";
  readonly detail?: string;
  readonly verified: boolean;
}

export async function handleNotionDelivery(
  rawBody: string,
  signatureHeader: string | null,
  deps: HandleNotionDeliveryDeps,
): Promise<NotionDeliveryOutcome> {
  const out = await deliver(rawBody, signatureHeader, deps);
  return { ...out, verified: Boolean(deps.secret) && out.action !== "handshake" && out.action !== "rejected" };
}

async function deliver(
  rawBody: string,
  signatureHeader: string | null,
  deps: HandleNotionDeliveryDeps,
): Promise<Omit<NotionDeliveryOutcome, "verified">> {
  const handshake = parseVerificationHandshake(rawBody);
  if (handshake) {
    deps.onHandshakeToken?.(handshake);
    return { status: 200, body: "ok", action: "handshake" };
  }

  const rejection = gateNotionDelivery(deps.secret, rawBody, signatureHeader, deps.allowUnverified);
  if (rejection) return { status: 401, body: rejection, action: "rejected", detail: rejection };

  let ev: NotionWebhookEvent;
  try {
    ev = JSON.parse(rawBody) as NotionWebhookEvent;
  } catch {
    return { status: 400, body: "bad json", action: "bad-json" };
  }

  if (notionEventType(ev) !== "comment.created") {
    return { status: 200, body: "ignored", action: "ignored", detail: notionEventType(ev) };
  }
  const commentId = commentIdFromEvent(ev);
  if (!commentId) return { status: 200, body: "ignored", action: "ignored", detail: "no comment id" };

  if (!deps.apiKey) return { status: 200, body: "ok", action: "no-api-key", detail: "NOTION_CHANNEL_API_KEY not set" };
  const apiKey = deps.apiKey;

  const botUserId = await deps.resolveBotUserId();
  const botName = deps.resolveBotName ? await deps.resolveBotName() : undefined;

  let comment: NotionComment;
  try {
    comment = await retrieveComment(commentId, { apiKey, fetch: deps.fetch, version: deps.version });
  } catch (err) {
    return { status: 200, body: "ok", action: "error", detail: `retrieveComment: ${String(err)}` };
  }

  const pageId = pageIdFromEvent(ev) ?? comment.parent?.page_id;
  const discussionId = comment.discussion_id ?? "";
  const workspaceId = ev.workspace_id;
  const surface = pageId ?? (discussionId || undefined) ?? commentId;
  const surfaceKey = notionSurfaceKey(workspaceId, surface);

  if (!deps.ambientEnabled(surfaceKey)) {
    return { status: 200, body: "ok", action: "ambient-disabled", detail: surfaceKey };
  }

  const classification = classifyNotionComment(comment, botUserId, botName);
  if (classification.addressing === "drop") {
    const reason = classification.reason;
    const action = reason.startsWith("self") ? "skipped-self" : reason.startsWith("bot") ? "skipped-bot" : "dropped";
    return { status: 200, body: "ok", action, detail: reason };
  }

  const triggerText = richTextToPlainText(comment.rich_text);
  const trigger: NotionWakeMessage = {
    from: "human",
    id: commentId,
    authorId: comment.created_by?.id,
    sentAt: comment.created_time ?? new Date().toISOString(),
    text: triggerText.length > 0 ? triggerText : "(the comment had no additional text)",
  };
  const threadComments = await loadThreadSiblings(comment, pageId, discussionId, botUserId, {
    apiKey,
    fetch: deps.fetch,
    version: deps.version,
  });
  const auth = buildNotionAuth({
    workspaceId,
    pageId,
    discussionId: discussionId || undefined,
    commentId,
    principalId: comment.created_by?.id,
  });

  let engagementTier: "aggressive" | "neutral" | "reserved" | undefined;
  try {
    engagementTier = deps.engagementTier?.(surfaceKey);
  } catch {
    engagementTier = undefined;
  }

  await deps.dispatch({
    surfaceKey,
    addressing: classification.addressing,
    pageId: pageId ?? "",
    discussionId,
    workspaceId: workspaceId ?? null,
    auth,
    trigger,
    threadComments,
    engagementTier,
  });

  return { status: 200, body: "ok", action: "dispatched", detail: classification.addressing };
}

async function loadThreadSiblings(
  trigger: NotionComment,
  pageId: string | undefined,
  discussionId: string,
  botUserId: string | undefined,
  opts: { apiKey: string; fetch?: FetchLike; version?: string },
): Promise<NotionWakeMessage[]> {
  if (!pageId) return [];
  try {
    const all = await listBlockComments(pageId, opts);
    return all
      .filter((c) => c.id !== trigger.id && (discussionId ? c.discussion_id === discussionId : true))
      .map((c) => {
        const authorId = c.created_by?.id;
        const isSelf = Boolean(authorId && botUserId && authorId === botUserId);
        const isPerson = c.created_by?.type === "person";
        return {
          from: isSelf ? ("self" as const) : ("human" as const),
          id: c.id ?? "",
          authorId: isSelf || !isPerson ? undefined : authorId,
          sentAt: c.created_time ?? "",
          text: richTextToPlainText(c.rich_text),
        };
      })
      .filter((m) => m.text.length > 0);
  } catch {
    return [];
  }
}
