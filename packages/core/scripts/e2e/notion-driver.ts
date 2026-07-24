import { createHmac } from "node:crypto";
import type { NotionAmbientConfig } from "./env.js";
import { pollUntil } from "./poll.js";

const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";
const NOTION_COMMENT_VERSION = "2026-03-11";

export interface NotionComment {
  readonly id: string;
  readonly discussionId: string;
  readonly authorId: string;
  readonly text: string;
  readonly createdTime: string;
}

export function signNotionBody(secret: string, rawBody: string): string {
  return "sha256=" + createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
}

export interface CommentCreatedForgeInput {
  readonly workspaceId: string;
  readonly commentId: string;
  readonly pageId: string;
}

export function buildCommentCreatedEvent(input: CommentCreatedForgeInput): Record<string, unknown> {
  return {
    type: "comment.created",
    workspace_id: input.workspaceId,
    entity: { id: input.commentId, type: "comment" },
    data: { page_id: input.pageId },
  };
}

export function buildBlockCommentBody(blockId: string, text: string): Record<string, unknown> {
  return { parent: { block_id: blockId }, rich_text: [{ text: { content: text } }] };
}

export class NotionDriver {
  constructor(private readonly cfg: NotionAmbientConfig) {}

  get botUserId(): string {
    return this.cfg.botUserId;
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

  private async api(path: string): Promise<Record<string, unknown>> {
    const res = await fetch(`${NOTION_API}${path}`, {
      headers: { authorization: `Bearer ${this.cfg.driverKey}`, "notion-version": NOTION_VERSION },
    });
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

  async appendParagraphBlock(text: string): Promise<string> {
    const res = await fetch(`${NOTION_API}/blocks/${encodeURIComponent(this.cfg.pageId)}/children`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${this.cfg.driverKey}`, "notion-version": NOTION_VERSION, "content-type": "application/json" },
      body: JSON.stringify({ children: [{ object: "block", type: "paragraph", paragraph: { rich_text: [{ text: { content: text } }] } }] }),
    });
    if (!res.ok) throw new Error(`notion PATCH /blocks/:page/children → ${res.status}`);
    const json = (await res.json()) as { results?: { id?: unknown }[] };
    const id = typeof json.results?.[0]?.id === "string" ? json.results[0].id : "";
    if (!id) throw new Error("notion block append returned no block id");
    this.blockIdsCache = undefined;
    return id;
  }

  async archiveBlock(blockId: string): Promise<void> {
    await fetch(`${NOTION_API}/blocks/${encodeURIComponent(blockId)}`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${this.cfg.driverKey}`, "notion-version": NOTION_VERSION, "content-type": "application/json" },
      body: JSON.stringify({ archived: true }),
    }).catch(() => undefined);
  }

  async pageBlocks(): Promise<readonly string[]> {
    const json = await this.api(`/blocks/${encodeURIComponent(this.cfg.pageId)}/children?page_size=50`);
    const results = Array.isArray(json.results) ? (json.results as Record<string, unknown>[]) : [];
    return results.map((b) => (typeof b.id === "string" ? b.id : "")).filter((id) => id.length > 0);
  }

  async createBlockDiscussion(blockId: string, text: string): Promise<{ commentId: string; discussionId: string }> {
    const res = await fetch(`${NOTION_API}/comments`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.cfg.driverKey}`,
        "notion-version": NOTION_COMMENT_VERSION,
        "content-type": "application/json",
      },
      body: JSON.stringify(buildBlockCommentBody(blockId, text)),
    });
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

  async awaitBotReplyIn(discussionId: string, sinceTime: string, opts: { timeoutMs: number }): Promise<NotionComment> {
    return pollUntil(
      async () => (await this.allComments()).find((c) => this.isBotComment(c) && c.discussionId === discussionId && c.createdTime > sinceTime),
      { timeoutMs: opts.timeoutMs, what: `a bot reply in discussion ${discussionId} after ${sinceTime}` },
    );
  }

  async forgeCommentCreated(targetUrl: string, commentId: string, opts: { signed?: boolean } = {}): Promise<{ status: number }> {
    const rawBody = JSON.stringify(buildCommentCreatedEvent({ workspaceId: this.cfg.workspaceId, commentId, pageId: this.cfg.pageId }));
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (opts.signed !== false) {
      if (!this.cfg.webhookSecret) throw new Error("forgeCommentCreated(signed) requires E2E_NOTION_WEBHOOK_SECRET — the forge legs must gate on it");
      headers["x-notion-signature"] = signNotionBody(this.cfg.webhookSecret, rawBody);
    }
    const res = await fetch(`${targetUrl.replace(/\/+$/, "")}/eve/v1/notion`, { method: "POST", headers, body: rawBody });
    return { status: res.status };
  }
}
