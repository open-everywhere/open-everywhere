import { updateRoutine } from "../routines/store.js";
import { mintJobBound } from "../routines/bound.js";
import { stallResetPatch } from "../routines/stall.js";
import { computeNextRun } from "../routines/schedule.js";
import {
  assertReportConsistent,
  describeTrigger,
  isJobRoutine,
  nextPromptGeneration,
  type Routine,
  type RoutineReport,
  type RoutineTrigger,
} from "../routines/routine.js";
import { appendAudit } from "../audit/audit.js";
import type { Partition } from "../memory/partition.js";
import { armingApproval } from "./arming-context.js";
import { registerActionKind } from "./actions.js";
import type { ActionKind } from "./types.js";

const CARD_PROMPT_CHARS = 600;

function clip(s: string): string {
  const t = s.trim().replace(/\s+/g, " ");
  return t.length > CARD_PROMPT_CHARS ? `${t.slice(0, CARD_PROMPT_CHARS)}…` : t;
}

export interface RoutineEditArgs {
  readonly org: string;
  readonly partition: Partition;
  readonly surfaceKey: string;
  readonly id: string;
  readonly prompt: string;
  readonly previousPrompt: string;
  readonly description: string;
  readonly requestedBy: string;
  readonly trigger: RoutineTrigger;
  readonly report?: RoutineReport;
  readonly tainted?: boolean;
  readonly generation: number;
}

const routineEdit: ActionKind<RoutineEditArgs> = {
  kind: "routine.edit",
  policy: "member",
  summarize(args) {
    return [
      `Rewrite routine ${args.id} — ${args.description} — keeps its schedule, history and run state`,
      "🔑 any standing approvals this routine has accumulated are REVOKED by this edit — it starts again from the default gates",
      ...(args.tainted ? ["⚠ proposed in a turn that read external content — read the new text carefully before arming"] : []),
      `Was:\n> ${clip(args.previousPrompt)}`,
      `Now:\n> ${clip(args.prompt)}`,
      `Target: ${args.surfaceKey}`,
    ];
  },
  async execute(args, decidedBy) {
    assertReportConsistent(args.trigger, args.report);

    const generation = args.generation + 1;
    const patch: Partial<Routine> = { prompt: args.prompt, promptGeneration: generation };
    const arming = armingApproval();
    const updated = await updateRoutine(args.org, args.surfaceKey, args.id, patch, {
      authoredBy: args.requestedBy,
      armedBy: decidedBy,
      ...(arming ? { approvalId: arming.id } : {}),
    });
    if (!updated) {
      return `routine ${args.id} is gone — it was cancelled before this edit was confirmed, so nothing changed.`;
    }
    await appendAudit({
      org: args.partition.org,
      platform: args.partition.platform,
      workspace: args.partition.workspace,
      surface: args.partition.surface,
      principalId: decidedBy,
      action: "routine.edit",
      detail: {
        id: args.id,
        editedBy: decidedBy,
        requestedBy: args.requestedBy,
        promptGeneration: generation,
        previousPromptChars: args.previousPrompt.length,
        promptChars: args.prompt.length,
        tainted: Boolean(args.tainted),
        grantsInvalidated: true,
        ...(isJobRoutine(updated) ? { jobSeatRotated: true } : {}),
      },
    });
    return (
      `routine ${args.id} updated — schedule (${args.description}), history and run state kept. ` +
      `Any standing approvals it had are revoked (generation ${generation})` +
      `${isJobRoutine(updated) ? "; the job resumes on a fresh session from its saved progress ledger" : ""}.`
    );
  },
};

export interface RoutineEnableArgs {
  readonly org: string;
  readonly partition: Partition;
  readonly surfaceKey: string;
  readonly id: string;
  readonly description: string;
  readonly disabledReason: string;
  readonly consecutiveFailures: number;
  readonly prompt: string;
  readonly trigger: RoutineTrigger;
  readonly requestedBy: string;
  readonly bounded?: boolean;
  readonly stalled?: boolean;
}

const routineEnable: ActionKind<RoutineEnableArgs> = {
  kind: "routine.enable",
  policy: "member",
  summarize(args) {
    return [
      `Re-arm routine ${args.id} — ${args.description} — will fire again WITHOUT a fresh @-mention`,
      `Stopped because: ${args.disabledReason} (${args.consecutiveFailures} consecutive failures)`,
      "↻ keeps everything it learned — a watch's baseline, a job's progress ledger and thread, its id and history",
      ...(args.bounded ? ["⏹️ its run ceiling starts again from zero — it gets a fresh full allowance, not the remainder of the old one"] : []),
      ...(args.stalled
        ? ["⚠️ it stopped because a session cost checkpoint held its consequential actions and nobody confirmed — answer that card, or raise the checkpoint for this scope, FIRST, or it will stall again"]
        : []),
      `> ${clip(args.prompt)}`,
      `Target: ${args.surfaceKey}`,
    ];
  },
  async execute(args, decidedBy) {
    const now = new Date();
    const next = computeNextRun(args.trigger, now);
    const updated = await updateRoutine(args.org, args.surfaceKey, args.id, {
      status: "active",
      disabledReason: undefined,
      consecutiveFailures: 0,
      nextRunAt: next ? next.toISOString() : null,
      ...(args.bounded ? { bound: mintJobBound(args.trigger, now), fireCount: 0 } : {}),
      ...stallResetPatch(),
    });
    if (!updated) {
      return `routine ${args.id} is gone — it was cancelled before this re-arm was confirmed, so nothing changed.`;
    }
    await appendAudit({
      org: args.partition.org,
      platform: args.partition.platform,
      workspace: args.partition.workspace,
      surface: args.partition.surface,
      principalId: decidedBy,
      action: "routine.enable",
      detail: {
        id: args.id,
        armedBy: decidedBy,
        requestedBy: args.requestedBy,
        previousDisabledReason: args.disabledReason,
        clearedFailures: args.consecutiveFailures,
        nextRunAt: updated.nextRunAt ?? null,
      },
    });
    return `routine ${args.id} re-armed — ${describeTrigger(updated.trigger, updated.report)}${updated.nextRunAt ? ` (next run ${updated.nextRunAt})` : ""}. Its history and run state were kept.`;
  },
};

registerActionKind(routineEdit);
registerActionKind(routineEnable);
