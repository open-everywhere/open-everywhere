import { routineWords } from "../routines/schedule-words.js";
import { removeRoutine } from "../routines/store.js";
import { appendAudit } from "../audit/audit.js";
import { emitTelemetry } from "../observability/telemetry.js";
import type { Partition } from "../memory/partition.js";
import { registerActionKind } from "./actions.js";
import type { ActionKind } from "./types.js";

interface RoutineCancelArgs {
  readonly org: string;
  readonly partition: Partition;
  readonly surfaceKey: string;
  readonly id: string;
  readonly description: string;
  readonly requestedBy?: string;
  readonly tainted?: boolean;
}

const routineCancel: ActionKind<RoutineCancelArgs> = {
  kind: "routine.cancel",
  policy: "member",
  plainSummary(args) {
    return `Stop ${routineWords(args.description)} — it will not run again`;
  },
  summarize(args) {
    return [
      `Cancel routine \`${args.id}\` — ${args.description}`,
      ...(args.tainted ? ["⚠ proposed in a turn that read external content — check who actually wanted this stopped before approving"] : []),
      "(reversible: it can be re-created with create_routine)",
    ];
  },
  async execute(args, decidedBy) {
    const cancelled = await removeRoutine(args.partition, args.id);
    await appendAudit({
      org: args.partition.org,
      platform: args.partition.platform,
      workspace: args.partition.workspace,
      surface: args.partition.surface,
      principalId: decidedBy,
      action: "routine.cancel",
      detail: { id: args.id, description: args.description, cancelled, requestedBy: args.requestedBy ?? null, confirmedBy: decidedBy, tainted: Boolean(args.tainted) },
    });
    const outcomeTag = cancelled ? "ok" : "noop";
    emitTelemetry("oe.feature.used", { "oe.feature": "routine_cancelled", "oe.outcome": outcomeTag });
    return cancelled
      ? `${routineWords(args.description)} is stopped`
      : `${routineWords(args.description)} was already gone, so nothing changed`;
  },
};

registerActionKind(routineCancel);
