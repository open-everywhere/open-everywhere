import {
  gateNotionDeliveryAcross,
  parseVerificationHandshake,
  notionEventType,
  commentIdFromEvent,
  pageIdFromEvent,
  retrieveComment,
  listBlockComments,
  resolveBlockOwningPage,
  richTextToPlainText,
  type FetchLike,
  type NotionWebhookEvent,
  type NotionComment,
  type NotionSigningKey,
  type NotionCallOpts,
  type ResolvedNotionCredential,
} from "./notion-api.js";
import { buildNotionAuth, notionSurfaceKey } from "./notion-identity.js";
import { notionDeliveryScopeVerdict } from "./notion-credentials.js";
import { notionRosterWorkspace } from "./notion-scope.js";
import { classifyNotionComment, type NotionSupervisorDispatch, type NotionWakeMessage } from "./notion-supervisor.js";
import { OE_ADDRESSED_ATTR, OE_BOT_NAME_ATTR, type Domain } from "@open-everywhere/core/agent/adapter-api.js";

export interface NotionReplyTarget {
  readonly discussionId: string;
  readonly pageId?: string;
  readonly workspaceId?: string;
  readonly credentialId?: string;
}

export interface NotionSessionState {
  readonly discussionId: string | null;
  readonly pageId: string | null;
  readonly workspaceId: string | null;
  oeReplyTarget?: NotionReplyTarget;
  readonly oeUnified?: boolean;
}

export interface HandleNotionDeliveryDeps {
  readonly signingKeys: readonly NotionSigningKey[];
  readonly allowUnverified: boolean;
  readonly credentialFor: (credentialId: string) => Promise<ResolvedNotionCredential | undefined>;
  readonly credentialForPage: (workspaceId: string | undefined, pageId: string | undefined) => string | undefined;
  readonly domains: readonly Domain[];
  readonly resolveBotUserId: (credentialId: string) => Promise<string | undefined>;
  readonly resolveBotName?: (credentialId: string) => Promise<string | undefined>;
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
    | "unresolved-page"
    | "scope-refused"
    | "error";
  readonly detail?: string;
  readonly verified: boolean;
  readonly credentialId?: string;
  readonly signerCredentialId?: string;
}

export async function handleNotionDelivery(
  rawBody: string,
  signatureHeader: string | null,
  deps: HandleNotionDeliveryDeps,
): Promise<NotionDeliveryOutcome> {
  const signer: { credentialId?: string } = {};
  const { signed, ...out } = await deliver(rawBody, signatureHeader, deps, signer);
  const verified = signed === true && out.action !== "handshake" && out.action !== "rejected";
  return { ...out, verified, ...(verified && signer.credentialId ? { signerCredentialId: signer.credentialId } : {}) };
}

type DeliverOutcome = Omit<NotionDeliveryOutcome, "verified"> & { readonly signed?: boolean };

