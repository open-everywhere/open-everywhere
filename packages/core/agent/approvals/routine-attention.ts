import { routineWords } from "../routines/schedule-words.js";
import { shortUtc } from "./session-grant.js";
import { QUOTE_MAX, plainQuote } from "./plain-text.js";
import { getRoutine, updateRoutine } from "../routines/store.js";
import { computeNextRun } from "../routines/schedule.js";
import { attentionResetPatch, attentionWarnRuns, isPausedForCheckIn, type RoutineAttentionArgs } from "../routines/attention.js";
import { appendAudit } from "../audit/audit.js";
import { registerActionKind, whereFromScope } from "./actions.js";
import type { ActionKind } from "./types.js";

export const ROUTINE_CHECKIN_ACTION = "routine.checkin";

const routineAttention: ActionKind<RoutineAttentionArgs> = {
  kind: "routine.attention",
  policy: "member",
  sessionless: true,
  plainSummary(args) {
    return args.stage === "paused" ? `Resume ${routineWords(args.description)}?` : `Keep ${routineWords(args.description)} running?`;
  },
  consequence(args) {
    return args.stage === "paused"
      ? `I paused it after ${args.runs} runs with no check-in. It won't run until someone presses Resume.`
      : `Nobody has checked in on it for ${args.runs} runs. It pauses after ${args.runsLeft ?? 0} more unless someone presses Keep going.`;
  },
  optionLabels(args) {
    return args.stage === "paused" ? { approve: "Resume", reject: "Leave paused" } : { approve: "Keep going", reject: "Let it pause" };
  },
  doneSummary(args) {
    return args.stage === "paused" ? `resumed ${routineWords(args.description)}` : `kept ${routineWords(args.description)} running`;
  },
  summarize(args) {
    return [
      `${args.stage === "paused" ? "Resume" : "Keep going"} — routine ${args.routineId} (${args.description})`,
      `${args.runs} runs since the last human check-in`,
      ...(args.stage === "warn" ? [`Pauses after ${args.runsLeft ?? 0} more runs with no press`] : []),
      `> ${plainQuote(args.prompt, QUOTE_MAX)}`,
    ];
  },
  async execute(args, decidedBy) {
    const what = routineWords(args.description);
    const live = await getRoutine(args.org, args.surfaceKey, args.routineId);
    if (!live) return `${what} no longer exists, so nothing changed`;
    const where = whereFromScope(args.org, args.surfaceKey);
    if (isPausedForCheckIn(live)) {
      const next = computeNextRun(live.trigger, new Date());
      const updated = await updateRoutine(args.org, args.surfaceKey, args.routineId, {
        status: "active",
        disabledReason: undefined,
        nextRunAt: next ? next.toISOString() : null,
        ...attentionResetPatch(),
      });
      if (!updated) return `${what} no longer exists, so nothing changed`;
      await appendAudit({ ...where, principalId: decidedBy, action: ROUTINE_CHECKIN_ACTION, detail: { id: args.routineId, stage: args.stage, resumed: true, runs: args.runs } });
      return `resumed ${what}${updated.nextRunAt ? `, next run ${shortUtc(updated.nextRunAt)}` : ""}`;
    }
    if (live.status !== "active") return `${what} stopped for another reason, so nothing changed`;
    await updateRoutine(args.org, args.surfaceKey, args.routineId, attentionResetPatch());
    await appendAudit({ ...where, principalId: decidedBy, action: ROUTINE_CHECKIN_ACTION, detail: { id: args.routineId, stage: args.stage, resumed: false, runs: args.runs } });
    const again = attentionWarnRuns();
    return again > 0 ? `kept ${what} running. I'll check again after ${again} more runs` : `kept ${what} running`;
  },
};

registerActionKind(routineAttention);
