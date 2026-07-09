import {
  gateNotionDelivery,
  parseVerificationHandshake,
  notionEventType,
  commentIdFromEvent,
  pageIdFromEvent,
  retrieveComment,
  listBlockComments,
  richTextToPlainText,
  mentionsUser,
  notionContinuationToken,
  type FetchLike,
  type NotionWebhookEvent,
  type NotionComment,
} from "./notion-api.js";
import { buildNotionAuth, type OpenEverywhereNotionAuth } from "./notion-identity.js";
import { renderContext, type ContextLine } from "./context-render.js";

export interface NotionSessionState {
  readonly discussionId: string | null;
  readonly pageId: string | null;
  readonly workspaceId: string | null;
}

export interface NotionDispatchArgs {
  readonly message: string;
  readonly context: readonly string[];
  readonly auth: OpenEverywhereNotionAuth;
  readonly continuationToken: string;
  readonly state: NotionSessionState;
}

export interface HandleNotionDeliveryDeps {
  readonly secret: string | undefined;
  readonly allowUnverified: boolean;
  readonly apiKey: string | undefined;
  readonly resolveBotUserId: () => Promise<string | undefined>;
  readonly fetch?: FetchLike;
  readonly version?: string;
  readonly dispatch: (args: NotionDispatchArgs) => Promise<void>;
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
    | "not-mentioned"
    | "skipped-self"
    | "dispatched"
    | "no-api-key"
    | "error";
  readonly detail?: string;
}

export async function handleNotionDelivery(
  rawBody: string,
  signatureHeader: string | null,
  deps: HandleNotionDeliveryDeps,
): Promise<NotionDeliveryOutcome> {
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

  if (!deps.apiKey) return { status: 200, body: "ok", action: "no-api-key", detail: "NOTION_API_KEY not set" };
  const apiKey = deps.apiKey;

  const botUserId = await deps.resolveBotUserId();

  let comment: NotionComment;
  try {
    comment = await retrieveComment(commentId, { apiKey, fetch: deps.fetch, version: deps.version });
  } catch (err) {
    return { status: 200, body: "ok", action: "error", detail: `retrieveComment: ${String(err)}` };
  }

  if (botUserId && comment.created_by?.id === botUserId) {
    return { status: 200, body: "ok", action: "skipped-self" };
  }

  if (!mentionsUser(comment.rich_text, botUserId)) {
    return { status: 200, body: "ok", action: "not-mentioned" };
  }

  const message = richTextToPlainText(comment.rich_text);
  const discussionId = comment.discussion_id ?? "";
  const pageId = pageIdFromEvent(ev) ?? comment.parent?.page_id;
  const workspaceId = ev.workspace_id;
  const context = await loadThreadContext(comment, pageId, discussionId, botUserId, {
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

  await deps.dispatch({
    message: message.length > 0 ? message : "(the comment mentioning you had no additional text)",
    context,
    auth,
    continuationToken: notionContinuationToken(discussionId || commentId),
    state: { discussionId: discussionId || null, pageId: pageId ?? null, workspaceId: workspaceId ?? null },
  });

  return { status: 200, body: "ok", action: "dispatched" };
}

async function loadThreadContext(
  trigger: NotionComment,
  pageId: string | undefined,
  discussionId: string,
  botUserId: string | undefined,
  opts: { apiKey: string; fetch?: FetchLike; version?: string },
): Promise<string[]> {
  if (!pageId) return [];
  try {
    const all = await listBlockComments(pageId, opts);
    const lines: ContextLine[] = all
      .filter((c) => c.id !== trigger.id && (discussionId ? c.discussion_id === discussionId : true))
      .map((c) => {
        const text = richTextToPlainText(c.rich_text);
        const authorId = c.created_by?.id;
        if (authorId && botUserId && authorId === botUserId) return { senderType: "agent" as const, ts: c.id ?? "", text };
        if (authorId) return { senderType: "user" as const, senderId: authorId, ts: c.id ?? "", text };
        return { senderType: "unknown" as const, ts: c.id ?? "", text };
      });
    const entry = renderContext(lines, `notion page ${pageId}`);
    return entry ? [entry] : [];
  } catch {
    return [];
  }
}
