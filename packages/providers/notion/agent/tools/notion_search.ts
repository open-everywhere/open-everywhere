import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { resolveNotionCredential, searchNotion } from "../channels/notion-api.js";
import { notionWorkGrant, notionWorkMount } from "../channels/notion-work.js";
import { assertNotionActingIdentity } from "../channels/notion-acting-identity.js";
import {
  ingestUntrustedModelOutput,
  getConfig,
  preRegisterDynamicEntry,
  type BindableContext,
} from "@open-everywhere/core/agent/adapter-api.js";

const MAX_RESULTS = 25;

export const notionSearchEntry = defineTool({
  description:
    "Search this domain's Notion workspace by title and text, and get back page ids + titles. " +
    "Use it to FIND the page you need — a spec, a runbook, a notes page — then read it with " +
    "read_notion_page. It returns no page content, so a result is a pointer, not an answer.",
  inputSchema: z.object({
    query: z.string().min(1).describe("Words to search for in page titles and text."),
    limit: z.number().int().min(1).max(MAX_RESULTS).optional().describe(`How many results to return (default 10, max ${MAX_RESULTS}).`),
    kind: z.enum(["page", "database"]).optional().describe("Restrict results to pages or to databases. Omit for both."),
  }),
  outputSchema: z.object({
    query: z.string(),
    hits: z.array(z.object({ id: z.string(), object: z.string(), title: z.string(), url: z.string().optional() })),
  }),
  async execute(input, ctx) {
    const domains = getConfig().loadDomains();
    const grant = notionWorkGrant(ctx as BindableContext, domains);
    if (!grant) {
      throw new Error(
        "This domain holds no Notion work grant, so Notion search is unavailable here. " +
          "An operator grants it by declaring the domain's Notion work credential in agent/memory/config/domains.ts.",
      );
    }
    await assertNotionActingIdentity(ctx as BindableContext, "notion_search");
    const cred = await resolveNotionCredential(grant.credential);
    if (!cred) throw new Error(`no value stored for this domain's Notion work credential "${grant.credential}" — cannot search.`);
    const hits = await searchNotion(input.query, {
      ...cred,
      pageSize: input.limit ?? 10,
      ...(input.kind ? { filter: input.kind } : {}),
    });
    return { query: input.query, hits: hits.slice(0, input.limit ?? 10).map((h) => ({ ...h })) };
  },
  toModelOutput(output) {
    const body =
      output.hits.length === 0
        ? `Notion search for "${output.query}" matched nothing the work integration can see.`
        : `Notion search for "${output.query}" — ${output.hits.length} result(s):\n` +
          output.hits.map((h) => `- ${h.object} ${h.id}: ${h.title || "(untitled)"}`).join("\n");
    return ingestUntrustedModelOutput(body, {
      source: "notion search",
      ingestion: { kind: "notion", label: "notion_search" },
    });
  },
});
preRegisterDynamicEntry("notion_search", "_single", notionSearchEntry);

export default defineDynamic({
  events: {
    "session.started": (_event, ctx) => {
      if (!notionWorkMount(ctx as BindableContext, () => getConfig().loadDomains())) return null;
      return notionSearchEntry;
    },
  },
});
