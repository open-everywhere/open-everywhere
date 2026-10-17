import { approvalPostDeps, hasApprovalCardPath, requestApproval } from "../approvals/flow.js";
import { attentionPausePatch, attentionStep, isPausedForCheckIn, planAttentionCard, type AttentionStage } from "../routines/attention.js";
import { auditRoutineDisabled } from "../routines/fire-audit.js";
import { getRoutine, updateRoutine } from "../routines/store.js";
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
      const live = await getRoutine(r.org, r.surfaceKey, r.id).catch(() => null);
      if (live === null || live.status !== "active" || attentionStep(live).kind !== "warn") return NONE;
      const written = await updateRoutine(r.org, r.surfaceKey, r.id, { attention: { ...(live.attention ?? { runs: step.runs }), warnedAtRun: step.runs, cardId } }).catch(() => null);
      if (written === null) return NONE;
      log(`CHECK-IN: ${r.id} on ${r.surfaceKey} — Keep going card posted after ${step.runs} runs`);
      return { kind: "warned" };
    }
    const patch = attentionPausePatch(r, step.runs, now);
    const paused = await updateRoutine(r.org, r.surfaceKey, r.id, patch);
    if (!paused) return NONE;
    log(`CHECK-IN: ${r.id} on ${r.surfaceKey} paused — ${patch.disabledReason}`);
    await auditRoutineDisabled(r, patch.disabledReason ?? "", r.consecutiveFailures, undefined, { checkIn: true, runs: step.runs }).catch(() => undefined);
    const cardId = await postCheckInCard(paused, "paused", step.runs, target, deps);
    if (cardId !== undefined) {
      const live = await getRoutine(r.org, r.surfaceKey, r.id).catch(() => null);
      if (live !== null && isPausedForCheckIn(live) && live.attention?.pausedAt === patch.attention?.pausedAt) {
        await updateRoutine(r.org, r.surfaceKey, r.id, { attention: { ...live.attention!, cardId } }).catch(() => null);
      }
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
