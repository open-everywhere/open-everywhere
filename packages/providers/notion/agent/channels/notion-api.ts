import { createHmac, timingSafeEqual } from "node:crypto";
import {
  getSecretVia,
  CredentialError,
  findConnectorCredential,
  guardCredentialFetch,
  friendlyOutboundText,
  withRetryAfter,
  type CredentialEndpointRules,
  type RateLimitRetryOptions,
} from "@open-everywhere/core/agent/adapter-api.js";
import { NOTION_CHANNEL_CREDENTIAL, NOTION_PROVIDER } from "./notion-credentials.js";
import type { NotionParentLink } from "./notion-ancestry-trust.js";

const NOTION_API_BASE = "https://api.notion.com";
const NOTION_API_VERSION = "2022-06-28";

const NOTION_FILE_UPLOAD_VERSION = "2026-03-11";

export interface ResolvedNotionCredential {
  readonly apiKey: string;
  readonly endpoints?: CredentialEndpointRules;
}

export async function resolveNotionCredential(
  credentialId: string = NOTION_CHANNEL_CREDENTIAL,
): Promise<ResolvedNotionCredential | undefined> {
  const cred = findConnectorCredential(NOTION_PROVIDER, credentialId);
  if (!cred?.secretRef) return undefined;
  try {
    const k = await getSecretVia(cred.broker, cred.secretRef);
    return k.length > 0 ? { apiKey: k, endpoints: cred.endpoints } : undefined;
  } catch (err) {
    if (err instanceof CredentialError) return undefined;
    throw err;
  }
}

export function parseVerificationHandshake(rawBody: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const o = parsed as Record<string, unknown>;
  const token = o.verification_token;
  if (typeof token === "string" && token.length > 0 && o.type === undefined && o.event_type === undefined) {
    return token;
  }
  return null;
}

