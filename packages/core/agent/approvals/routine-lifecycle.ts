import { routineWords } from "../routines/schedule-words.js";
import { shortUtc } from "./session-grant.js";
import { QUOTE_MAX, plainQuote, plainValue } from "./plain-text.js";
import { placeWords } from "../channels/friendly-ids.js";
import { updateRoutine } from "../routines/store.js";
import { mintJobBound } from "../routines/bound.js";
import { stallResetPatch } from "../routines/stall.js";
import { computeNextRun } from "../routines/schedule.js";
import {
  assertKnownSubscription,
  assertReportConsistent,
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

interface RoutineEditArgs {
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
  readonly sessionMode?: "job";
  readonly tainted?: boolean;
  readonly generation: number;
}

const routineEdit: ActionKind<RoutineEditArgs> = {
  kind: "routine.edit",
  policy: "member",
  plainSummary(args) {
    return `Change what ${routineWords(args.description)} does`;
  },
  consequence: (args) => `Now: ${plainQuote(args.prompt, QUOTE_MAX - 60)} — it asks again before anything it was allowed`,
  consequenceQuotes: true,
  summarize(args) {
    return [
      `Rewrite routine ${args.id} — ${args.description} — keeps its schedule, history and run state`,
      "🔑 the standing permissions declared on this routine's creation card are REVOKED by this edit — it starts again from the default gates",
      ...(args.tainted ? ["⚠ proposed in a turn that read external content — read the new text carefully before arming"] : []),
      `Was:\n> ${clip(args.previousPrompt)}`,
      `Now:\n> ${clip(args.prompt)}`,
      `Target: ${placeWords({ key: args.surfaceKey })}`,
    ];
  },
  async execute(args, decidedBy) {
    assertReportConsistent(args.trigger, args.report, args.sessionMode);
    assertKnownSubscription(args.trigger);

    const generation = args.generation + 1;
    const patch: Partial<Routine> = { prompt: args.prompt, promptGeneration: generation };
    const arming = armingApproval();
    const updated = await updateRoutine(args.org, args.surfaceKey, args.id, patch, {
      authoredBy: args.requestedBy,
      armedBy: decidedBy,
      ...(arming ? { approvalId: arming.id } : {}),
    });
    if (!updated) {
      return `${routineWords(args.description)} was stopped before this edit, so nothing changed`;
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
    return `${routineWords(args.description)} now follows the new instruction; it asks again before anything it was allowed before`;
  },
};

interface RoutineEnableArgs {
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
  plainSummary(args) {
    return `Turn ${routineWords(args.description)} back on`;
  },
  consequence: (args) => `It stopped because ${plainValue(args.disabledReason, 120).replace(/[.\s]+$/u, "")}.`,
  summarize(args) {
    return [
      `Re-arm routine ${args.id} — ${args.description} — will fire again WITHOUT a fresh @-mention`,
      args.trigger.kind === "once"
        ? `Stopped because: ${args.disabledReason} (a one-shot routine runs once)`
        : `Stopped because: ${args.disabledReason} (${args.consecutiveFailures} consecutive failures)`,
      "↻ keeps everything it learned — a watch's baseline, a job's progress ledger and thread, its id and history",
      ...(args.bounded ? ["⏹️ its run ceiling starts again from zero — it gets a fresh full allowance, not the remainder of the old one"] : []),
      ...(args.stalled
        ? ["⚠️ it stopped because a session cost checkpoint held its consequential actions and nobody confirmed — answer that card, or raise the checkpoint for this scope, FIRST, or it will stall again"]
        : []),
      `> ${clip(args.prompt)}`,
      `Target: ${placeWords({ key: args.surfaceKey })}`,
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
      return `${routineWords(args.description)} was stopped before this, so nothing changed`;
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
    return `${routineWords(args.description)} is back on${updated.nextRunAt ? `, next run ${shortUtc(updated.nextRunAt)}` : ""}`;
  },
};

registerActionKind(routineEdit);
registerActionKind(routineEnable);
