import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import type { BindableContext } from "../identity/binding.js";
import { getConfig } from "../access/config.js";
import { preRegisterDynamicEntry } from "../access/window-gated.js";
import { ingestUntrustedModelOutput } from "../access/untrusted.js";
import { searchGrantedConnectors, workSearchAdapterFor, type WorkSearchAbsence, type WorkSearchHit } from "../channels/work-search.js";
import { callerWorkDomain } from "../access/work-grant.js";
import type { Domain } from "../memory/domain.js";
import { registerGithubWorkSearch } from "../scm/github-search.js";

registerGithubWorkSearch();

const MAX_RESULTS = 25;
const DEFAULT_LIMIT = 10;

function safeDomains(): readonly Domain[] {
  try {
    return getConfig().loadDomains();
  } catch {
    return [];
  }
}

export const searchEntry = defineTool({
  description:
    "Search this domain's connected work surfaces (GitHub, Notion, Linear, ...) by keyword, and get " +
    "back ids + titles — a pointer, not an answer. A result names its connector; read the actual " +
    "item with the matching read tool (read_notion_page, read_linear_issue, check_pr_status, ...). " +
    "Omit `scope` to search every surface this domain holds a work grant on; a surface with no " +
    "search-capable credential is reported absent, not silently skipped.",
  inputSchema: z.object({
    query: z.string().min(1).describe("Words to search for."),
    scope: z.string().min(1).optional().describe('Restrict the search to one connected surface, e.g. "github". Omit to search every granted surface.'),
    insideDomain: z
      .boolean()
      .optional()
      .describe(
        "Narrow each surface's results to this domain's own declared space (its bound repos/pages/teams) — a CONVENIENCE, not a security boundary: every result is already bounded by the credential's own reach whether or not this is set.",
      ),
    limit: z.number().int().min(1).max(MAX_RESULTS).optional().describe(`How many results per surface (default ${DEFAULT_LIMIT}, max ${MAX_RESULTS}).`),
  }),
  outputSchema: z.object({
    query: z.string(),
    insideDomain: z.boolean(),
    hits: z.array(z.object({ connector: z.string(), id: z.string(), title: z.string(), url: z.string().optional() })),
    absent: z.array(z.object({ connector: z.string(), reason: z.string() })),
  }),
  async execute(input, ctx) {
    const bctx = ctx as BindableContext;
    const domains = safeDomains();
    const domain = callerWorkDomain(bctx, () => domains);
    if (!domain) {
      throw new Error("This session's domain holds no work grant, so search is unavailable here.");
    }
    const granted = searchGrantedConnectors(bctx, domains);
    if (granted.length === 0) {
      throw new Error("This domain holds no work grant on any connected surface, so search is unavailable here.");
    }
    const scope = input.scope?.trim();
    if (scope && !granted.includes(scope)) {
      throw new Error(`This domain holds no "${scope}" work grant. Grants held: ${granted.join(", ")}.`);
    }
    const targets = scope ? [scope] : granted;
    const insideDomain = input.insideDomain ?? false;
    const limit = input.limit ?? DEFAULT_LIMIT;

    const hits: WorkSearchHit[] = [];
    const absent: WorkSearchAbsence[] = [];
    for (const connector of targets) {
      const adapter = workSearchAdapterFor(connector);
      if (!adapter) {
        absent.push({ connector, reason: `no search-capable credential configured for ${connector}` });
        continue;
      }
      try {
        const connectorHits = await adapter.search(bctx, domain, input.query, { limit, insideDomain });
        hits.push(...connectorHits);
      } catch (err) {
        absent.push({ connector, reason: err instanceof Error ? err.message : String(err) });
      }
    }

    return { query: input.query, insideDomain, hits: hits.slice(0, MAX_RESULTS), absent };
  },
  toModelOutput(output) {
    const lines: string[] = [];
    if (output.hits.length === 0) {
      lines.push(`Search for "${output.query}" matched nothing across the surfaces this domain can reach.`);
    } else {
      lines.push(`Search for "${output.query}" — ${output.hits.length} result(s):`);
      for (const h of output.hits) lines.push(`- [${h.connector}] ${h.id}: ${h.title}${h.url ? ` (${h.url})` : ""}`);
    }
    if (output.absent.length > 0) {
      lines.push(`Not searched: ${output.absent.map((a) => `${a.connector} (${a.reason})`).join("; ")}.`);
    }
    return ingestUntrustedModelOutput(lines.join("\n"), {
      source: "search",
      ingestion: { kind: "work-search", label: "search" },
    });
  },
});
preRegisterDynamicEntry("search", "_single", searchEntry);

export default defineDynamic({
  events: {
    "session.started": (_event, ctx) => {
      const bctx = ctx as BindableContext;
      if (searchGrantedConnectors(bctx, safeDomains()).length === 0) return null;
      return searchEntry;
    },
  },
});
