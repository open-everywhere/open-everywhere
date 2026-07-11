import { createHmac, timingSafeEqual } from "node:crypto";

export const NOTION_API_BASE = "https://api.notion.com";
export function notionVersion(): string {
  const v = process.env.NOTION_VERSION;
  return v && v.trim().length > 0 ? v.trim() : "2022-06-28";
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
      : "NOTION_WEBHOOK_SECRET is not set — rejecting unverified delivery (set the verification token, or OE_ALLOW_UNVERIFIED_NOTION_WEBHOOK=1 for local dev)";
  }
  return verifyNotionSignature(secret, rawBody, signatureHeader) ? null : "invalid signature";
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

interface NotionCallOpts {
  readonly apiKey: string;
  readonly fetch?: FetchLike;
  readonly version?: string;
}

function notionHeaders(opts: NotionCallOpts): Record<string, string> {
  return {
    authorization: `Bearer ${opts.apiKey}`,
    "notion-version": opts.version ?? notionVersion(),
    "content-type": "application/json",
  };
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
  const f = opts.fetch ?? (globalThis.fetch as FetchLike);
  const res = await f(`${NOTION_API_BASE}/v1/comments/${encodeURIComponent(commentId)}`, {
    method: "GET",
    headers: notionHeaders(opts),
  });
  if (!res.ok) throw new Error(`retrieveComment ${commentId} failed: ${res.status} ${await safeText(res)}`);
  return (await res.json()) as NotionComment;
}

export async function retrieveBotUser(opts: NotionCallOpts): Promise<{ id?: string; type?: string; name?: string }> {
  const f = opts.fetch ?? (globalThis.fetch as FetchLike);
  const res = await f(`${NOTION_API_BASE}/v1/users/me`, { method: "GET", headers: notionHeaders(opts) });
  if (!res.ok) throw new Error(`retrieveBotUser failed: ${res.status} ${await safeText(res)}`);
  return (await res.json()) as { id?: string; type?: string; name?: string };
}

export async function listBlockComments(blockId: string, opts: NotionCallOpts): Promise<NotionComment[]> {
  const f = opts.fetch ?? (globalThis.fetch as FetchLike);
  const res = await f(`${NOTION_API_BASE}/v1/comments?block_id=${encodeURIComponent(blockId)}&page_size=100`, {
    method: "GET",
    headers: notionHeaders(opts),
  });
  if (!res.ok) throw new Error(`listBlockComments ${blockId} failed: ${res.status} ${await safeText(res)}`);
  const body = (await res.json()) as { results?: NotionComment[] };
  return Array.isArray(body.results) ? body.results : [];
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
  const f = opts.fetch ?? (globalThis.fetch as FetchLike);
  const qs = new URLSearchParams({ page_size: String(opts.pageSize ?? 100) });
  if (opts.startCursor) qs.set("start_cursor", opts.startCursor);
  const res = await f(`${NOTION_API_BASE}/v1/blocks/${encodeURIComponent(blockId)}/children?${qs.toString()}`, {
    method: "GET",
    headers: notionHeaders(opts),
  });
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

export async function createCommentReply(
  args: { discussionId: string; text: string } & NotionCallOpts,
): Promise<string> {
  const f = args.fetch ?? (globalThis.fetch as FetchLike);
  const res = await f(`${NOTION_API_BASE}/v1/comments`, {
    method: "POST",
    headers: notionHeaders(args),
    body: JSON.stringify({ discussion_id: args.discussionId, rich_text: richTextChunks(args.text) }),
  });
  if (!res.ok) throw new Error(`createCommentReply failed: ${res.status} ${await safeText(res)}`);
  const body = (await res.json().catch(() => ({}))) as { id?: unknown };
  return typeof body.id === "string" ? body.id : "";
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


async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 300);
  } catch {
    return "";
  }
}
