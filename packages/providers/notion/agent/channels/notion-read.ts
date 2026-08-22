import {
  bindFrom,
  getConfig,
  type BindableContext,
  type Domain,
  type RenderedLine,
  type WakeReadAddress,
} from "@open-everywhere/core/agent/adapter-api.js";
import {
  listBlockComments,
  readNotionComments,
  resolveNotionCredential,
  toNotionCommentSummary,
  type NotionCallOpts,
  type NotionCommentSummary,
} from "./notion-api.js";
import { notionCallerCredential } from "./notion-credentials.js";
import { assertNotionPageAllowed } from "./notion-scope.js";

export const ANCHOR_SNIPPET_MAX = 120;
const NOTION_CHANNEL_DEFAULT_LIMIT = 50;
const NOTION_THREAD_DEFAULT_LIMIT = 100;
const NOTION_MAX_BLOCK_SCANS = 80;
const NOTION_THREAD_SWEEP_COMMENTS = 300;

export interface NotionReadDeps {
  readonly call?: NotionCallOpts;
}

function safeDomains(): readonly Domain[] {
  try {
    return getConfig().loadDomains();
  } catch {
    return [];
  }
}

function authorFields(c: NotionCommentSummary): Pick<RenderedLine, "author" | "authorId" | "bot"> {
  if (!c.authorId) return { author: "(unknown)" };
  const author = `${c.authorKind ?? "user"} ${c.authorId}`;
  return c.authorKind === "bot" ? { author, bot: true } : { author, authorId: c.authorId };
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/gu, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

export function notionDiscussionHeader(c: NotionCommentSummary, pageId: string): string {
  const id = c.discussionId ?? "(unknown)";
  const anchored =
    c.anchorText && c.anchorText.trim().length > 0
      ? `on "${clip(c.anchorText, ANCHOR_SNIPPET_MAX)}"`
      : c.anchorId && c.anchorId !== pageId
        ? `on block ${c.anchorId}`
        : "on the page";
  return `[discussion ${id} — ${anchored}]`;
}

function byDiscussion(comments: readonly NotionCommentSummary[]): NotionCommentSummary[][] {
  const groups = new Map<string, NotionCommentSummary[]>();
  const order: string[] = [];
  for (const c of comments) {
    const key = c.discussionId ?? `anchor:${c.anchorId ?? "unknown"}`;
    let group = groups.get(key);
    if (!group) {
      group = [];
      groups.set(key, group);
      order.push(key);
    }
    group.push(c);
  }
  return order.map((key) => groups.get(key) ?? []);
}

export function notionChannelLines(comments: readonly NotionCommentSummary[], pageId: string): RenderedLine[] {
  const lines: RenderedLine[] = [];
  for (const group of byDiscussion(comments)) {
    group.forEach((c, index) => {
      const body = index === 0 ? `${notionDiscussionHeader(c, pageId)}\n${c.text}` : c.text;
      lines.push({ ...authorFields(c), ts: c.createdTime ?? "", text: body });
    });
  }
  return lines;
}

export function notionThreadLines(comments: readonly NotionCommentSummary[], discussionId: string, pageId: string): RenderedLine[] {
  const mine = comments.filter((c) => c.discussionId === discussionId);
  return mine.map((c, index) => ({
    ...authorFields(c),
    ts: c.createdTime ?? "",
    text: index === 0 ? `${notionDiscussionHeader(c, pageId)}\n${c.text}` : c.text,
  }));
}

async function admit(ctx: BindableContext, page: string, deps?: NotionReadDeps): Promise<NotionCallOpts> {
  const domains = safeDomains();
  await assertNotionPageAllowed(ctx, page, domains);
  if (deps?.call) return deps.call;
  const cred = await resolveNotionCredential(notionCallerCredential(ctx, domains));
  if (!cred) throw new Error("read: no Notion credential is stored for this session, so nothing can be read.");
  return cred;
}

export const notionReadAdapter = {
  platform: "notion" as const,
  wakeAddress(ctx: BindableContext): WakeReadAddress | undefined {
    const target = bindFrom(ctx).target as { readonly pageId?: unknown; readonly discussionId?: unknown } | undefined;
    const container = typeof target?.pageId === "string" && target.pageId.length > 0 ? target.pageId : undefined;
    if (!container) return undefined;
    const threadRoot = typeof target?.discussionId === "string" && target.discussionId.length > 0 ? target.discussionId : undefined;
    return { container, ...(threadRoot ? { threadRoot } : {}) };
  },
  async readChannel(ctx: BindableContext, channel: string, limit?: number, deps?: NotionReadDeps): Promise<readonly RenderedLine[]> {
    const call = await admit(ctx, channel, deps);
    const effective = Math.max(1, limit ?? NOTION_CHANNEL_DEFAULT_LIMIT);
    const res = await readNotionComments(channel, { ...call, maxComments: effective, maxBlockScans: NOTION_MAX_BLOCK_SCANS });
    return notionChannelLines(res.comments, channel);
  },
  async readThread(ctx: BindableContext, channel: string, threadTs: string, limit?: number, deps?: NotionReadDeps): Promise<readonly RenderedLine[]> {
    const call = await admit(ctx, channel, deps);
    const pageLevel = (await listBlockComments(channel, call)).filter((c) => c.discussion_id === threadTs);
    if (pageLevel.length > 0) {
      const summaries: NotionCommentSummary[] = pageLevel.map((c) => toNotionCommentSummary(c, channel));
      return notionThreadLines(summaries, threadTs, channel).slice(-(limit ?? NOTION_THREAD_DEFAULT_LIMIT));
    }
    const res = await readNotionComments(channel, {
      ...call,
      maxComments: NOTION_THREAD_SWEEP_COMMENTS,
      maxBlockScans: NOTION_MAX_BLOCK_SCANS,
    });
    return notionThreadLines(res.comments, threadTs, channel).slice(-(limit ?? NOTION_THREAD_DEFAULT_LIMIT));
  },
};
