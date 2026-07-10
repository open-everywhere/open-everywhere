import { addRoutine, newRoutineId } from "../routines/store.js";
import { computeNextRun } from "../routines/schedule.js";
import { describeTrigger, type Routine, type RoutineTrigger } from "../routines/routine.js";
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
  readonly prompt: string;
  readonly createdBy?: string;
  readonly tainted?: boolean;
}

const routineCreate: ActionKind<RoutineCreateArgs> = {
  kind: "routine.create",
  policy: "member",
  summarize(args) {
    return [
      `Create routine — ${describeTrigger(args.trigger)} — fires WITHOUT a fresh @-mention`,
      ...(args.tainted ? ["⚠ authored in a turn that read external content — review before arming"] : []),
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
      prompt: args.prompt,
      createdBy: args.createdBy,
      createdAt: now.toISOString(),
      status: "active",
      nextRunAt: next ? next.toISOString() : null,
      consecutiveFailures: 0,
    };
    await addRoutine(args.partition, routine);
    await appendAudit({
      org: args.partition.org,
      platform: args.partition.platform,
      workspace: args.partition.workspace,
      surface: args.partition.surface,
      principalId: decidedBy,
      action: "routine.create",
      detail: { id: routine.id, trigger: describeTrigger(args.trigger), nextRunAt: routine.nextRunAt, armedBy: decidedBy, tainted: Boolean(args.tainted) },
    });
    return `routine ${routine.id} armed — ${describeTrigger(args.trigger)}${routine.nextRunAt ? ` (first run ${routine.nextRunAt})` : ""}.`;
  },
};

registerActionKind(routineCreate);
