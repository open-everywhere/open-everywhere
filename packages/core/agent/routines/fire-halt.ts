import { haltScopeFor, resolveHalt, type HaltDeps } from "../access/halt.js";
import { auditRoutineSkip, type RoutineAuditDeps } from "./fire-audit.js";
import { routinePartition } from "./partition.js";
import type { Routine } from "./routine.js";
import type { AuditDetail } from "../audit/scrubbed-text.js";

export async function routineFireHalted(
  r: Routine,
  extra: AuditDetail = {},
  deps: { readonly audit?: RoutineAuditDeps; readonly halt?: HaltDeps } = {},
): Promise<boolean> {
  const p = routinePartition(r);
  const state = await resolveHalt(
    haltScopeFor({
      org: p.org,
      scopeKey: p.surfaceKey,
      ...(r.createdBy ? { principalId: r.createdBy } : {}),
    }),
    deps.halt ?? {},
  );
  if (!state.halted) return false;
  await auditRoutineSkip(r, "halted", extra, deps.audit ?? {}).catch(() => false);
  return true;
}
