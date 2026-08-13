import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { readNotionPage, resolveBlockOwningPage, resolveNotionApiKey } from "../channels/notion-api.js";
import { notionCallerCredential } from "../channels/notion-credentials.js";
import { assertNotionPageAllowed, assertNotionPageAllowedOrResolveBlock } from "../channels/notion-scope.js";
import {
  ingestUntrustedModelOutput,
  assertTurnSurface,
  bindFrom,
  sourceScopedMount,
  getConfig,
  preRegisterDynamicEntry,
  resolvePartition,
  declaredWorkspaceTrust,
  type BindableContext,
} from "@open-everywhere/core/agent/adapter-api.js";

const MAX_CHARS = 20_000;
const MAX_BLOCKS = 200;

export const readNotionPageEntry = defineTool({
        description:
          "Read the text of a Notion page (this doc, or another page shared with the integration). " +
          "Use it when a reply needs the doc's own content — to answer a question about the page or " +
          "catch a problem in it. Returns the page's top-level text (truncated if very long); the " +
          "comment thread you were woken on is already in your context.",
        inputSchema: z.object({
          page: z
            .string()
            .min(1)
            .optional()
            .describe("The Notion page id to read (e.g. a UUID). Defaults to THIS doc — the page the comment you're on lives in."),
        }),
        outputSchema: z.object({
          page: z.string(),
          blocks: z.number(),
          truncated: z.boolean(),
          text: z.string(),
          workspaceTrust: z.literal("internal").optional(),
        }),
        async execute(input, ctx2) {
          assertTurnSurface(ctx2 as BindableContext, "notion");
          const requestedPage = input.page ?? bindFrom(ctx2 as BindableContext).surface;
          if (!requestedPage) throw new Error("No Notion page id available for this session — pass `page` explicitly.");
          const domains = getConfig().loadDomains();
          const apiKey = await resolveNotionApiKey(notionCallerCredential(ctx2 as BindableContext, domains));
          let page: string;
          if (apiKey) {
            page = await assertNotionPageAllowedOrResolveBlock(ctx2 as BindableContext, requestedPage, domains, (id) => resolveBlockOwningPage(id, { apiKey }));
          } else {
            await assertNotionPageAllowed(ctx2 as BindableContext, requestedPage, domains);
            page = requestedPage;
          }
          if (!apiKey) throw new Error("no value stored under db:notion:channel-key — cannot read the page.");
          const res = await readNotionPage(page, { apiKey, maxChars: MAX_CHARS, maxBlocks: MAX_BLOCKS });
          let workspaceTrust: "internal" | undefined;
          try {
            workspaceTrust = declaredWorkspaceTrust(resolvePartition(ctx2 as BindableContext).workspaceKey);
          } catch {
            workspaceTrust = undefined;
          }
          return { page, blocks: res.blockCount, truncated: res.truncated, text: res.text, ...(workspaceTrust !== undefined ? { workspaceTrust } : {}) };
        },
        toModelOutput(output) {
          const header = output.text.length === 0 ? `Notion page ${output.page} has no readable text.` : `Notion page ${output.page}:`;
          const suffix = output.truncated ? "\n\n[truncated — the page has more content than shown]" : "";
          const body = output.text.length === 0 ? header : `${header}\n${output.text}${suffix}`;
          return ingestUntrustedModelOutput(body, {
            source: `notion page ${output.page}`,
            ingestion: {
              kind: "notion",
              label: "read_notion_page",
              ...(output.workspaceTrust !== undefined ? { workspaceTrust: output.workspaceTrust } : {}),
            },
          });
        },
});
preRegisterDynamicEntry("read_notion_page", "_single", readNotionPageEntry);

export default defineDynamic({
  events: {
    "session.started": (_event, ctx) => {
      if (!sourceScopedMount(ctx as BindableContext, "notion", () => getConfig().loadDomains())) return null;
      return readNotionPageEntry;
    },
  },
});
