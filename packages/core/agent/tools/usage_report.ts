import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";
import { usageSummary } from "../spend/usage-events.js";
import { getConfig } from "../access/config.js";
import { resolveReportScope, filterToDomain, approxConversationCount, aggregateByUser, aggregateBySurface } from "../spend/reporting.js";

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

export default defineTool({
  description:
    "Activity analytics for your memory domain, or (org admins only) the whole org: conversation count (an estimate — see note), turns, a per-user activity breakdown, and the busiest surfaces, over a time window. scope=\"domain\" works for anyone in a memory domain; scope=\"org\" requires an org admin.",
  inputSchema: z.object({
    scope: z.enum(["domain", "org"]).describe('"domain" = your own resolved memory domain (anyone in it); "org" = the whole org (org-admin only).'),
    sinceDays: z.number().int().positive().max(365).optional().describe("Window in days, default 30."),
  }),
  outputSchema: z.object({
    scope: z.enum(["domain", "org"]),
    org: z.string(),
    domain: z.string().optional(),
    sinceDays: z.number(),
    since: z.string(),
    conversations: z.number().describe("Distinct-session estimate — see note."),
    turns: z.number().describe("Non-sandbox usage-event count (~model calls)."),
    byUser: z.array(z.object({ principalId: z.string(), events: z.number(), inputTokens: z.number(), outputTokens: z.number() })),
    busiestSurfaces: z.array(z.object({ surfaceKey: z.string(), events: z.number(), sessions: z.number(), inputTokens: z.number(), outputTokens: z.number() })),
    note: z.string(),
  }),
  approval: never(),
  async execute(input, ctx) {
    const resolved = resolveReportScope(ctx, input.scope);
    const sinceDays = input.sinceDays ?? 30;
    const since = isoDaysAgo(sinceDays);

    const allRows = await usageSummary(resolved.org, { sinceTs: since });
    const scopedRows = resolved.domain ? filterToDomain(allRows, resolved.domain, getConfig().loadDomains()) : allRows;

    const conversations = approxConversationCount(scopedRows);
    const busiestSurfaces = aggregateBySurface(scopedRows);
    const turns = busiestSurfaces.reduce((sum, s) => sum + s.events, 0);
    const byUser = aggregateByUser(scopedRows);

    return {
      scope: input.scope,
      org: resolved.org,
      ...(resolved.domain ? { domain: resolved.domain } : {}),
      sinceDays,
      since,
      conversations,
      turns,
      byUser,
      busiestSurfaces,
      note:
        'conversations is an approximation: usage rows are grouped by (surface, user, kind), and a single conversation CAN carry more than one sender (per-turn identity changes turn to turn), so this can overcount a multi-sender thread — turns/byUser/busiestSurfaces event counts are exact (plain sums), only the distinct-session figures ("conversations" and each surface\'s "sessions") share this caveat. principalId is the raw platform id (e.g. a Slack member id) — no display-name lookup here.',
    };
  },
});
