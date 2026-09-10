import type { CollectedInput } from "./collector.js";

export interface RoutineGateVerdict {
  readonly fire: boolean;
  readonly why: string;
}

export interface RoutineGateDef {
  readonly name: string;
  readonly describe: string;
  readonly decide: (collected: readonly CollectedInput[]) => RoutineGateVerdict;
}

const GATE_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;

let REGISTERED: ReadonlyMap<string, RoutineGateDef> = new Map();

export function assertGateDeclarable(def: RoutineGateDef): void {
  if (!GATE_NAME.test(def.name)) {
    throw new Error(`Routine gate name "${def.name}" is not usable: use lowercase letters, digits, ".", "-" or "_", 1–64 characters.`);
  }
  if (def.describe.trim().length === 0) {
    throw new Error(`Routine gate "${def.name}" needs a one-line \`describe\` — it is what a human reads on the routine's card.`);
  }
}

export function registerRoutineGates(defs: readonly RoutineGateDef[]): void {
  const next = new Map<string, RoutineGateDef>();
  for (const def of defs) {
    assertGateDeclarable(def);
    if (next.has(def.name)) throw new Error(`Routine gate "${def.name}" is declared twice — one name, one predicate.`);
    next.set(def.name, def);
  }
  REGISTERED = next;
}

export function resolveRoutineGate(name: string): RoutineGateDef | undefined {
  return REGISTERED.get(name);
}

export function listRoutineGates(): readonly RoutineGateDef[] {
  return [...REGISTERED.values()];
}

export function validateRoutineGate(name: string | undefined, collectors: readonly string[] = []): string | undefined {
  const trimmed = name?.trim();
  if (trimmed === undefined || trimmed.length === 0) return undefined;
  if (collectors.length === 0) {
    throw new Error(
      `"${trimmed}" is a condition gate, and a gate decides from the run's PRE-RUN COLLECTION — so this routine has to name at least one collector as well. Add one, or drop the gate.`,
    );
  }
  if (!resolveRoutineGate(trimmed)) {
    const menu = listRoutineGates();
    throw new Error(
      `"${trimmed}" is not a condition gate this deployment declares. ` +
        (menu.length === 0
          ? "This deployment declares none at all, so a routine cannot name one — leave `gate` out."
          : `The declared gates are: ${menu.map((d) => `"${d.name}" (${d.describe})`).join(", ")}.`),
    );
  }
  return trimmed;
}

export function collectedBody(collected: readonly CollectedInput[], name: string): string | undefined {
  const hit = collected.find((c) => c.name === name);
  return hit?.ok ? hit.body : undefined;
}

export function collectionComplete(collected: readonly CollectedInput[]): boolean {
  return collected.every((c) => c.ok);
}

export interface RoutineGateOutcome extends RoutineGateVerdict {
  readonly gate?: string;
}

export function evaluateRoutineGate(name: string | undefined, collected: readonly CollectedInput[]): RoutineGateOutcome {
  if (name === undefined) return { fire: true, why: "no condition gate declared" };
  const def = resolveRoutineGate(name);
  if (!def) {
    return { fire: false, gate: name, why: `this deployment declares no condition gate named "${name}" — failing closed` };
  }
  let verdict: RoutineGateVerdict;
  try {
    verdict = def.decide(collected);
  } catch (err) {
    return { fire: false, gate: name, why: `the condition gate threw — failing closed: ${String(err)}` };
  }
  if (typeof verdict?.fire !== "boolean" || typeof verdict?.why !== "string" || verdict.why.length === 0) {
    return { fire: false, gate: name, why: "the condition gate returned no usable verdict — failing closed" };
  }
  return { fire: verdict.fire, gate: name, why: verdict.why };
}

export const GATE_WAIT_MS = 24 * 60 * 60_000;

export function gatedOnceExhausted(scheduledAt: string | undefined, now: Date): boolean {
  if (scheduledAt === undefined) return false;
  const at = Date.parse(scheduledAt);
  if (!Number.isFinite(at)) return false;
  return now.getTime() - at > GATE_WAIT_MS;
}

export function gateWaitExpiredReason(gate: string | undefined): string {
  return `the condition gate${gate ? ` "${gate}"` : ""} never held within ${GATE_WAIT_MS / 3_600_000} hours`;
}
