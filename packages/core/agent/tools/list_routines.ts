import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";
import { resolvePartition } from "../memory/partition.js";
import { listRoutines } from "../routines/store.js";
import { emptyRoutineForensics, readRoutineForensics } from "../routines/fire-audit.js";
import { describeTrigger } from "../routines/routine.js";
import { listRoutinePermissions } from "../routines/grants.js";

export default defineTool({
  description:
    "List the routines (scheduled jobs, watches, event subscriptions) set up on this surface, with their status, next run time, recent run history (last session id, last time it posted, fires and tokens over 7 days), and the standing permissions each one may use unattended without asking. Use when asked what proactive/recurring work is configured here, whether a routine actually ran, what one is costing, or what any of them are allowed to do on their own.",
  inputSchema: z.object({
    includeDisabled: z.boolean().default(false).describe("Include auto-disabled routines and completed jobs (terminal rows kept for visibility)."),
    id: z.string().optional().describe("Report on ONE routine by id (e.g. 'r-1a2b3c4d'). Omit to list them all."),
  }),
  outputSchema: z.object({
    routines: z.array(
      z.object({
        id: z.string(),
        trigger: z.string(),
        prompt: z.string(),
        status: z.string(),
        job: z.boolean(),
        createdAt: z.string(),
        createdBy: z.string().nullable(),
        nextRunAt: z.string().nullable(),
        lastRunAt: z.string().nullable(),
        lastOutcome: z.string().nullable(),
        consecutiveFailures: z.number(),
        taintedAtCreation: z.boolean(),
        lastSessionId: z.string().nullable(),
        lastPostedAt: z.string().nullable(),
        fires7d: z.number(),
        tokens7d: z.number(),
        permissions: z.array(z.string()),
        note: z.string().nullable(),
      }),
    ),
  }),
  approval: never(),
  async execute(input, ctx) {
    const p = resolvePartition(ctx);
    const all = await listRoutines(p);
    const selected = all.filter((r) =>
      input.id !== undefined ? r.id === input.id : input.includeDisabled || r.status === "active",
    );
    const forensics = await readRoutineForensics({
      org: p.org,
      platform: p.platform,
      workspace: p.workspace,
      surface: p.surface,
      surfaceKey: p.surfaceKey,
    });
    const nowIso = new Date().toISOString();
    const permissions = new Map<string, string[]>();
    for (const r of selected) permissions.set(r.id, await listRoutinePermissions(p.org, r, nowIso));
    const routines = selected.map((r) => {
      const f = forensics.get(r.id) ?? emptyRoutineForensics();
      return {
        id: r.id,
        trigger: describeTrigger(r.trigger, r.report),
        prompt: r.prompt,
        status: r.status,
        job: r.sessionMode === "job",
        createdAt: r.createdAt,
        createdBy: r.createdBy ?? null,
        nextRunAt: r.nextRunAt ?? null,
        lastRunAt: r.lastRunAt ?? null,
        lastOutcome: r.lastOutcome ?? null,
        consecutiveFailures: r.consecutiveFailures,
        taintedAtCreation: r.taintedAtCreation === true,
        lastSessionId: f.lastSessionId,
        lastPostedAt: f.lastPostedAt,
        fires7d: f.fires7d,
        tokens7d: f.tokens7d,
        permissions: permissions.get(r.id) ?? [],
        note: r.status === "done" ? r.completedReason ?? "job done" : r.disabledReason ?? null,
      };
    });
    return { routines };
  },
});
