import { SCM_MINT_JOB_SETS } from "./mint.js";

export { SCM_MINT_JOB_SETS };

export type PermissionGrade = "read" | "write";

export function unionPermissions(sets: readonly object[]): Record<string, PermissionGrade> {
  const out: Record<string, PermissionGrade> = {};
  for (const set of sets) {
    for (const [family, grade] of Object.entries(set) as [string, unknown][]) {
      if (grade !== "read" && grade !== "write") continue;
      if (out[family] !== "write") out[family] = grade;
    }
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

export function scmAppPermissionFloor(): Record<string, PermissionGrade> {
  return unionPermissions(Object.values(SCM_MINT_JOB_SETS));
}
