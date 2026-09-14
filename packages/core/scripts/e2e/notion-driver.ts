import { createHmac, randomUUID } from "node:crypto";
import type { NotionAmbientConfig } from "./env.js";
import { type NotionPagePin, notionBlockPhrases } from "./egress-evidence.js";
import { pollUntil, sleep } from "./poll.js";

const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";
const NOTION_COMMENT_VERSION = "2026-03-11";

const RATE_LIMITED_STATUS = 429;

export const NOTION_RATE_LIMIT_CODE = "public_api_request_rate_limit";

export const NOTION_MAX_ATTEMPTS = 4;

export const NOTION_RETRY_CAP_MS = 10_000;

const NOTION_RETRY_BUDGET_MS = 20_000;

const NOTION_FALLBACK_WAIT_MS = 1_000;

export interface NotionFetchResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  text(): Promise<string>;
  json(): Promise<unknown>;
}

export type NotionFetchFn = (url: string, init?: RequestInit) => Promise<NotionFetchResponse>;

export interface NotionDriverDeps {
  readonly fetchFn?: NotionFetchFn;
  readonly sleepFn?: (ms: number) => Promise<void>;
}

export class NotionRateLimitedError extends Error {
  readonly status = RATE_LIMITED_STATUS;
  readonly attempts: number;
  readonly waitedMs: number;

  constructor(what: string, attempts: number, waitedMs: number) {
    super(
      `notion ${what} stayed rate limited (HTTP ${RATE_LIMITED_STATUS} "${NOTION_RATE_LIMIT_CODE}") after ${attempts} attempts ` +
        `and ${waitedMs} ms of honoured Retry-After waits. THIS IS A HARNESS LIMIT, NOT A PRODUCT RED: the e2e driver's own ` +
        `Notion token is over the public API's per-token request budget, which one workspace shared by every Notion leg ` +
        `exhausts. Re-run the leg alone, or space the Notion legs out.`,
    );
    this.name = "NotionRateLimitedError";
    this.attempts = attempts;
    this.waitedMs = waitedMs;
  }
}

export function parseNotionRetryAfterMs(value: string | null | undefined, nowMs: number): number | undefined {
  if (value === null || value === undefined) return undefined;
  const raw = value.trim();
  if (raw.length === 0) return undefined;
  if (/^\d+(\.\d+)?$/.test(raw)) return Math.round(Number(raw) * 1_000);
  const at = Date.parse(raw);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, at - nowMs);
}

export async function notionFetch(
  url: string,
  init: RequestInit,
  opts: { readonly what: string; readonly fetchFn?: NotionFetchFn; readonly sleepFn?: (ms: number) => Promise<void> },
): Promise<NotionFetchResponse> {
  const fetchFn = opts.fetchFn ?? (globalThis.fetch as unknown as NotionFetchFn);
  const sleepFn = opts.sleepFn ?? sleep;
  let waitedMs = 0;
  for (let attempt = 1; ; attempt++) {
    const res = await fetchFn(url, init);
    if (res.status !== RATE_LIMITED_STATUS) return res;
    if (attempt >= NOTION_MAX_ATTEMPTS) throw new NotionRateLimitedError(opts.what, attempt, waitedMs);
    const remaining = NOTION_RETRY_BUDGET_MS - waitedMs;
    if (remaining <= 0) throw new NotionRateLimitedError(opts.what, attempt, waitedMs);
    const named = parseNotionRetryAfterMs(res.headers.get("retry-after"), Date.now()) ?? NOTION_FALLBACK_WAIT_MS;
    const wait = Math.max(0, Math.min(named, NOTION_RETRY_CAP_MS, remaining));
    await sleepFn(wait);
    waitedMs += wait;
  }
}

export interface NotionComment {
  readonly id: string;
  readonly discussionId: string;
  readonly authorId: string;
  readonly text: string;
  readonly createdTime: string;
}

export interface NotionReplyFilter {
  readonly seen?: ReadonlySet<string>;
  readonly skip?: (c: NotionComment) => boolean;
}

export interface NotionReplyWaitOpts extends NotionReplyFilter {
  readonly timeoutMs: number;
}

