import { addRoutine, newRoutineId } from "../routines/store.js";
import { computeNextRun } from "../routines/schedule.js";
import { describeTrigger, routinePermissionGeneration, type Routine, type RoutineReport, type RoutineTrigger } from "../routines/routine.js";
import { mintJobBound } from "../routines/bound.js";
import {
  ROUTINE_PERMISSIONS_ARMED_ACTION,
  ROUTINE_PERMISSION_NEVER_LIFTS_ACTION,
  bundleRaisedDeclarations,
  describeDeclaredPermissions,
  armDeclaredRoutinePermissions,
  unarmedDeclarations,
} from "../routines/declared-permissions.js";
import { describeDeclaredPermissionKind } from "./session-grant.js";
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
  readonly boundPolicy?: string;
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
      ...(args.report?.kind === "surface" ? [`📤 posts into ${args.report.surfaceKey} — this surface can't post proactively, so its domain's configured reportChannel is where every run will land`] : []),
      ...(args.sessionMode === "job"
        ? ["↻ keeps going until it decides the work is DONE, building on what each earlier run learned — where an ordinary routine starts fresh each time and repeats forever. Arm a job only for work that can actually finish."]
        : []),
      ...(args.sessionMode === "job" && args.boundPolicy ? [`⏹️ ${args.boundPolicy} — it will say so here, and you can start it again`] : []),
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
      ...(args.sessionMode === "job" ? { bound: mintJobBound(args.trigger, now), fireCount: 0 } : {}),
    };
    await addRoutine(args.partition, routine);
    const armed = await armDeclaredRoutinePermissions({
      org: args.org,
      routine,
      declared: args.permissions ?? [],
      grantedBy: decidedBy,
      tainted: Boolean(args.tainted),
      nowIso: now.toISOString(),
    });
    if (armed.length > 0) {
      await appendAudit({
        org: args.partition.org,
        platform: args.partition.platform,
        workspace: args.partition.workspace,
        surface: args.partition.surface,
        principalId: decidedBy,
        action: ROUTINE_PERMISSIONS_ARMED_ACTION,
        detail: { id: routine.id, grantedBy: decidedBy, kinds: armed, generation: routinePermissionGeneration(routine), declared: true },
      });
    }
    for (const declaration of args.tainted ? [] : bundleRaisedDeclarations(args.permissions ?? [])) {
      await appendAudit({
        org: args.partition.org,
        platform: args.partition.platform,
        workspace: args.partition.workspace,
        surface: args.partition.surface,
        principalId: decidedBy,
        action: ROUTINE_PERMISSION_NEVER_LIFTS_ACTION,
        detail: { id: routine.id, declaration, generation: routinePermissionGeneration(routine), reason: "bundle-declared-destructive" },
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
    const unarmed = unarmedDeclarations(args.permissions ?? [], armed);
    return (
      `routine ${routine.id} armed — ${describeTrigger(args.trigger, args.report)}${routine.nextRunAt ? ` (first run ${routine.nextRunAt})` : ""}` +
      `${armed.length > 0 ? `; standing permission to ${armed.map(describeDeclaredPermissionKind).join(" · ")} (revoke with revoke_routine_permissions)` : ""}` +
      `${unarmed.length > 0 ? `; NOT armed: ${unarmed.map((d) => `"${d}"`).join(" · ")} — the routine asks a person when it reaches that step${args.tainted ? " (nothing was made standing: this routine was authored in a turn that read external content)" : ""}` : ""}.`
    );
  },
};

registerActionKind(routineCreate);
