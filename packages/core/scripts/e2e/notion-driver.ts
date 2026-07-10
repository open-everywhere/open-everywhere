import { createHmac } from "node:crypto";
import type { NotionAmbientConfig } from "./env.js";
import { pollUntil } from "./poll.js";

const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";

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

export class NotionDriver {
  constructor(private readonly cfg: NotionAmbientConfig) {}

  get botUserId(): string {
    return this.cfg.botUserId;
  }
  get anchorOnTopic(): string {
    return this.cfg.anchorOnTopic;
  }
  get anchorOnTopic2(): string {
    return this.cfg.anchorOnTopic2;
  }
  get anchorOffTopic(): string {
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

  async pageComments(): Promise<readonly NotionComment[]> {
    const json = await this.api(`/comments?block_id=${encodeURIComponent(this.cfg.pageId)}`);
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

  async discussionOf(commentId: string): Promise<string | undefined> {
    return (await this.pageComments()).find((c) => c.id === commentId)?.discussionId;
  }

  isBotComment(c: NotionComment): boolean {
    return c.authorId === this.cfg.botUserId;
  }

  async awaitBotReplyIn(discussionId: string, sinceTime: string, opts: { timeoutMs: number }): Promise<NotionComment> {
    return pollUntil(
      async () => (await this.pageComments()).find((c) => this.isBotComment(c) && c.discussionId === discussionId && c.createdTime > sinceTime),
      { timeoutMs: opts.timeoutMs, what: `a bot reply in discussion ${discussionId} after ${sinceTime}` },
    );
  }

  async forgeCommentCreated(targetUrl: string, commentId: string, opts: { signed?: boolean } = {}): Promise<{ status: number }> {
    const rawBody = JSON.stringify(buildCommentCreatedEvent({ workspaceId: this.cfg.workspaceId, commentId, pageId: this.cfg.pageId }));
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (opts.signed !== false) headers["x-notion-signature"] = signNotionBody(this.cfg.webhookSecret, rawBody);
    const res = await fetch(`${targetUrl.replace(/\/+$/, "")}/eve/v1/notion`, { method: "POST", headers, body: rawBody });
    return { status: res.status };
  }
}