async function deliver(
  rawBody: string,
  signatureHeader: string | null,
  deps: HandleNotionDeliveryDeps,
  signer: { credentialId?: string },
): Promise<DeliverOutcome> {
  const handshake = parseVerificationHandshake(rawBody);
  if (handshake) {
    deps.onHandshakeToken?.(handshake);
    return { status: 200, body: "ok", action: "handshake" };
  }

  const gate = gateNotionDeliveryAcross(deps.signingKeys, rawBody, signatureHeader, deps.allowUnverified);
  if (gate.rejection) return { status: 401, body: gate.rejection, action: "rejected", detail: gate.rejection };
  const signed = gate.verified;
  if (gate.credentialId) signer.credentialId = gate.credentialId;

  let ev: NotionWebhookEvent;
  try {
    ev = JSON.parse(rawBody) as NotionWebhookEvent;
  } catch {
    return { status: 400, body: "bad json", action: "bad-json", signed };
  }

  if (notionEventType(ev) !== "comment.created") {
    return { status: 200, body: "ignored", action: "ignored", detail: notionEventType(ev), signed };
  }
  const commentId = commentIdFromEvent(ev);
  if (!commentId) return { status: 200, body: "ignored", action: "ignored", detail: "no comment id", signed };

  const eventPageId = pageIdFromEvent(ev);
  const credentialId = gate.credentialId ?? deps.credentialForPage(ev.workspace_id, eventPageId) ?? deps.signingKeys[0]?.credentialId;
  if (!credentialId) return { status: 200, body: "ok", action: "no-api-key", detail: "no Notion integration is configured", signed };

  const cred = await deps.credentialFor(credentialId);
  if (!cred) {
    return { status: 200, body: "ok", action: "no-api-key", detail: `no value stored for notion credential "${credentialId}"`, signed, credentialId };
  }

  const botUserId = await deps.resolveBotUserId(credentialId);
  const botName = deps.resolveBotName ? await deps.resolveBotName(credentialId) : undefined;

  let comment: NotionComment;
  try {
    comment = await retrieveComment(commentId, { ...cred, fetch: deps.fetch, version: deps.version });
  } catch (err) {
    return { status: 200, body: "ok", action: "error", detail: `retrieveComment: ${String(err)}`, signed, credentialId };
  }

  const resolvedPage = await resolveDeliveryPage(comment, { ...cred, fetch: deps.fetch, version: deps.version });
  if (!resolvedPage.pageId) {
    return { status: 200, body: "ok", action: "unresolved-page", detail: resolvedPage.reason, signed, credentialId };
  }
  const pageId = resolvedPage.pageId;
  const discussionId = comment.discussion_id ?? "";
  const payloadWorkspaceId = ev.workspace_id;

  const scope = notionDeliveryScopeVerdict(payloadWorkspaceId, pageId, gate.credentialId, deps.domains);
  if (!scope.ok) {
    return { status: 200, body: "ok", action: "scope-refused", detail: scope.reason, signed, credentialId };
  }

  const workspaceId = notionRosterWorkspace(pageId, deps.domains) ?? payloadWorkspaceId;

  const surfaceKey = notionSurfaceKey(workspaceId, pageId);

  if (!deps.ambientEnabled(surfaceKey)) {
    return { status: 200, body: "ok", action: "ambient-disabled", detail: surfaceKey, signed, credentialId };
  }

  const classification = classifyNotionComment(comment, botUserId, botName);
  if (classification.addressing === "drop") {
    const reason = classification.reason;
    const action = reason.startsWith("self") ? "skipped-self" : reason.startsWith("bot") ? "skipped-bot" : "dropped";
    return { status: 200, body: "ok", action, detail: reason, signed, credentialId };
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
    ...cred,
    fetch: deps.fetch,
    version: deps.version,
  });
  const auth = buildNotionAuth({
    workspaceId,
    pageId,
    discussionId: discussionId || undefined,
    commentId,
    principalId: comment.created_by?.id,
    credentialId,
  });
  if (classification.addressing === "direct") {
    auth.attributes[OE_ADDRESSED_ATTR] = "1";
    if (botName && botName.trim().length >= 2) auth.attributes[OE_BOT_NAME_ATTR] = botName.trim();
  }

  let engagementTier: "aggressive" | "neutral" | "reserved" | undefined;
  try {
    engagementTier = deps.engagementTier?.(surfaceKey);
  } catch {
    engagementTier = undefined;
  }

  await deps.dispatch({
    surfaceKey,
    credentialId,
    addressing: classification.addressing,
    pageId,
    discussionId,
    workspaceId: workspaceId ?? null,
    auth,
    trigger,
    threadComments,
    engagementTier,
  });

  return { status: 200, body: "ok", action: "dispatched", detail: classification.addressing, signed, credentialId };
}

export interface ResolvedDeliveryPage {
  readonly pageId?: string;
  readonly reason?: string;
}

export async function resolveDeliveryPage(
  comment: NotionComment,
  opts: NotionCallOpts,
): Promise<ResolvedDeliveryPage> {
  const parent = comment.parent;
  if (parent?.page_id) return { pageId: parent.page_id };
  if (parent?.block_id) {
    const owner = await resolveBlockOwningPage(parent.block_id, opts);
    return owner ? { pageId: owner } : { reason: `comment parent block "${parent.block_id}" resolved no owning page` };
  }
  return { reason: "the retrieved comment carries no page or block parent" };
}

async function loadThreadSiblings(
  trigger: NotionComment,
  pageId: string,
  discussionId: string,
  botUserId: string | undefined,
  opts: NotionCallOpts,
): Promise<NotionWakeMessage[]> {
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
