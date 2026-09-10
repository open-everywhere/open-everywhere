import { auditCollectorFailures } from "./fire-audit.js";
import { COLLECTOR_DETAIL_MAX_CHARS, collectRoutineInputs, collectionCarriesData, describeCollectorFailure, type CollectedInput } from "./collector.js";
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

  let collected: readonly CollectedInput[];
  let collectionError: string | undefined;
  try {
    const heldKinds = names.length === 0 ? [] : await routinePermissionKinds(r.org, r, nowIso).catch(() => []);
    collected = await collectRoutineInputs({ org: r.org, routineId: r.id, names, heldKinds });
  } catch (err) {
    collectionError = String(err);
    collected = collectionFailed(names, collectionError);
  }

  await auditCollectorFailures(
    r,
    collected.flatMap((c) => (c.ok ? [] : [{ name: c.name, failure: c.failure, ...(c.detail ? { detail: c.detail } : {}) }])),
  ).catch(() => undefined);

  if (collectionError !== undefined && r.gate !== undefined) {
    return {
      collected,
      gate: { fire: false, gate: r.gate, why: `the pre-fire collection failed — failing closed: ${collectionError}` },
      tainted: false,
    };
  }

  return { collected, gate: evaluateRoutineGate(r.gate, collected), tainted: collectionCarriesData(collected) };
}

function collectionFailed(names: readonly string[], error: string): readonly CollectedInput[] {
  return names.map((name) => ({
    name,
    ok: false as const,
    failure: describeCollectorFailure("collection_failed"),
    detail: error.slice(0, COLLECTOR_DETAIL_MAX_CHARS),
  }));
}

export function preFireFallback(r: Routine, err: unknown): PreFireOutcome {
  return {
    collected: collectionFailed(r.collectors ?? [], String(err)),
    gate: { fire: r.gate === undefined, gate: r.gate, why: `the pre-fire step failed — failing closed: ${String(err)}` },
    tainted: false,
  };
}
