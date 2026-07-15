import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { readNotionPage } from "../channels/notion-api.js";
import { ingestUntrusted } from "../access/untrusted.js";
import { assertTurnSurface, bindFrom, type BindableContext } from "../identity/binding.js";
import { sourceScopedMount } from "../access/source-scoped-mount.js";
import { getConfig } from "../access/config.js";

const MAX_CHARS = 20_000;
const MAX_BLOCKS = 200;

function notionApiKey(): string | undefined {
  const k = process.env.NOTION_API_KEY;
  return k && k.length > 0 ? k : undefined;
}

export default defineDynamic({
  events: {
    "session.started": (_event, ctx) => {
      if (!sourceScopedMount(ctx as BindableContext, "notion", () => getConfig().loadDomains())) return null;
      return defineTool({
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
        }),
        async execute(input, ctx2) {
          assertTurnSurface(ctx2 as BindableContext, "notion");
          const apiKey = notionApiKey();
          if (!apiKey) throw new Error("NOTION_API_KEY is not set — cannot read the page.");
          const page = input.page ?? bindFrom(ctx2 as BindableContext).surface;
          if (!page) throw new Error("No Notion page id available for this session — pass `page` explicitly.");
          const res = await readNotionPage(page, { apiKey, maxChars: MAX_CHARS, maxBlocks: MAX_BLOCKS });
          return { page, blocks: res.blockCount, truncated: res.truncated, text: res.text };
        },
        toModelOutput(output) {
          const header = output.text.length === 0 ? `Notion page ${output.page} has no readable text.` : `Notion page ${output.page}:`;
          const suffix = output.truncated ? "\n\n[truncated — the page has more content than shown]" : "";
          const body = output.text.length === 0 ? header : `${header}\n${output.text}${suffix}`;
          return { type: "text", value: ingestUntrusted(body, { source: `notion page ${output.page}` }) };
        },
      });
    },
  },
});
