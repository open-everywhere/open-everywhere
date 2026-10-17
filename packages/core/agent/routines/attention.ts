import type { RequestApprovalInput } from "../approvals/flow.js";
import { describeTrigger, isClockScheduled, routineReportSurfaceKey, type Routine, type RoutineAttention } from "./routine.js";
import { getSettings } from "../settings/settings.js";

export const ROUTINE_ATTENTION_KIND = "routine.attention";

export type AttentionStage = "warn" | "paused";

export interface RoutineAttentionArgs {
  readonly org: string;
  readonly surfaceKey: string;
  readonly routineId: string;
  readonly stage: AttentionStage;
  readonly description: string;
  readonly prompt: string;
  readonly runs: number;
  readonly runsLeft?: number;
}

export function attentionWarnRuns(): number {
  return getSettings().routines.attentionWarnRuns;
}

export function attentionPauseRuns(): number {
  return getSettings().routines.attentionPauseRuns;
}

export function countsTowardCheckIn(r: Pick<Routine, "trigger">): boolean {
  return isClockScheduled(r.trigger) && r.trigger.kind !== "once";
}

export function attentionRuns(r: Pick<Routine, "attention">): number {
  const n = r.attention?.runs;
  return typeof n === "number" && Number.isInteger(n) && n > 0 ? n : 0;
}

export function attentionCountPatch(r: Pick<Routine, "trigger" | "attention">): Partial<Routine> {
  if (!countsTowardCheckIn(r)) return {};
  return { attention: { ...(r.attention ?? {}), runs: attentionRuns(r) + 1 } };
}

export function attentionResetPatch(): Partial<Routine> {
  return { attention: undefined };
}

export type AttentionStep = { readonly kind: "none" } | { readonly kind: "warn"; readonly runs: number; readonly runsLeft: number } | { readonly kind: "pause"; readonly runs: number };

export function attentionStep(r: Pick<Routine, "trigger" | "attention" | "status">, warn = attentionWarnRuns(), pause = attentionPauseRuns()): AttentionStep {
  if (warn <= 0 || r.status !== "active" || !countsTowardCheckIn(r)) return { kind: "none" };
  const runs = attentionRuns(r);
  const warnedAt = r.attention?.warnedAtRun;
  if (typeof warnedAt === "number") return runs >= warnedAt + pause ? { kind: "pause", runs } : { kind: "none" };
  return runs >= warn ? { kind: "warn", runs, runsLeft: pause } : { kind: "none" };
}

export function attentionPauseReason(runs: number): string {
  return `paused because nobody checked in on it for ${runs} runs`;
}

export function attentionPausePatch(r: Pick<Routine, "attention">, runs: number, now: Date): Partial<Routine> {
  const prior: RoutineAttention = r.attention ?? { runs };
  return { status: "disabled", disabledReason: attentionPauseReason(runs), nextRunAt: null, attention: { ...prior, runs, pausedAt: now.toISOString() } };
}

export function isPausedForCheckIn(r: Pick<Routine, "status" | "attention" | "disabledReason">): boolean {
  return r.status === "disabled" && typeof r.attention?.pausedAt === "string" && (r.disabledReason ?? "").startsWith("paused because nobody checked in");
}

export function attentionCardArgs(r: Routine, stage: AttentionStage, runs: number, runsLeft?: number): RoutineAttentionArgs {
  return {
    org: r.org,
    surfaceKey: r.surfaceKey,
    routineId: r.id,
    stage,
    description: describeTrigger(r.trigger, r.report),
    prompt: r.prompt,
    runs,
    ...(stage === "warn" && runsLeft !== undefined ? { runsLeft } : {}),
  };
}

export const ROUTINE_ATTENTION_HOST_REQUESTER = "oe:routine-check-in";

export function planAttentionCard(
  r: Routine,
  stage: AttentionStage,
  runs: number,
  target: unknown,
  runsLeft?: number,
): (RequestApprovalInput & { readonly platform: string }) | undefined {
  const channelId = readChannelId(target);
  const postedTo = routineReportSurfaceKey(r);
  const platform = postedTo.split("/")[0] ?? "";
  if (channelId === undefined || platform.length === 0) return undefined;
  return {
    platform,
    org: r.org,
    kind: ROUTINE_ATTENTION_KIND,
    args: attentionCardArgs(r, stage, runs, runsLeft),
    scopeKey: r.surfaceKey,
    domain: null,
    requestedBy: r.createdBy && r.createdBy.length > 0 ? r.createdBy : ROUTINE_ATTENTION_HOST_REQUESTER,
    channelId,
    threadTs: null,
    postedTo,
    noClockExpiry: true,
  };
}

function readChannelId(target: unknown): string | undefined {
  if (typeof target !== "object" || target === null) return undefined;
  const id = (target as { channelId?: unknown }).channelId;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}
