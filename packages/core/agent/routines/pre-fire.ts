import { auditCollectorFailures } from "./fire-audit.js";
import { collectRoutineInputs, collectionCarriesData, type CollectedInput } from "./collector.js";
import { evaluateRoutineGate, type RoutineGateOutcome } from "./gate.js";
import { routinePermissionKinds } from "./declared-permissions.js";
import type { Routine } from "./routine.js";

export interface PreFireOutcome {
  readonly collected: readonly CollectedInput[];
  readonly gate: RoutineGateOutcome;
  readonly tainted: boolean;
}

const NOTHING: PreFireOutcome = { collected: [], gate: { fire: true, why: "no condition gate declared" }, tainted: false };

export async function runPreFire(r: Routine, nowIso: string): Promise<PreFireOutcome> {
  const names = r.collectors ?? [];
  if (names.length === 0 && r.gate === undefined) return NOTHING;

  const heldKinds = names.length === 0 ? [] : await routinePermissionKinds(r.org, r, nowIso).catch(() => []);
  const collected = await collectRoutineInputs({ org: r.org, routineId: r.id, names, heldKinds });

  await auditCollectorFailures(
    r,
    collected.flatMap((c) => (c.ok ? [] : [{ name: c.name, failure: c.failure, ...(c.detail ? { detail: c.detail } : {}) }])),
  ).catch(() => undefined);

  return { collected, gate: evaluateRoutineGate(r.gate, collected), tainted: collectionCarriesData(collected) };
}