export interface NotionReplyMiss {
  readonly visible: number;
  readonly inDiscussion: number;
  readonly watermark: string;
  readonly notBot: number;
  readonly beforeWatermark: number;
  readonly notThisDiscussion: number;
  readonly otherDiscussions: readonly string[];
}

export function notionMinuteFloor(sinceIso: string): string {
  const t = Date.parse(sinceIso);
  if (Number.isNaN(t)) return sinceIso;
  return new Date(Math.floor(t / 60_000) * 60_000).toISOString();
}

const MINUTE_BOUNDARY_MARGIN_MS = 2_000;

export function msToNextMinuteBoundary(nowMs: number): number {
  return 60_000 - (((nowMs % 60_000) + 60_000) % 60_000) + MINUTE_BOUNDARY_MARGIN_MS;
}

function waitQualifier(opts: NotionReplyFilter): string {
  const clauses: string[] = [];
  if (opts.seen !== undefined) clauses.push(`outside the ${opts.seen.size} comment(s) already seen`);
  if (opts.skip !== undefined) clauses.push("that is not skipped as an interim post");
  return clauses.length === 0 ? "" : `, ${clauses.join(" and ")}`;
}

export function signNotionBody(secret: string, rawBody: string): string {
  return "sha256=" + createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
}

export interface CommentCreatedForgeInput {
  readonly workspaceId: string;
  readonly commentId: string;
  readonly pageId: string;
  readonly deliveryId?: string;
  readonly timestamp?: string;
}

export function buildCommentCreatedEvent(input: CommentCreatedForgeInput): Record<string, unknown> {
  return {
    type: "comment.created",
    workspace_id: input.workspaceId,
    entity: { id: input.commentId, type: "comment" },
    data: { page_id: input.pageId },
    ...(input.deliveryId !== undefined ? { id: input.deliveryId } : {}),
    ...(input.timestamp !== undefined ? { timestamp: input.timestamp } : {}),
  };
}

export function buildBlockCommentBody(blockId: string, text: string): Record<string, unknown> {
  return { parent: { block_id: blockId }, rich_text: [{ text: { content: text } }] };
}

export function buildDiscussionReplyBody(discussionId: string, text: string): Record<string, unknown> {
  return { discussion_id: discussionId, rich_text: [{ text: { content: text } }] };
}

const PIN_READ_TIMEOUT_MS = 20_000;

export type NotionPinFailure = "no-driver-key" | "search-failed" | "search-empty" | "read-failed" | "no-prose";

export type NotionPagePinResult =
  | { readonly ok: true; readonly pin: NotionPagePin; readonly hits: number }
  | { readonly ok: false; readonly failure: NotionPinFailure; readonly reason: string; readonly hits: number };

function pageTitle(page: Record<string, unknown>): string {
  const props = page.properties;
  if (typeof props !== "object" || props === null) return "(untitled page)";
  for (const value of Object.values(props as Record<string, unknown>)) {
    if (typeof value !== "object" || value === null) continue;
    const prop = value as Record<string, unknown>;
    if (prop.type !== "title" || !Array.isArray(prop.title)) continue;
    const text = prop.title
      .map((span) => (typeof span === "object" && span !== null && typeof (span as Record<string, unknown>).plain_text === "string" ? ((span as Record<string, unknown>).plain_text as string) : ""))
      .join("")
      .trim();
    if (text.length > 0) return text;
  }
  return "(untitled page)";
}

