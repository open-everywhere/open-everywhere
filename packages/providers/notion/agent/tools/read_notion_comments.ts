import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { readNotionComments, resolveBlockOwningPage, resolveNotionCredential, type NotionCommentSummary } from "../channels/notion-api.js";
import { notionCallerCredential } from "../channels/notion-credentials.js";
import { assertNotionBlockAllowed, assertNotionPageAllowed } from "../channels/notion-scope.js";
import {
  ingestUntrustedModelOutput,
  assertTurnSurface,
  bindFrom,
  sourceScopedMount,
  getConfig,
  preRegisterDynamicEntry,
  resolvePartition,
  declaredWorkspaceTrust,
  type SurfaceTrust,
  type BindableContext,
} from "@open-everywhere/core/agent/adapter-api.js";

const MAX_COMMENTS = 100;
const MAX_BLOCK_SCANS = 80;

function renderComments(comments: readonly NotionCommentSummary[]): string {
  if (comments.length === 0) return "";
  const byAnchor = new Map<string, NotionCommentSummary[]>();
  for (const c of comments) {
    const key = c.anchorId ?? "(unknown)";
    let list = byAnchor.get(key);
    if (!list) {
      list = [];
      byAnchor.set(key, list);
    }
    list.push(c);
  }
  const sections: string[] = [];
  for (const [anchor, list] of byAnchor) {
    const disc = list.find((c) => c.discussionId)?.discussionId;
    const head = `discussion on block ${anchor}${disc ? ` (discussion_id ${disc})` : ""}:`;
    const lines = list.map((c) => {
      const who = c.authorId ? `${c.authorKind ?? "user"} ${c.authorId}` : "unknown author";
      const when = c.createdTime ? ` at ${c.createdTime}` : "";
      return `  - ${who}${when}: ${c.text}`;
    });
    sections.push([head, ...lines].join("\n"));
  }
  return sections.join("\n\n");
}

export const readNotionCommentsEntry = defineTool({
  description:
    "Read the comments / inline discussions on a Notion page (this doc, or another page shared with " +
    "the integration). Use it when a reply needs OTHER discussions on the page — a comment on a " +
    "different block, or an older thread — beyond the one you were woken on (already in context). " +
    "Pass `block` to read just one block's inline discussion. Bounded; truncates a heavily-commented page.",
  inputSchema: z.object({
    page: z
      .string()
      .min(1)
      .optional()
      .describe("The Notion page id whose comments to read. Defaults to THIS doc — the page the comment you're on lives in."),
    block: z
      .string()
      .min(1)
      .optional()
      .describe("Read ONLY this block's inline discussion (a block/page id), instead of sweeping the whole page."),
  }),
  outputSchema: z.object({
    page: z.string(),
    discussions: z.number(),
    comments: z.number(),
    blocksScanned: z.number(),
    truncated: z.boolean(),
    text: z.string(),
    workspaceTrust: z.enum(["internal", "public"]).optional(),
  }),
  async execute(input, ctx2) {
    assertTurnSurface(ctx2 as BindableContext, "notion");
    const page = input.page ?? bindFrom(ctx2 as BindableContext).surface;
    if (!page) throw new Error("No Notion page id available for this session — pass `page` explicitly.");
    const domains = getConfig().loadDomains();
    await assertNotionPageAllowed(ctx2 as BindableContext, page, domains);
    const cred = await resolveNotionCredential(notionCallerCredential(ctx2 as BindableContext, domains));
    if (!cred) throw new Error("no value stored under db:notion:channel-key — cannot read the comments.");
    if (input.block) {
      await assertNotionBlockAllowed(ctx2 as BindableContext, input.block, domains, (id) => resolveBlockOwningPage(id, { ...cred }));
    }
    const res = await readNotionComments(page, {
      ...cred,
      block: input.block,
      maxComments: MAX_COMMENTS,
      maxBlockScans: MAX_BLOCK_SCANS,
    });
    let workspaceTrust: SurfaceTrust | undefined;
    try {
      workspaceTrust = declaredWorkspaceTrust(resolvePartition(ctx2 as BindableContext).workspaceKey);
    } catch {
      workspaceTrust = undefined;
    }
    return {
      page,
      discussions: res.discussionCount,
      comments: res.comments.length,
      blocksScanned: res.blocksScanned,
      truncated: res.truncated,
      text: renderComments(res.comments),
      ...(workspaceTrust !== undefined ? { workspaceTrust } : {}),
    };
  },
  toModelOutput(output) {
    const header =
      output.comments === 0
        ? `Notion page ${output.page} has no readable comments.`
        : `Notion page ${output.page} — ${output.comments} comment(s) across ${output.discussions} discussion(s):`;
    const suffix = output.truncated ? "\n\n[truncated — the page has more comments/blocks than shown]" : "";
    const body = output.comments === 0 ? header : `${header}\n${output.text}${suffix}`;
    return ingestUntrustedModelOutput(body, {
      source: `notion comments ${output.page}`,
      ingestion: {
        kind: "notion",
        label: "read_notion_comments",
        ...(output.workspaceTrust !== undefined ? { workspaceTrust: output.workspaceTrust } : {}),
      },
    });
  },
});
preRegisterDynamicEntry("read_notion_comments", "_single", readNotionCommentsEntry);

export default defineDynamic({
  events: {
    "session.started": (_event, ctx) => {
      if (!sourceScopedMount(ctx as BindableContext, "notion", () => getConfig().loadDomains())) return null;
      return readNotionCommentsEntry;
    },
  },
});
