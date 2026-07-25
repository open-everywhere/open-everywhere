import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";
import { usageSummary } from "../spend/usage-events.js";
import { getConfig } from "../access/config.js";
import { resolveReportScope, filterToDomain, approxConversationCount, aggregateByUser, aggregateBySurface, resolveSlackLabels, maskDmSurfaceKey } from "../spend/reporting.js";
import { fulfilPaneRead } from "../access/pane-venue.js";
import { bridgeFetchUserDisplayName, bridgeFetchChannelDisplayName } from "../channels/slack-bridge.js";

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function renderUsageReportForDm(r: { org: string; sinceDays: number; conversations: number; turns: number; byUser: readonly { principalId: string; name?: string; events: number }[]; busiestSurfaces: readonly { surfaceKey: string; channel?: string; events: number }[] }): string {
  const lines = [
    `Usage — org "${r.org}", last ${r.sinceDays} days`,
    `conversations ≈ ${r.conversations} · turns ${r.turns}`,
    "",
    "Most active people:",
    ...(r.byUser.length ? r.byUser.slice(0, 5).map((u) => `  • ${u.name ?? u.principalId} — ${u.events} turns`) : ["  (none in window)"]),
    "",
    "Busiest surfaces:",
    ...(r.busiestSurfaces.length ? r.busiestSurfaces.slice(0, 5).map((s) => `  • ${s.channel ?? s.surfaceKey} — ${s.events} turns`) : ["  (none in window)"]),
    "",
    'Top rows only; "conversations" is an estimate. Ask again in a governance channel (or use the control plane) for the full breakdown.',
  ];
  return lines.join("\n");
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
    byUser: z.array(z.object({ principalId: z.string(), name: z.string().optional(), events: z.number(), inputTokens: z.number(), outputTokens: z.number() })),
    busiestSurfaces: z.array(z.object({ surfaceKey: z.string(), channel: z.string().optional(), events: z.number(), sessions: z.number(), inputTokens: z.number(), outputTokens: z.number() })),
    note: z.string(),
  }),
  approval: never(),
  async execute(input, ctx) {
    const resolved = resolveReportScope(ctx, input.scope);
    const build = async () => {
      const sinceDays = input.sinceDays ?? 30;
      const since = isoDaysAgo(sinceDays);

      const allRows = await usageSummary(resolved.org, { sinceTs: since });
      const scopedRows = resolved.domain ? filterToDomain(allRows, resolved.domain, getConfig().loadDomains()) : allRows;
      const maskedRows = scopedRows.map(maskDmSurfaceKey);

      const conversations = approxConversationCount(maskedRows);
      const surfaces = aggregateBySurface(maskedRows);
      const turns = surfaces.reduce((sum, s) => sum + s.events, 0);
      const users = aggregateByUser(scopedRows);

      const labels = await resolveSlackLabels(
        users.map((u) => u.principalId),
        surfaces.map((s) => s.surfaceKey),
        { userName: bridgeFetchUserDisplayName, channelName: bridgeFetchChannelDisplayName },
      );
      const byUser = users.map((u) => ({ ...u, ...(labels.users.has(u.principalId) ? { name: labels.users.get(u.principalId)! } : {}) }));
      const busiestSurfaces = surfaces.map((s) => ({ ...s, ...(labels.channels.has(s.surfaceKey) ? { channel: labels.channels.get(s.surfaceKey)! } : {}) }));

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
          'conversations is an approximation: usage rows are grouped by (surface, user, kind), and a single conversation CAN carry more than one sender (per-turn identity changes turn to turn), so this can overcount a multi-sender thread — turns/byUser/busiestSurfaces event counts are exact (plain sums), only the distinct-session figures ("conversations" and each surface\'s "sessions") share this caveat. name/channel labels are best-effort Slack lookups — prefer them when presenting, but the raw ids are the ground truth (a row without a label is a non-Slack principal, a DM, or a failed lookup). DM usage is aggregated into a single "(dms)" bucket per workspace — individual DM surfaces are deliberately never listed in reports (the underlying rows keep full resolution).',
      };
    };
    if (input.scope !== "org") return await build();
    return await fulfilPaneRead(ctx, { kind: "usage.report.org", render: renderUsageReportForDm }, build);
  },
});
