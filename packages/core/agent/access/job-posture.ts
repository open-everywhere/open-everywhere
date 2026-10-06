import { JOB_WAKE_TOOLS, withheldFromJobWake } from "./window-gate-manifest.js";
import { classifyConnectorOpTier, isReservedNamespaceTool } from "./consequence.js";

export const JOB_FIRE_ATTR = "oe_job_fire";

export const JOB_TAINT_ATTR = "oe_job_tainted";

type Attrs = Readonly<Record<string, string | readonly string[]>> | undefined;

export function jobFireAttrs(isJobFire: boolean, ledgerTainted = false): Record<string, string> {
  if (!isJobFire) return {};
  return ledgerTainted ? { [JOB_FIRE_ATTR]: "true", [JOB_TAINT_ATTR]: "true" } : { [JOB_FIRE_ATTR]: "true" };
}

export function jobTaintStamped(attributes: Attrs): boolean {
  const v = attributes?.[JOB_TAINT_ATTR];
  const first = typeof v === "string" ? v : Array.isArray(v) ? v[0] : undefined;
  return first === "true";
}

export function jobFireStamped(attributes: Attrs): boolean {
  const v = attributes?.[JOB_FIRE_ATTR];
  const first = typeof v === "string" ? v : Array.isArray(v) ? v[0] : undefined;
  return first === "true";
}

export type JobWakePosture = "restricted" | "unrestricted";

export interface JobWakeSignals {
  readonly jobFire: boolean;
  readonly jobSession: boolean;
  readonly humanPrincipal: boolean;
}

export function resolveJobWakePosture(s: JobWakeSignals): JobWakePosture {
  if (s.jobFire) return "restricted";
  if (!s.jobSession) return "unrestricted";
  return s.humanPrincipal ? "unrestricted" : "restricted";
}

export const HARNESS_INTERNAL_TOOLS: ReadonlySet<string> = new Set(["final_output", "task_wait"]);

export function allowedOnRestrictedJobWake(name: string, jobKit: ReadonlySet<string> = JOB_WAKE_TOOLS): boolean {
  if (jobKit.has(name)) return true;
  if (HARNESS_INTERNAL_TOOLS.has(name)) return true;
  if (isReservedNamespaceTool(name)) return false;
  if (name.includes("__")) return classifyConnectorOpTier(name) === "read";
  return false;
}

export function restrictToolsetForJobWake(toolset: Record<string, unknown>, jobKit: ReadonlySet<string> = JOB_WAKE_TOOLS): string[] {
  const removed: string[] = [];
  for (const name of Object.keys(toolset)) {
    if (allowedOnRestrictedJobWake(name, jobKit)) continue;
    delete toolset[name];
    removed.push(name);
  }
  return removed.sort();
}

function withheldFromRestrictedJobWake(jobKit: ReadonlySet<string> = JOB_WAKE_TOOLS): string[] {
  return withheldFromJobWake(undefined, undefined, jobKit, HARNESS_INTERNAL_TOOLS);
}

export { withheldFromJobWake, withheldFromRestrictedJobWake };
