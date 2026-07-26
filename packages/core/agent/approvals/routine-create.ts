import { addRoutine, newRoutineId } from "../routines/store.js";
import { computeNextRun } from "../routines/schedule.js";
import { describeTrigger, routineGrantGeneration, type Routine, type RoutineReport, type RoutineTrigger } from "../routines/routine.js";
import { describeDeclaredPermissions, grantDeclaredRoutinePermissions } from "../routines/grants.js";
import { describeGrantKind } from "./session-grant.js";
import { appendAudit } from "../audit/audit.js";
import type { Partition } from "../memory/partition.js";
import { registerActionKind } from "./actions.js";
import type { ActionKind } from "./types.js";

export interface RoutineCreateArgs {
  readonly org: string;
  readonly partition: Partition;
  readonly surfaceKey: string;
  readonly target: unknown;
  readonly trigger: RoutineTrigger;
  readonly report?: RoutineReport;
  readonly prompt: string;
  readonly createdBy?: string;
  readonly tainted?: boolean;
  readonly sessionMode?: "job";
  readonly permissions?: readonly string[];
}

export function permissionLines(args: Pick<RoutineCreateArgs, "permissions" | "tainted">): string[] {
  const described = describeDeclaredPermissions(args.permissions ?? []);
  if (described.length === 0) return [];
  if (args.tainted) {
    return [`🔑 asked for standing permission to ${described.join(" · ")} — NOT granted, because it was authored in a turn that read external content; it will ask a human every time`];
  }
  return [`🔑 may, without asking: ${described.join(" · ")} — anything else will ask you first`];
}

const routineCreate: ActionKind<RoutineCreateArgs> = {
  kind: "routine.create",
  policy: "member",
  summarize(args) {
    return [
      `Create ${args.sessionMode === "job" ? "durable JOB" : "routine"} — ${describeTrigger(args.trigger, args.report)} — fires WITHOUT a fresh @-mention`,
      ...(args.report?.kind === "silent" ? ["🔇 reports NOTHING here — you will only hear from it if it hits a problem it can't resolve, or if it self-disables"] : []),
      ...(args.sessionMode === "job" ? ["↻ keeps ONE persistent session across fires (accumulates context) until it calls complete_job"] : []),
      ...(args.tainted ? ["⚠ authored in a turn that read external content — review before arming"] : []),
      ...permissionLines(args),
      `> ${args.prompt}`,
      `Target: ${args.surfaceKey}`,
    ];
  },
  async execute(args, decidedBy) {
    const now = new Date();
    const next = args.trigger.kind === "once" ? new Date(args.trigger.at) : computeNextRun(args.trigger, now);
    const routine: Routine = {
      id: newRoutineId(),
      org: args.org,
      surfaceKey: args.surfaceKey,
      target: args.target as Routine["target"],
      trigger: args.trigger,
      ...(args.report ? { report: args.report } : {}),
      prompt: args.prompt,
      createdBy: args.createdBy,
      createdAt: now.toISOString(),
      status: "active",
      nextRunAt: next ? next.toISOString() : null,
      consecutiveFailures: 0,
      ...(args.tainted ? { taintedAtCreation: true } : {}),
      ...(args.sessionMode === "job" ? { sessionMode: "job" as const } : {}),
    };
    await addRoutine(args.partition, routine);
    const granted = await grantDeclaredRoutinePermissions({
      org: args.org,
      routine,
      declared: args.permissions ?? [],
      grantedBy: decidedBy,
      tainted: Boolean(args.tainted),
      nowIso: now.toISOString(),
    });
    if (granted.length > 0) {
      await appendAudit({
        org: args.partition.org,
        platform: args.partition.platform,
        workspace: args.partition.workspace,
        surface: args.partition.surface,
        principalId: decidedBy,
        action: "routine.grant",
        detail: { id: routine.id, grantedBy: decidedBy, kinds: granted, generation: routineGrantGeneration(routine), declared: true },
      });
    }
    await appendAudit({
      org: args.partition.org,
      platform: args.partition.platform,
      workspace: args.partition.workspace,
      surface: args.partition.surface,
      principalId: decidedBy,
      action: "routine.create",
      detail: { id: routine.id, trigger: describeTrigger(args.trigger, args.report), nextRunAt: routine.nextRunAt, armedBy: decidedBy, tainted: Boolean(args.tainted), ...(args.sessionMode === "job" ? { sessionMode: "job" } : {}), ...(args.report ? { report: args.report.kind } : {}) },
    });
    return (
      `routine ${routine.id} armed — ${describeTrigger(args.trigger, args.report)}${routine.nextRunAt ? ` (first run ${routine.nextRunAt})` : ""}` +
      `${granted.length > 0 ? `; standing permission to ${granted.map(describeGrantKind).join(" · ")} (revoke with revoke_routine_permissions)` : ""}.`
    );
  },
};

registerActionKind(routineCreate);