export function verifyNotionSignature(secret: string, rawBody: string, signatureHeader: string | null | undefined): boolean {
  if (!signatureHeader) return false;
  const expected = "sha256=" + createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  const a = Buffer.from(signatureHeader);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function gateNotionDelivery(
  secret: string | undefined,
  rawBody: string,
  signatureHeader: string | null,
  allowUnverified: boolean,
): string | null {
  if (!secret) {
    return allowUnverified
      ? null
      : "NOTION_WEBHOOK_SECRET is not set — rejecting unverified delivery (set the verification token, or turn on webhooks.allowUnverifiedNotion in agent/settings/settings.ts for local dev)";
  }
  return verifyNotionSignature(secret, rawBody, signatureHeader) ? null : "invalid signature";
}

export interface NotionSigningKey {
  readonly credentialId: string;
  readonly secret: string | undefined;
}

export interface NotionGateVerdict {
  readonly rejection: string | null;
  readonly credentialId?: string;
  readonly verified: boolean;
}

export function gateNotionDeliveryAcross(
  keys: readonly NotionSigningKey[],
  rawBody: string,
  signatureHeader: string | null,
  allowUnverified: boolean,
): NotionGateVerdict {
  const configured = keys.filter((k): k is NotionSigningKey & { secret: string } => typeof k.secret === "string" && k.secret.length > 0);
  if (configured.length === 0) {
    const rejection = gateNotionDelivery(undefined, rawBody, signatureHeader, allowUnverified);
    return { rejection, verified: false };
  }
  for (const key of configured) {
    if (verifyNotionSignature(key.secret, rawBody, signatureHeader)) {
      return { rejection: null, credentialId: key.credentialId, verified: true };
    }
  }
  return { rejection: "invalid signature", verified: false };
}

export interface NotionWebhookEvent {
  readonly type?: string;
  readonly event_type?: string;
  readonly workspace_id?: string;
  readonly entity?: { readonly id?: string; readonly type?: string };
  readonly data?: {
    readonly page_id?: string;
    readonly parent?: { readonly id?: string; readonly type?: string };
  };
  readonly authors?: ReadonlyArray<{ readonly id?: string; readonly type?: string }>;
}

export function notionEventType(ev: NotionWebhookEvent): string | undefined {
  return ev.type ?? ev.event_type;
}

export function commentIdFromEvent(ev: NotionWebhookEvent): string | undefined {
  const e = ev.entity;
  if (e && e.type === "comment" && typeof e.id === "string" && e.id.length > 0) return e.id;
  return undefined;
}

export function pageIdFromEvent(ev: NotionWebhookEvent): string | undefined {
  return ev.data?.page_id ?? ev.data?.parent?.id;
}

export interface NotionRichText {
  readonly type?: string;
  readonly plain_text?: string;
  readonly text?: { readonly content?: string };
  readonly mention?: { readonly type?: string; readonly user?: { readonly id?: string } };
}

export function richTextToPlainText(richText: ReadonlyArray<NotionRichText> | undefined): string {
  if (!Array.isArray(richText)) return "";
  return richText.map((r) => (typeof r.plain_text === "string" ? r.plain_text : "")).join("").trim();
}

export function mentionsUser(richText: ReadonlyArray<NotionRichText> | undefined, userId: string | undefined): boolean {
  if (!userId || !Array.isArray(richText)) return false;
  return richText.some((r) => r.type === "mention" && r.mention?.type === "user" && r.mention.user?.id === userId);
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface NotionCallOpts {
  readonly apiKey: string;
  readonly fetch?: FetchLike;
  readonly version?: string;
  readonly endpoints?: CredentialEndpointRules;
  readonly retry?: Pick<RateLimitRetryOptions, "maxAttempts" | "capMs" | "fallbackMs" | "totalBudgetMs" | "sleep" | "now">;
}

export const NOTION_INGRESS_RETRY = {
  maxAttempts: 2,
  capMs: 2_000,
  totalBudgetMs: 4_000,
} as const satisfies NonNullable<NotionCallOpts["retry"]>;

function notionHeaders(opts: NotionCallOpts): Record<string, string> {
  return {
    authorization: `Bearer ${opts.apiKey}`,
    "notion-version": opts.version ?? NOTION_API_VERSION,
    "content-type": "application/json",
  };
}

export function notionOperation(method: string | undefined, url: string): string {
  const verb = (method ?? "GET").toUpperCase();
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return verb;
  }
  const shape = path
    .split("/")
    .map((seg) => (/^[0-9a-f]{32}$/i.test(seg.replaceAll("-", "")) ? "{id}" : seg))
    .join("/");
  return `${verb} ${shape}`;
}

export async function friendlyNotionInit(url: string, init: RequestInit): Promise<RequestInit> {
  if (typeof init.body !== "string" || !/\/v1\/comments(?:\/|$|\?)/.test(url) || (init.method !== "POST" && init.method !== "PATCH")) return init;
  try {
    const parsed = JSON.parse(init.body) as { rich_text?: unknown };
    if (!Array.isArray(parsed.rich_text)) return init;
    for (const item of parsed.rich_text as Array<{ text?: { content?: unknown } }>) {
      if (item?.text && typeof item.text.content === "string") item.text.content = await friendlyOutboundText(item.text.content, "notion");
    }
    return { ...init, body: JSON.stringify(parsed) };
  } catch {
    return init;
  }
}

async function notionFetch(url: string, init: RequestInit, opts: NotionCallOpts): Promise<Response> {
  const base = opts.fetch ?? (globalThis.fetch as FetchLike);
  const send = guardCredentialFetch(opts.endpoints, "notion credential", base);
  init = await friendlyNotionInit(url, init);
  return withRetryAfter(() => send(url, init), {
    ...opts.retry,
    surface: "notion",
    operation: notionOperation(init.method, url),
  });
}

export interface NotionComment {
  readonly id?: string;
  readonly discussion_id?: string;
  readonly parent?: { readonly type?: string; readonly page_id?: string; readonly block_id?: string };
  readonly rich_text?: ReadonlyArray<NotionRichText>;
  readonly created_by?: { readonly id?: string; readonly object?: string; readonly type?: string };
  readonly created_time?: string;
}

export async function retrieveComment(commentId: string, opts: NotionCallOpts): Promise<NotionComment> {
  const res = await notionFetch(`${NOTION_API_BASE}/v1/comments/${encodeURIComponent(commentId)}`, {
    method: "GET",
    headers: notionHeaders(opts),
  }, opts);
  if (!res.ok) throw new Error(`retrieveComment ${commentId} failed: ${res.status} ${await safeText(res)}`);
  return (await res.json()) as NotionComment;
}

export async function retrieveBotUser(opts: NotionCallOpts): Promise<{ id?: string; type?: string; name?: string }> {
  const res = await notionFetch(`${NOTION_API_BASE}/v1/users/me`, { method: "GET", headers: notionHeaders(opts) }, opts);
  if (!res.ok) throw new Error(`retrieveBotUser failed: ${res.status} ${await safeText(res)}`);
  return (await res.json()) as { id?: string; type?: string; name?: string };
}

export async function listBlockComments(
  blockId: string,
  opts: NotionCallOpts & { readonly maxPages?: number; readonly onPageLimit?: () => void },
): Promise<NotionComment[]> {
  const maxPages = Math.max(1, Math.trunc(opts.maxPages ?? 1));
  const out: NotionComment[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const qs = new URLSearchParams({ block_id: blockId, page_size: "100" });
    if (cursor) qs.set("start_cursor", cursor);
    const res = await notionFetch(`${NOTION_API_BASE}/v1/comments?${qs.toString()}`, {
      method: "GET",
      headers: notionHeaders(opts),
    }, opts);
    if (!res.ok) throw new Error(`listBlockComments ${blockId} failed: ${res.status} ${await safeText(res)}`);
    const body = (await res.json()) as { results?: NotionComment[]; has_more?: boolean; next_cursor?: string | null };
    if (Array.isArray(body.results)) out.push(...body.results);
    cursor = body.has_more && body.next_cursor ? body.next_cursor : undefined;
    if (!cursor) break;
    if (page === maxPages - 1) opts.onPageLimit?.();
  }
  return out;
}

export interface NotionBlockParent {
  readonly id?: string;
  readonly parent?: { readonly type?: string; readonly page_id?: string; readonly block_id?: string };
}

async function retrieveBlock(blockId: string, opts: NotionCallOpts): Promise<NotionBlockParent> {
  const res = await notionFetch(`${NOTION_API_BASE}/v1/blocks/${encodeURIComponent(blockId)}`, { method: "GET", headers: notionHeaders(opts) }, opts);
  if (!res.ok) throw new Error(`retrieveBlock ${blockId} failed: ${res.status} ${await safeText(res)}`);
  return (await res.json()) as NotionBlockParent;
}

const BLOCK_PARENT_MAX_HOPS = 5;
export async function resolveBlockOwningPage(blockId: string, opts: NotionCallOpts): Promise<string | undefined> {
  let id = blockId;
  for (let hop = 0; hop < BLOCK_PARENT_MAX_HOPS; hop++) {
    let block: NotionBlockParent;
    try {
      block = await retrieveBlock(id, opts);
    } catch {
      return undefined;
    }
    const parent = block.parent;
    if (parent?.type === "page_id" && parent.page_id) return parent.page_id;
    if (parent?.type === "block_id" && parent.block_id && parent.block_id !== id) {
      id = parent.block_id;
      continue;
    }
    return undefined;
  }
  return undefined;
}

export interface NotionPageParent {
  readonly parent?: {
    readonly type?: string;
    readonly page_id?: string;
    readonly block_id?: string;
    readonly database_id?: string;
    readonly data_source_id?: string;
    readonly workspace?: boolean;
  };
}

async function retrievePage(pageId: string, opts: NotionCallOpts): Promise<NotionPageParent> {
  const res = await notionFetch(`${NOTION_API_BASE}/v1/pages/${encodeURIComponent(pageId)}`, { method: "GET", headers: notionHeaders(opts) }, opts);
  if (!res.ok) throw new Error(`retrievePage ${pageId} failed: ${res.status} ${await safeText(res)}`);
  return (await res.json()) as NotionPageParent;
}

export async function readNotionPageIdentity(pageId: string, opts: NotionCallOpts): Promise<{ readonly title?: string; readonly url?: string }> {
  try {
    const res = await notionFetch(`${NOTION_API_BASE}/v1/pages/${encodeURIComponent(pageId)}`, { method: "GET", headers: notionHeaders(opts) }, opts);
    if (!res.ok) return {};
    const page = (await res.json()) as { url?: unknown; title?: unknown; properties?: unknown };
    const title = notionItemTitle(page);
    return {
      ...(title.length > 0 ? { title } : {}),
      ...(typeof page.url === "string" && page.url.length > 0 ? { url: page.url } : {}),
    };
  } catch {
    return {};
  }
}

export function toNotionParentLink(parent: NotionPageParent["parent"]): NotionParentLink {
  if (!parent) return { kind: "unresolvable" };
  if (parent.type === "page_id" && parent.page_id) return { kind: "page", pageId: parent.page_id };
  if (parent.type === "block_id" && parent.block_id) return { kind: "block", blockId: parent.block_id };
  if (parent.type === "database_id" && parent.database_id) return { kind: "database", databaseId: parent.database_id };
  if (parent.type === "data_source_id" && parent.data_source_id) return { kind: "database", databaseId: parent.data_source_id };
  if (parent.type === "workspace") return { kind: "workspace" };
  return { kind: "unresolvable" };
}

export async function notionParentLink(id: string, opts: NotionCallOpts): Promise<NotionParentLink> {
  try {
    return toNotionParentLink((await retrievePage(id, opts)).parent);
  } catch {
  }
  try {
    return toNotionParentLink((await retrieveBlock(id, opts)).parent);
  } catch {
    return { kind: "unresolvable" };
  }
}

export interface NotionCommentSummary {
  readonly id?: string;
  readonly discussionId?: string;
  readonly anchorId?: string;
  readonly anchorText?: string;
  readonly authorId?: string;
  readonly authorKind?: string;
  readonly createdTime?: string;
  readonly text: string;
}

export function toNotionCommentSummary(c: NotionComment, fallbackAnchor: string, anchorText?: string): NotionCommentSummary {
  return {
    ...(c.id === undefined ? {} : { id: c.id }),
    discussionId: c.discussion_id,
    anchorId: c.parent?.block_id ?? c.parent?.page_id ?? fallbackAnchor,
    ...(anchorText !== undefined && anchorText.length > 0 ? { anchorText } : {}),
    authorId: c.created_by?.id,
    authorKind: c.created_by?.type,
    createdTime: c.created_time,
    text: richTextToPlainText(c.rich_text),
  };
}

export async function readNotionComments(
  pageId: string,
  opts: NotionCallOpts & {
    readonly block?: string;
    readonly maxComments?: number;
    readonly maxBlockScans?: number;
    readonly sinceMs?: number;
    readonly maxCommentPages?: number;
    readonly blockScanOrder?: "document" | "newest-first";
    readonly maxChildPages?: number;
  },
): Promise<{ readonly comments: NotionCommentSummary[]; readonly discussionCount: number; readonly blocksScanned: number; readonly truncated: boolean }> {
  const maxComments = opts.maxComments ?? 100;
  const maxBlockScans = opts.maxBlockScans ?? 80;
  const comments: NotionCommentSummary[] = [];
  const discussions = new Set<string>();
  let truncated = false;
  let blocksScanned = 0;
  const listOpts = {
    ...opts,
    ...(opts.maxCommentPages === undefined ? {} : { maxPages: opts.maxCommentPages }),
    onPageLimit: () => {
      truncated = true;
    },
  };

  const inWindow = (c: NotionComment): boolean => {
    if (opts.sinceMs === undefined) return true;
    const ms = Date.parse(c.created_time ?? "");
    return Number.isFinite(ms) && ms >= opts.sinceMs;
  };

  const take = (raw: NotionComment[], anchor: string, anchorText?: string): boolean => {
    for (const c of raw) {
      if (!inWindow(c)) continue;
      if (comments.length >= maxComments) {
        truncated = true;
        return true;
      }
      comments.push(toNotionCommentSummary(c, anchor, anchorText));
      if (typeof c.discussion_id === "string" && c.discussion_id.length > 0) discussions.add(c.discussion_id);
    }
    return false;
  };

  if (opts.block) {
    take(await listBlockComments(opts.block, listOpts), opts.block);
    return { comments, discussionCount: discussions.size, blocksScanned: 1, truncated };
  }

  if (take(await listBlockComments(pageId, listOpts), pageId)) {
    return { comments, discussionCount: discussions.size, blocksScanned, truncated };
  }

  if (opts.blockScanOrder === "newest-first") {
    const maxChildPages = opts.maxChildPages ?? 10;
    const children: NotionBlock[] = [];
    let childCursor: string | undefined;
    let pagesRead = 0;
    do {
      const { blocks, nextCursor } = await getBlockChildren(pageId, { ...opts, startCursor: childCursor });
      children.push(...blocks);
      pagesRead += 1;
      childCursor = nextCursor && pagesRead < maxChildPages ? nextCursor : undefined;
      if (nextCursor && childCursor === undefined) truncated = true;
    } while (childCursor);
    if (children.length > maxBlockScans) truncated = true;
    const tail = children.slice(Math.max(0, children.length - maxBlockScans));
    for (let i = tail.length - 1; i >= 0; i--) {
      const b = tail[i]!;
      blocksScanned += 1;
      const id = typeof b.id === "string" ? b.id : undefined;
      if (!id) continue;
      if (take(await listBlockComments(id, listOpts), id, blockPlainText(b))) break;
    }
    return { comments, discussionCount: discussions.size, blocksScanned, truncated };
  }

  let cursor: string | undefined;
  outer: do {
    const { blocks, nextCursor } = await getBlockChildren(pageId, { ...opts, startCursor: cursor });
    for (const b of blocks) {
      if (blocksScanned >= maxBlockScans) {
        truncated = true;
        break outer;
      }
      blocksScanned += 1;
      const id = typeof b.id === "string" ? b.id : undefined;
      if (!id) continue;
      if (take(await listBlockComments(id, listOpts), id, blockPlainText(b))) break outer;
    }
    if (nextCursor && blocksScanned < maxBlockScans) {
      cursor = nextCursor;
    } else {
      if (nextCursor) truncated = true;
      cursor = undefined;
    }
  } while (cursor);

  return { comments, discussionCount: discussions.size, blocksScanned, truncated };
}

export interface NotionBlock {
  readonly id?: string;
  readonly type?: string;
  readonly has_children?: boolean;
  readonly [key: string]: unknown;
}

export function blockPlainText(block: NotionBlock): string {
  const t = typeof block.type === "string" ? block.type : undefined;
  if (!t) return "";
  const inner = block[t];
  if (!inner || typeof inner !== "object") return "";
  const rich = (inner as { rich_text?: unknown }).rich_text;
  return richTextToPlainText(Array.isArray(rich) ? (rich as NotionRichText[]) : undefined);
}

export async function getBlockChildren(
  blockId: string,
  opts: NotionCallOpts & { readonly startCursor?: string; readonly pageSize?: number },
): Promise<{ readonly blocks: NotionBlock[]; readonly nextCursor?: string }> {
  const qs = new URLSearchParams({ page_size: String(opts.pageSize ?? 100) });
  if (opts.startCursor) qs.set("start_cursor", opts.startCursor);
  const res = await notionFetch(`${NOTION_API_BASE}/v1/blocks/${encodeURIComponent(blockId)}/children?${qs.toString()}`, {
    method: "GET",
    headers: notionHeaders(opts),
  }, opts);
  if (!res.ok) throw new Error(`getBlockChildren ${blockId} failed: ${res.status} ${await safeText(res)}`);
  const body = (await res.json()) as { results?: NotionBlock[]; has_more?: boolean; next_cursor?: string | null };
  return {
    blocks: Array.isArray(body.results) ? body.results : [],
    nextCursor: body.has_more && body.next_cursor ? body.next_cursor : undefined,
  };
}

export async function readNotionPage(
  pageId: string,
  opts: NotionCallOpts & { readonly maxBlocks?: number; readonly maxChars?: number },
): Promise<{ readonly text: string; readonly blockCount: number; readonly truncated: boolean }> {
  const maxBlocks = opts.maxBlocks ?? 200;
  const maxChars = opts.maxChars ?? 20_000;
  const lines: string[] = [];
  let chars = 0;
  let blockCount = 0;
  let truncated = false;
  let cursor: string | undefined;
  do {
    const { blocks, nextCursor } = await getBlockChildren(pageId, { ...opts, startCursor: cursor });
    let stop = false;
    for (const b of blocks) {
      if (blockCount >= maxBlocks) {
        truncated = true;
        stop = true;
        break;
      }
      blockCount += 1;
      const text = blockPlainText(b);
      if (!text) continue;
      if (chars + text.length > maxChars && lines.length > 0) {
        truncated = true;
        stop = true;
        break;
      }
      chars += text.length;
      lines.push(text);
    }
    if (stop) {
      cursor = undefined;
    } else if (nextCursor) {
      cursor = nextCursor;
    } else {
      cursor = undefined;
    }
  } while (cursor);
  return { text: lines.join("\n"), blockCount, truncated };
}

export const NOTION_MAX_ATTACHMENTS = 3;

function attachmentsBody(fileUploadIds: readonly string[] | undefined): { attachments: Array<{ file_upload_id: string; type: "file_upload" }> } | Record<string, never> {
  if (!fileUploadIds || fileUploadIds.length === 0) return {};
  if (fileUploadIds.length > NOTION_MAX_ATTACHMENTS) {
    throw new Error(`Notion comments accept at most ${NOTION_MAX_ATTACHMENTS} attachments; got ${fileUploadIds.length}.`);
  }
  return { attachments: fileUploadIds.map((id) => ({ file_upload_id: id, type: "file_upload" as const })) };
}

export async function createCommentReply(
  args: { discussionId: string; text: string; attachments?: readonly string[] } & NotionCallOpts,
): Promise<string> {
  const attach = attachmentsBody(args.attachments);
  const res = await notionFetch(`${NOTION_API_BASE}/v1/comments`, {
    method: "POST",
    headers: notionHeaders(Object.keys(attach).length > 0 ? { ...args, version: NOTION_FILE_UPLOAD_VERSION } : args),
    body: JSON.stringify({ discussion_id: args.discussionId, rich_text: richTextChunks(args.text), ...attach }),
  }, args);
  if (!res.ok) {
    throw Object.assign(new Error(`createCommentReply failed: ${res.status} ${await safeText(res)}`), { status: res.status });
  }
  const body = (await res.json().catch(() => ({}))) as { id?: unknown };
  return typeof body.id === "string" ? body.id : "";
}

export async function createPageComment(
  args: { pageId: string; text: string; attachments?: readonly string[] } & NotionCallOpts,
): Promise<string> {
  const attach = attachmentsBody(args.attachments);
  const res = await notionFetch(`${NOTION_API_BASE}/v1/comments`, {
    method: "POST",
    headers: notionHeaders(Object.keys(attach).length > 0 ? { ...args, version: NOTION_FILE_UPLOAD_VERSION } : args),
    body: JSON.stringify({ parent: { page_id: args.pageId }, rich_text: richTextChunks(args.text), ...attach }),
  }, args);
  if (!res.ok) {
    throw Object.assign(new Error(`createPageComment failed: ${res.status} ${await safeText(res)}`), { status: res.status });
  }
  const body = (await res.json().catch(() => ({}))) as { id?: unknown };
  return typeof body.id === "string" ? body.id : "";
}

export async function updateComment(
  args: { commentId: string; text: string } & NotionCallOpts,
): Promise<void> {
  const res = await notionFetch(`${NOTION_API_BASE}/v1/comments/${encodeURIComponent(args.commentId)}`, {
    method: "PATCH",
    headers: notionHeaders(args),
    body: JSON.stringify({ rich_text: richTextChunks(args.text) }),
  }, args);
  if (!res.ok) {
    throw Object.assign(new Error(`updateComment ${args.commentId} failed: ${res.status} ${await safeText(res)}`), { status: res.status });
  }
}

interface NotionFileUploadObject {
  readonly id?: string;
  readonly upload_url?: string;
  readonly status?: string;
}

export async function createFileUpload(
  args: { readonly filename: string; readonly contentType: string } & NotionCallOpts,
): Promise<{ readonly id: string; readonly uploadUrl: string }> {
  const res = await notionFetch(`${NOTION_API_BASE}/v1/file_uploads`, {
    method: "POST",
    headers: notionHeaders({ ...args, version: NOTION_FILE_UPLOAD_VERSION }),
    body: JSON.stringify({ filename: args.filename, content_type: args.contentType }),
  }, args);
  if (!res.ok) throw new Error(`createFileUpload failed: ${res.status} ${await safeText(res)}`);
  const body = (await res.json().catch(() => ({}))) as NotionFileUploadObject;
  if (typeof body.id !== "string" || body.id.length === 0 || typeof body.upload_url !== "string" || body.upload_url.length === 0) {
    throw new Error("createFileUpload: Notion response carried no usable id/upload_url.");
  }
  return { id: body.id, uploadUrl: body.upload_url };
}

export async function sendFileUploadBytes(
  args: { readonly uploadUrl: string; readonly filename: string; readonly contentType: string; readonly bytes: Uint8Array } & NotionCallOpts,
): Promise<void> {
  const form = new FormData();
  const ab = args.bytes.buffer.slice(args.bytes.byteOffset, args.bytes.byteOffset + args.bytes.byteLength) as ArrayBuffer;
  form.append("file", new Blob([ab], { type: args.contentType }), args.filename);
  const res = await notionFetch(args.uploadUrl, {
    method: "POST",
    headers: { authorization: `Bearer ${args.apiKey}`, "notion-version": NOTION_FILE_UPLOAD_VERSION },
    body: form,
  }, args);
  if (!res.ok) throw new Error(`sendFileUploadBytes failed: ${res.status} ${await safeText(res)}`);
}

export async function uploadNotionFile(
  args: { readonly filename: string; readonly contentType: string; readonly bytes: Uint8Array } & NotionCallOpts,
): Promise<string> {
  const { id, uploadUrl } = await createFileUpload(args);
  await sendFileUploadBytes({ ...args, uploadUrl });
  return id;
}

export function richTextChunks(text: string): Array<{ type: "text"; text: { content: string } }> {
  const MAX_ITEM = 2000;
  const MAX_ITEMS = 100;
  const body = text.length > 0 ? text : "(no content)";
  const chunks: Array<{ type: "text"; text: { content: string } }> = [];
  for (let i = 0; i < body.length && chunks.length < MAX_ITEMS; i += MAX_ITEM) {
    chunks.push({ type: "text", text: { content: body.slice(i, i + MAX_ITEM) } });
  }
  return chunks;
}

export interface NotionSearchHit {
  readonly id: string;
  readonly object: string;
  readonly title: string;
  readonly url?: string;
}

export async function searchNotion(
  query: string,
  opts: NotionCallOpts & { readonly pageSize?: number; readonly filter?: "page" | "database" },
): Promise<readonly NotionSearchHit[]> {
  const body: Record<string, unknown> = { page_size: Math.min(Math.max(opts.pageSize ?? 10, 1), 100) };
  if (query.length > 0) body.query = query;
  if (opts.filter) body.filter = { property: "object", value: opts.filter };
  const res = await notionFetch(`${NOTION_API_BASE}/v1/search`, {
    method: "POST",
    headers: notionHeaders(opts),
    body: JSON.stringify(body),
  }, opts);
  if (!res.ok) throw new Error(`notion search failed: ${res.status} ${await safeText(res)}`);
  const parsed = (await res.json()) as { results?: unknown };
  const results = Array.isArray(parsed.results) ? parsed.results : [];
  const hits: NotionSearchHit[] = [];
  for (const raw of results) {
    const item = raw as { id?: unknown; object?: unknown; url?: unknown; title?: unknown; properties?: unknown };
    if (typeof item.id !== "string" || item.id.length === 0) continue;
    hits.push({
      id: item.id,
      object: typeof item.object === "string" ? item.object : "unknown",
      title: notionItemTitle(item),
      ...(typeof item.url === "string" ? { url: item.url } : {}),
    });
  }
  return hits;
}

function notionItemTitle(item: { readonly title?: unknown; readonly properties?: unknown }): string {
  if (Array.isArray(item.title)) return richTextToPlainText(item.title as NotionRichText[]);
  const props = item.properties as Record<string, { type?: unknown; title?: unknown }> | undefined;
  for (const value of Object.values(props ?? {})) {
    if (value?.type === "title" && Array.isArray(value.title)) return richTextToPlainText(value.title as NotionRichText[]);
  }
  return "";
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 300);
  } catch {
    return "";
  }
}
