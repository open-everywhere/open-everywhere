import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";
import { resolvePartition } from "../memory/partition.js";
import { listRoutines } from "../routines/store.js";
import { emptyRoutineForensics, readRoutineForensics } from "../routines/fire-audit.js";
import { describeTrigger } from "../routines/routine.js";
import { describeBound } from "../routines/bound.js";
import { describeStall } from "../routines/stall.js";
import { policyRules } from "../routines/policy.js";
import { emptyRoutinePermissionView, readRoutinePermissionViews } from "../routines/permission-review.js";
import { placeWords } from "../channels/friendly-ids.js";
import { nameBesideId } from "../channels/friendly-outbound.js";

export default defineTool({
  description:
    "List the routines (scheduled jobs, watches, event subscriptions) set up on this surface, with their status, next run time, recent run history (last session id, last time it posted, fires and tokens over 7 days), the standing permissions each one may use unattended without asking, the permissions each one ASKED for on a card and did not get, and the standing RULES each one has accumulated (with the id needed to remove one). Use when asked what proactive/recurring work is configured here, whether a routine actually ran, whether one is stuck waiting on a cost-checkpoint confirmation, whether an event subscription's filter has ever matched anything, what one is costing, what any of them are allowed to do on their own, what rules one has been told to follow, or what asked for approval while nobody was around — `permissionAsks` names each refused permission, whether its card is still waiting and in which room, and what to do about it. `permissionsUnreadable` marks a routine whose permission store could not be read, whose empty permission set therefore means \"unknown\" rather than \"none\".",
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
        createdByName: z.string().nullable(),
        nextRunAt: z.string().nullable(),
        lastRunAt: z.string().nullable(),
        lastOutcome: z.string().nullable(),
        firstMatchAt: z.string().nullable(),
        lastMatchAt: z.string().nullable(),
        consecutiveFailures: z.number(),
        ceiling: z.string().nullable(),
        stalled: z.string().nullable(),
        taintedAtCreation: z.boolean(),
        quietWhenEmpty: z.boolean(),
        lastSessionId: z.string().nullable(),
        lastPostedAt: z.string().nullable(),
        fires7d: z.number(),
        tokens7d: z.number(),
        permissions: z.array(z.string()),
        permissionAsks: z.array(
          z.object({
            permission: z.string(),
            declaration: z.string().nullable(),
            state: z.enum(["waiting", "unreadable", "superseded", "lapsed", "declined"]),
            askedAt: z.string().nullable(),
            room: z.string().nullable(),
            roomName: z.string().nullable(),
            nextStep: z.string(),
          }),
        ),
        permissionsUnreadable: z.boolean(),
        rules: z.array(
          z.object({
            id: z.string(),
            rule: z.string(),
            why: z.string(),
            addedAt: z.string(),
            addedBy: z.string(),
            addedByName: z.string().nullable(),
            source: z.string(),
          }),
        ),
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
    const views = await readRoutinePermissionViews(p.org, selected, nowIso);
    const people = [...new Set(selected.flatMap((r) => [r.createdBy ?? "", ...policyRules(r).map((x) => x.addedBy)]).filter((v) => v.length > 0))];
    const nameOf = new Map(await Promise.all(people.map(async (id) => [id, await nameBesideId(id)] as const)));
    const named = (id: string | undefined | null): string | null => {
      const labelled = id ? nameOf.get(id) : undefined;
      return labelled !== undefined && labelled !== id ? labelled.slice(0, labelled.lastIndexOf(" (")) : null;
    };
    const routines = selected.map((r) => {
      const f = forensics.get(r.id) ?? emptyRoutineForensics();
      const view = views.get(r.id) ?? emptyRoutinePermissionView();
      return {
        id: r.id,
        trigger: describeTrigger(r.trigger, r.report),
        prompt: r.prompt,
        status: r.status,
        job: r.sessionMode === "job",
        createdAt: r.createdAt,
        createdBy: r.createdBy ?? null,
        createdByName: named(r.createdBy),
        nextRunAt: r.nextRunAt ?? null,
        lastRunAt: r.lastRunAt ?? null,
        lastOutcome: r.lastOutcome ?? null,
        firstMatchAt: r.firstMatchAt ?? null,
        lastMatchAt: r.lastMatchAt ?? null,
        consecutiveFailures: r.consecutiveFailures,
        ceiling: describeBound(r),
        stalled: describeStall(r),
        taintedAtCreation: r.taintedAtCreation === true,
        quietWhenEmpty: r.quietWhenEmpty === true,
        lastSessionId: f.lastSessionId,
        lastPostedAt: f.lastPostedAt,
        fires7d: f.fires7d,
        tokens7d: f.tokens7d,
        permissions: view.permissions,
        permissionAsks: view.asks.map((a) => ({ ...a, roomName: a.room === null ? null : placeWords({ key: a.room }) })),
        permissionsUnreadable: view.permissionsUnreadable,
        rules: policyRules(r).map((x) => ({ id: x.id, rule: x.rule, why: x.why, addedAt: x.addedAt, addedBy: x.addedBy, addedByName: named(x.addedBy), source: x.source })),
        note: r.status === "done" ? r.completedReason ?? "job done" : r.disabledReason ?? null,
      };
    });
    return { routines };
  },
});
