import { describeFilter, storedFilter } from "./event-model.js";
import { ROUTINE_PERMISSION_PREFIX } from "./permission-key.js";
import type { RoutinePolicyRule } from "./policy.js";
import type { RoutineFollowUp } from "./follow-ups.js";
import type { ModelRole } from "../memory/domain.js";

export type RoutineTrigger =
  | { readonly kind: "cron"; readonly expr: string }
  | { readonly kind: "interval"; readonly everyMinutes: number }
  | { readonly kind: "watch"; readonly everyMinutes?: number; readonly expr?: string }
  | { readonly kind: "once"; readonly at: string }
  | {
      readonly kind: "event";
      readonly source: string;
      readonly jq?: string;
    };

export type RoutineReport =
  | { readonly kind: "silent" }
  | {
      readonly kind: "surface";
      readonly surfaceKey: string;
      readonly target: Readonly<Record<string, unknown>>;
    };

export interface RoutineBound {
  readonly until?: string;
  readonly maxFires?: number;
}

export function reportDestinationOf(r: Routine): Routine {
  const rep = r.report;
  return rep?.kind === "surface" ? { ...r, surfaceKey: rep.surfaceKey, target: rep.target } : r;
}

export function routineReportSurfaceKey(r: Pick<Routine, "surfaceKey" | "report">): string {
  return r.report?.kind === "surface" ? r.report.surfaceKey : r.surfaceKey;
}

export type RoutineStatus = "active" | "disabled" | "done";
export type RunOutcome = "ok" | "failed" | "skipped";

export const JOB_STATE_MAX_BYTES = 16 * 1024;

export const RUN_FAILURE_REASON_MAX_CHARS = 300;

export interface Routine {
  readonly id: string;
  readonly org: string;
  readonly surfaceKey: string;
  readonly target?: Readonly<Record<string, unknown>>;
  readonly trigger: RoutineTrigger;
  readonly report?: RoutineReport;
  readonly prompt: string;
  readonly createdBy?: string;
  readonly createdAt: string;
  readonly taintedAtCreation?: boolean;
  readonly policy?: readonly RoutinePolicyRule[];
  readonly collectors?: readonly string[];
  readonly gate?: string;
  readonly modelRole?: ModelRole;

  status: RoutineStatus;
  disabledReason?: string;
  promptGeneration?: number;
  manualRunAt?: string;
  nextRunAt?: string | null;
  lastRunAt?: string;
  lastOutcome?: RunOutcome;
  lastFailureReason?: string;
  consecutiveFailures: number;
  firstFailureAt?: string;
  lastStateHash?: string;
  followUps?: readonly RoutineFollowUp[];

  firstMatchAt?: string;
  lastMatchAt?: string;

  sessionMode?: "job";
  jobSessionAnchor?: string;
  jobState?: string;
  jobTainted?: boolean;
  prWatch?: { readonly repo: string; readonly number: number; readonly checksRemaining: number };
  bound?: RoutineBound;
  fireCount?: number;
  lastStallAt?: string;
  stalledFires?: number;
  completedAt?: string;
  completedReason?: string;
}

export function isJobRoutine(r: Pick<Routine, "sessionMode">): boolean {
  return r.sessionMode === "job";
}

export function routinePermissionGeneration(r: Pick<Routine, "promptGeneration">): number {
  const g = r.promptGeneration;
  return Number.isInteger(g) && (g as number) > 0 ? (g as number) : 1;
}

export function nextPromptGeneration(r: Pick<Routine, "promptGeneration">): number {
  return routinePermissionGeneration(r) + 1;
}

export { ROUTINE_PERMISSION_PREFIX };

export function routinePermissionKey(r: Pick<Routine, "id" | "promptGeneration">): string {
  return `${ROUTINE_PERMISSION_PREFIX}${r.id}:g${routinePermissionGeneration(r)}`;
}

export function isSilentRoutine(r: Pick<Routine, "report">): boolean {
  return r.report?.kind === "silent";
}

export function assertReportConsistent(
  trigger: RoutineTrigger,
  report: RoutineReport | undefined,
  sessionMode?: "job",
): void {
  if (report?.kind === "silent" && trigger.kind === "watch") {
    throw new Error(
      "A routine can't be both `never` (posts nothing) and only-on-change — a silent watch is just a silent cron. Pick one.",
    );
  }
  if (sessionMode === "job" && trigger.kind === "watch") {
    throw new Error(
      "A durable job can't use only-on-change — a job's fire always gets the job protocol (its own accumulated thread context), which supersedes the watch protocol entirely, so the diff step that would post only on change never runs and the job posts on EVERY fire instead. Drop `job`, or use `every-run` or `never` instead of `only-on-change`.",
    );
  }
}

