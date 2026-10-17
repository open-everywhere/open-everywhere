import { approvalPostDeps, hasApprovalCardPath, requestApproval } from "../approvals/flow.js";
import { attentionPausePatch, attentionStep, isPausedForCheckIn, planAttentionCard, type AttentionStage } from "../routines/attention.js";
import { auditRoutineDisabled } from "../routines/fire-audit.js";
import { getRoutine, updateRoutineIf } from "../routines/store.js";
import type { Routine } from "../routines/routine.js";
import type { RequestApprovalDeps } from "../approvals/flow.js";

function log(msg: string): void {
  console.log(`[open-everywhere:routines] ${msg}`);
}

export interface RoutineAttentionDeps {
  readonly post?: RequestApprovalDeps["post"];
  readonly postCard?: RequestApprovalDeps["postCard"];
}

export type RoutineAttentionOutcome = { readonly kind: "none" } | { readonly kind: "warned" } | { readonly kind: "paused" };

const NONE: RoutineAttentionOutcome = { kind: "none" };

export async function applyRoutineAttention(listed: Routine, now: Date, target: unknown, deps: RoutineAttentionDeps = {}): Promise<RoutineAttentionOutcome> {
  try {
    if (attentionStep(listed).kind === "none") return NONE;
    const r = (await getRoutine(listed.org, listed.surfaceKey, listed.id)) ?? undefined;
    if (r === undefined) return NONE;
    const step = attentionStep(r);
    if (step.kind === "none") return NONE;
    if (step.kind === "warn") {
      const cardId = await postCheckInCard(r, "warn", step.runs, target, deps, step.runsLeft);
      if (cardId === undefined) return NONE;
      const written = await updateRoutineIf(
        r.org,
        r.surfaceKey,
        r.id,
        (live) => live.status === "active" && attentionStep(live).kind === "warn",
        (live) => ({ attention: { ...(live.attention ?? { runs: step.runs }), warnedAtRun: step.runs, cardId } }),
      ).catch(() => null);
      if (written === null || written.kind !== "written") return NONE;
      log(`CHECK-IN: ${r.id} on ${r.surfaceKey} — Keep going card posted after ${step.runs} runs`);
      return { kind: "warned" };
    }
    const guarded = await updateRoutineIf(
      r.org,
      r.surfaceKey,
      r.id,
      (live) => live.status === "active" && attentionStep(live).kind === "pause",
      (live) => attentionPausePatch(live, step.runs, now),
    );
    if (guarded.kind !== "written") return NONE;
    const paused = guarded.routine;
    log(`CHECK-IN: ${r.id} on ${r.surfaceKey} paused — ${paused.disabledReason}`);
    await auditRoutineDisabled(r, paused.disabledReason ?? "", r.consecutiveFailures, undefined, { checkIn: true, runs: step.runs }).catch(() => undefined);
    const cardId = await postCheckInCard(paused, "paused", step.runs, target, deps);
    if (cardId !== undefined) {
      await updateRoutineIf(
        r.org,
        r.surfaceKey,
        r.id,
        (live) => isPausedForCheckIn(live) && live.attention?.pausedAt === paused.attention?.pausedAt,
        (live) => ({ attention: { ...live.attention!, cardId } }),
      ).catch(() => null);
    }
    return { kind: "paused" };
  } catch (err) {
    log(`check-in failed for ${listed.id} on ${listed.surfaceKey}: ${String(err)}`);
    return NONE;
  }
}

async function postCheckInCard(r: Routine, stage: AttentionStage, runs: number, target: unknown, deps: RoutineAttentionDeps, runsLeft?: number): Promise<string | undefined> {
  const plan = planAttentionCard(r, stage, runs, target, runsLeft);
  if (plan === undefined) return undefined;
  const { platform, ...card } = plan;
  if (deps.postCard === undefined && deps.post === undefined && !hasApprovalCardPath(platform)) return undefined;
  try {
    // approval-chain: exempt — `routine.attention` is a NON_TOOL_ACTION_KIND (access/consequence.ts), so
    // approval-authority: headless — the clock dispatcher has no live model turn or wake envelope.
    const posted = await requestApproval(card, {
      ...approvalPostDeps(platform),
      ...(deps.post ? { post: deps.post } : {}),
      ...(deps.postCard ? { postCard: deps.postCard } : {}),
    });
    return posted.id;
  } catch (err) {
    log(`check-in card (${stage}) not posted for ${r.id} on ${r.surfaceKey}: ${String(err)}`);
    return undefined;
  }
}