export async function pinNotionQueryPage(opts: { readonly driverKey: string; readonly query: string } & NotionDriverDeps): Promise<NotionPagePinResult> {
  const headers = { authorization: `Bearer ${opts.driverKey}`, "notion-version": NOTION_VERSION, "content-type": "application/json" };
  const retry = { fetchFn: opts.fetchFn, sleepFn: opts.sleepFn };
  let found: Record<string, unknown> | undefined;
  let hits = 0;
  try {
    const res = await notionFetch(
      `${NOTION_API}/search`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ query: opts.query, filter: { value: "page", property: "object" }, page_size: 5 }),
        signal: AbortSignal.timeout(PIN_READ_TIMEOUT_MS),
      },
      { what: `POST /v1/search for "${opts.query}"`, ...retry },
    );
    if (!res.ok) return { ok: false, failure: "search-failed", hits, reason: `the harness's own POST /v1/search for "${opts.query}" → ${res.status}` };
    const json = (await res.json()) as { results?: unknown };
    const results = Array.isArray(json.results) ? (json.results as Record<string, unknown>[]) : [];
    hits = results.length;
    found = results.find((r) => r.object === "page" && typeof r.id === "string" && r.archived !== true);
    if (!found)
      return { ok: false, failure: "search-empty", hits, reason: `the harness's own search for "${opts.query}" matched no page this token can see (${hits} result(s))` };
  } catch (err) {
    return { ok: false, failure: "search-failed", hits, reason: `the harness's own Notion search failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  const pageId = found.id as string;
  const title = pageTitle(found);
  try {
    const res = await notionFetch(
      `${NOTION_API}/blocks/${encodeURIComponent(pageId)}/children?page_size=100`,
      {
        headers: { authorization: headers.authorization, "notion-version": NOTION_VERSION },
        signal: AbortSignal.timeout(PIN_READ_TIMEOUT_MS),
      },
      { what: `GET /v1/blocks/${pageId}/children`, ...retry },
    );
    if (!res.ok) return { ok: false, failure: "read-failed", hits, reason: `the harness's own GET /v1/blocks/${pageId}/children → ${res.status}` };
    const json = (await res.json()) as { results?: unknown };
    const phrases = notionBlockPhrases(Array.isArray(json.results) ? json.results : []);
    if (phrases.length === 0)
      return { ok: false, failure: "no-prose", hits, reason: `the pinned page "${title}" (${pageId}) holds no quotable prose, so no phrase can be demanded of the answer` };
    return { ok: true, hits, pin: { pageId, title, phrases } };
  } catch (err) {
    return { ok: false, failure: "read-failed", hits, reason: `the harness's own Notion page read failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export class NotionDriver {
  private readonly retry: { readonly fetchFn?: NotionFetchFn; readonly sleepFn?: (ms: number) => Promise<void> };

  constructor(
    private readonly cfg: NotionAmbientConfig,
    deps: NotionDriverDeps = {},
  ) {
    this.retry = { fetchFn: deps.fetchFn, sleepFn: deps.sleepFn };
  }

  get botUserId(): string {
    return this.cfg.botUserId;
  }
  get pageId(): string {
    return this.cfg.pageId;
  }
  get webhookSecret(): string | undefined {
    return this.cfg.webhookSecret;
  }
  get anchorOnTopic(): string | undefined {
    return this.cfg.anchorOnTopic;
  }
  get anchorOnTopic2(): string | undefined {
    return this.cfg.anchorOnTopic2;
  }
  get anchorOffTopic(): string | undefined {
    return this.cfg.anchorOffTopic;
  }
  get anchorHuman(): string | undefined {
    return this.cfg.anchorHuman;
  }

  private async api(path: string): Promise<Record<string, unknown>> {
    const res = await notionFetch(
      `${NOTION_API}${path}`,
      { headers: { authorization: `Bearer ${this.cfg.driverKey}`, "notion-version": NOTION_VERSION } },
      { what: `GET ${path}`, ...this.retry },
    );
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 200);
      throw new Error(`notion GET ${path} → ${res.status}${detail ? ` (${detail})` : ""}`);
    }
    return (await res.json()) as Record<string, unknown>;
  }

  private async apiAllPages(path: string): Promise<Record<string, unknown>[]> {
    const sep = path.includes("?") ? "&" : "?";
    const all: Record<string, unknown>[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const json = await this.api(`${path}${sep}page_size=100${cursor ? `&start_cursor=${encodeURIComponent(cursor)}` : ""}`);
      if (Array.isArray(json.results)) all.push(...(json.results as Record<string, unknown>[]));
      if (json.has_more !== true || typeof json.next_cursor !== "string") break;
      cursor = json.next_cursor;
    }
    return all;
  }

  private static mapComments(json: Record<string, unknown>): readonly NotionComment[] {
    const results = Array.isArray(json.results) ? (json.results as Record<string, unknown>[]) : [];
    return results.map((c) => {
      const rich = Array.isArray(c.rich_text) ? (c.rich_text as { plain_text?: string }[]) : [];
      const by = (c.created_by ?? {}) as { id?: string };
      return {
        id: typeof c.id === "string" ? c.id : "",
        discussionId: typeof c.discussion_id === "string" ? c.discussion_id : "",
        authorId: by.id ?? "",
        text: rich.map((r) => r.plain_text ?? "").join(""),
        createdTime: typeof c.created_time === "string" ? c.created_time : "",
      };
    });
  }

  async pageComments(): Promise<readonly NotionComment[]> {
    return NotionDriver.mapComments({ results: await this.apiAllPages(`/comments?block_id=${encodeURIComponent(this.cfg.pageId)}`) });
  }

  async blockComments(blockId: string): Promise<readonly NotionComment[]> {
    return NotionDriver.mapComments({ results: await this.apiAllPages(`/comments?block_id=${encodeURIComponent(blockId)}`) });
  }

  private blockIdsCache: readonly string[] | undefined;

  private async blockIds(): Promise<readonly string[]> {
    this.blockIdsCache ??= await this.pageBlocks();
    return this.blockIdsCache;
  }

  async allComments(): Promise<readonly NotionComment[]> {
    const [page, perBlock] = await Promise.all([
      this.pageComments(),
      this.blockIds().then((ids) => Promise.all(ids.map((b) => this.blockComments(b).catch(() => [] as readonly NotionComment[])))),
    ]);
    return [...page, ...perBlock.flat()];
  }

  async discussionOf(commentId: string): Promise<string | undefined> {
    return (await this.allComments()).find((c) => c.id === commentId)?.discussionId;
  }

  isBotComment(c: NotionComment): boolean {
    return c.authorId === this.cfg.botUserId;
  }

  isFreshBotComment(c: NotionComment, discussionId: string, sinceTime: string, opts: NotionReplyFilter = {}): boolean {
    if (!this.isBotComment(c) || c.discussionId !== discussionId) return false;
    if (c.createdTime < notionMinuteFloor(sinceTime)) return false;
    if (opts.seen?.has(c.id) === true) return false;
    return !(opts.skip?.(c) ?? false);
  }

  async explainReplyMiss(discussionId: string, sinceTime: string, blockId?: string): Promise<NotionReplyMiss | undefined> {
    let comments: readonly NotionComment[];
    try {
      comments = blockId === undefined ? await this.allComments() : await this.blockComments(blockId);
    } catch {
      return undefined;
    }
    const floor = notionMinuteFloor(sinceTime);
    const inDiscussion = comments.filter((c) => c.discussionId === discussionId);
    const fresh = comments.filter((c) => c.createdTime >= floor);
    return {
      visible: comments.length,
      inDiscussion: inDiscussion.length,
      watermark: floor,
      notBot: fresh.filter((c) => c.discussionId === discussionId && !this.isBotComment(c)).length,
      beforeWatermark: inDiscussion.filter((c) => c.createdTime < floor).length,
      notThisDiscussion: fresh.filter((c) => this.isBotComment(c) && c.discussionId !== discussionId).length,
      otherDiscussions: [...new Set(fresh.filter((c) => this.isBotComment(c) && c.discussionId !== discussionId).map((c) => c.discussionId))].slice(0, 5),
    };
  }

  async appendParagraphBlock(text: string): Promise<string> {
    const res = await notionFetch(
      `${NOTION_API}/blocks/${encodeURIComponent(this.cfg.pageId)}/children`,
      {
        method: "PATCH",
        headers: { authorization: `Bearer ${this.cfg.driverKey}`, "notion-version": NOTION_VERSION, "content-type": "application/json" },
        body: JSON.stringify({ children: [{ object: "block", type: "paragraph", paragraph: { rich_text: [{ text: { content: text } }] } }] }),
      },
      { what: "PATCH /v1/blocks/:page/children", ...this.retry },
    );
    if (!res.ok) throw new Error(`notion PATCH /blocks/:page/children → ${res.status}`);
    const json = (await res.json()) as { results?: { id?: unknown }[] };
    const id = typeof json.results?.[0]?.id === "string" ? json.results[0].id : "";
    if (!id) throw new Error("notion block append returned no block id");
    this.blockIdsCache = undefined;
    return id;
  }

  async archiveBlock(blockId: string): Promise<void> {
    await notionFetch(
      `${NOTION_API}/blocks/${encodeURIComponent(blockId)}`,
      {
        method: "PATCH",
        headers: { authorization: `Bearer ${this.cfg.driverKey}`, "notion-version": NOTION_VERSION, "content-type": "application/json" },
        body: JSON.stringify({ archived: true }),
      },
      { what: `PATCH /v1/blocks/${blockId} (archive)`, ...this.retry },
    ).catch(() => undefined);
  }

  async pageBlocks(): Promise<readonly string[]> {
    const results = await this.apiAllPages(`/blocks/${encodeURIComponent(this.cfg.pageId)}/children`);
    return results.map((b) => (typeof b.id === "string" ? b.id : "")).filter((id) => id.length > 0);
  }

  async createBlockDiscussion(blockId: string, text: string): Promise<{ commentId: string; discussionId: string }> {
    const res = await notionFetch(
      `${NOTION_API}/comments`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.cfg.driverKey}`,
          "notion-version": NOTION_COMMENT_VERSION,
          "content-type": "application/json",
        },
        body: JSON.stringify(buildBlockCommentBody(blockId, text)),
      },
      { what: `POST /v1/comments (block ${blockId})`, ...this.retry },
    );
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 200);
      throw new Error(`notion POST /comments (block ${blockId}) → ${res.status}${detail ? ` (${detail})` : ""}`);
    }
    const json = (await res.json()) as Record<string, unknown>;
    return {
      commentId: typeof json.id === "string" ? json.id : "",
      discussionId: typeof json.discussion_id === "string" ? json.discussion_id : "",
    };
  }

  async replyToDiscussion(discussionId: string, text: string): Promise<{ commentId: string }> {
    const res = await notionFetch(
      `${NOTION_API}/comments`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.cfg.driverKey}`,
          "notion-version": NOTION_COMMENT_VERSION,
          "content-type": "application/json",
        },
        body: JSON.stringify(buildDiscussionReplyBody(discussionId, text)),
      },
      { what: `POST /v1/comments (discussion ${discussionId})`, ...this.retry },
    );
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 200);
      throw new Error(`notion POST /comments (discussion ${discussionId}) → ${res.status}${detail ? ` (${detail})` : ""}`);
    }
    const json = (await res.json()) as Record<string, unknown>;
    return { commentId: typeof json.id === "string" ? json.id : "" };
  }

  async awaitBotReplyOnBlock(
    blockId: string,
    discussionId: string,
    sinceTime: string,
    opts: NotionReplyWaitOpts,
  ): Promise<NotionComment> {
    return pollUntil(
      async () => (await this.blockComments(blockId)).find((c) => this.isFreshBotComment(c, discussionId, sinceTime, opts)),
      {
        timeoutMs: opts.timeoutMs,
        what: `a bot reply in discussion ${discussionId} on block ${blockId} in or after the minute of ${sinceTime}${waitQualifier(opts)}`,
      },
    );
  }

  async awaitBotReplyIn(discussionId: string, sinceTime: string, opts: NotionReplyWaitOpts): Promise<NotionComment> {
    return pollUntil(
      async () => (await this.allComments()).find((c) => this.isFreshBotComment(c, discussionId, sinceTime, opts)),
      {
        timeoutMs: opts.timeoutMs,
        what: `a bot reply in discussion ${discussionId} in or after the minute of ${sinceTime}${waitQualifier(opts)}`,
      },
    );
  }

  async forgeCommentCreated(targetUrl: string, commentId: string, opts: { signed?: boolean } = {}): Promise<{ status: number }> {
    const rawBody = JSON.stringify(
      buildCommentCreatedEvent({
        workspaceId: this.cfg.workspaceId,
        commentId,
        pageId: this.cfg.pageId,
        deliveryId: randomUUID(),
        timestamp: new Date().toISOString(),
      }),
    );
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (opts.signed !== false) {
      if (!this.cfg.webhookSecret) throw new Error("forgeCommentCreated(signed) requires E2E_NOTION_WEBHOOK_SECRET — the forge legs must gate on it");
      headers["x-notion-signature"] = signNotionBody(this.cfg.webhookSecret, rawBody);
    }
    const res = await fetch(`${targetUrl.replace(/\/+$/, "")}/eve/v1/notion`, { method: "POST", headers, body: rawBody });
    return { status: res.status };
  }
}