export function assertKnownSubscription(trigger: RoutineTrigger): void {
  if (trigger.kind !== "event") return;
  const f = storedFilter(trigger);
  if (f.kind !== "unknown") return;
  throw new Error(
    `This event subscription carries a filter shape this build cannot read: ${f.keys.join(", ")}. ` +
      "A subscription filter is a jq expression (`jq`) and has been since OPE-210; the retired `filter` and `match` " +
      "languages were deleted by OPE-1145. Rewrite the filter as jq rather than storing a shape nothing can evaluate — " +
      "a row like this can never fire.",
  );
}

export function isClockScheduled(t: RoutineTrigger): boolean {
  return t.kind === "cron" || t.kind === "interval" || t.kind === "watch" || t.kind === "once";
}

export const ROUTINE_MARKER = {
  id: "open_everywhere_routine_id",
  surface: "open_everywhere_routine_surface",
  org: "open_everywhere_routine_org",
  silent: "open_everywhere_routine_silent",
  manual: "open_everywhere_routine_manual",
  permissionKey: "open_everywhere_routine_grant_key",
  fire: "open_everywhere_routine_fire_id",
  modelRole: "open_everywhere_routine_model_role",
} as const;

type Attrs = Readonly<Record<string, string | readonly string[]>> | undefined;
export function oneAttrValue(v: string | readonly string[] | undefined): string | undefined {
  if (typeof v === "string") return v;
  if (Array.isArray(v) && typeof v[0] === "string") return v[0];
  return undefined;
}

export function routineMarker(attributes: Attrs): { id: string; surfaceKey: string; org: string } | null {
  const id = oneAttrValue(attributes?.[ROUTINE_MARKER.id]);
  const surfaceKey = oneAttrValue(attributes?.[ROUTINE_MARKER.surface]);
  const org = oneAttrValue(attributes?.[ROUTINE_MARKER.org]) ?? "default";
  return id && surfaceKey ? { id, surfaceKey, org } : null;
}

export function routineSilentStamped(attributes: Attrs): boolean {
  return oneAttrValue(attributes?.[ROUTINE_MARKER.silent]) === "true";
}

export const ROUTINE_MODEL_ROLES: readonly ModelRole[] = ["primary", "utility", "supervisor"] as const;

export function isRoutineModelRole(value: unknown): value is ModelRole {
  return typeof value === "string" && (ROUTINE_MODEL_ROLES as readonly string[]).includes(value);
}

export function routineModelRoleStamped(attributes: Attrs): ModelRole | undefined {
  const role = oneAttrValue(attributes?.[ROUTINE_MARKER.modelRole]);
  return isRoutineModelRole(role) ? role : undefined;
}

export function assertKnownModelRole(r: Pick<Routine, "modelRole">): void {
  if (r.modelRole === undefined) return;
  if (isRoutineModelRole(r.modelRole)) return;
  throw new Error(
    `This routine names the model role ${JSON.stringify(r.modelRole)}, which nothing can route. ` +
      `A routine names one of: ${ROUTINE_MODEL_ROLES.join(", ")} — or names none, which inherits the deployment's model stack ` +
      "(routines/routine.ts Routine.modelRole).",
  );
}

export function routinePermissionKeyStamped(attributes: Attrs): string | undefined {
  const key = oneAttrValue(attributes?.[ROUTINE_MARKER.permissionKey]);
  return key !== undefined && key.startsWith(ROUTINE_PERMISSION_PREFIX) ? key : undefined;
}

export function routineManualStamped(attributes: Attrs): boolean {
  return oneAttrValue(attributes?.[ROUTINE_MARKER.manual]) === "true";
}

export function routineFireIdStamped(attributes: Attrs): string | undefined {
  const id = oneAttrValue(attributes?.[ROUTINE_MARKER.fire]);
  return id !== undefined && id.length > 0 ? id : undefined;
}

export function describeTrigger(t: RoutineTrigger, report?: RoutineReport): string {
  const silent = report?.kind === "silent";
  const where = report?.kind === "surface" ? ` → posts into ${report.surfaceKey}` : "";
  return describeTriggerCore(t, silent) + where;
}

function describeTriggerCore(t: RoutineTrigger, silent: boolean): string {
  switch (t.kind) {
    case "cron":
      return `cron "${t.expr}" (UTC; ${silent ? "posts nothing" : "posts every run"})`;
    case "interval":
      return `every ${t.everyMinutes} min (${silent ? "posts nothing" : "posts every run"})`;
    case "watch":
      return t.expr !== undefined
        ? `cron "${t.expr}" (UTC; posts only on change)`
        : `every ${t.everyMinutes} min (posts only on change)`;
    case "once":
      return `once at ${t.at} (fires once, then disables)`;
    case "event":
      return describeFilter(t.source, t);
  }
}
