import { defineState } from "eve/context";

export interface DurableMemoryWrite {
  readonly kind: "memory" | "operational";
  readonly road: string;
  readonly silo?: string;
  readonly version: string;
}

interface WriteEvidenceState {
  readonly turn?: string;
  readonly writes?: readonly DurableMemoryWrite[];
}

const slot = defineState<WriteEvidenceState>("open-everywhere.memory-write-evidence", () => ({}));

const MAX_WRITES = 32;

function readState(v: unknown): WriteEvidenceState {
  if (v === null || typeof v !== "object") return {};
  const s = v as { turn?: unknown; writes?: unknown };
  if (typeof s.turn !== "string" || s.turn.length === 0) return {};
  const writes = Array.isArray(s.writes)
    ? s.writes.flatMap((w): DurableMemoryWrite[] => {
        if (typeof w !== "object" || w === null) return [];
        const raw = w as { kind?: unknown; road?: unknown; silo?: unknown; version?: unknown };
        if (raw.kind !== "memory" && raw.kind !== "operational") return [];
        if (typeof raw.road !== "string" || raw.road.length === 0) return [];
        if (typeof raw.version !== "string" || raw.version.length === 0) return [];
        return [
          {
            kind: raw.kind,
            road: raw.road,
            ...(typeof raw.silo === "string" && raw.silo.length > 0 ? { silo: raw.silo } : {}),
            version: raw.version,
          },
        ];
      })
    : [];
  return { turn: s.turn, writes };
}

export function noteDurableMemoryWrite(turnId: string | undefined, write: DurableMemoryWrite): void {
  if (turnId === undefined || turnId.length === 0) return;
  const same = (a: DurableMemoryWrite, b: DurableMemoryWrite): boolean =>
    a.kind === b.kind && a.road === b.road && a.silo === b.silo && a.version === b.version;
  try {
    slot.update((cur) => {
      const state = readState(cur);
      if (state.turn !== turnId) return { turn: turnId, writes: [write] };
      const writes = state.writes ?? [];
      if (writes.length >= MAX_WRITES || writes.some((w) => same(w, write))) return state;
      return { turn: turnId, writes: [...writes, write] };
    });
  } catch {
  }
}

function durableMemoryWritesThisTurn(turnId: string | undefined): readonly DurableMemoryWrite[] {
  if (turnId === undefined || turnId.length === 0) return [];
  let state: WriteEvidenceState;
  try {
    state = readState(slot.get());
  } catch {
    return [];
  }
  if (state.turn !== turnId) return [];
  return state.writes ?? [];
}

export const OE_WORK_RESULT_WRITES_ATTR = "oe_work_result_writes";

export function factWritesThisTurn(turnId: string | undefined): readonly DurableMemoryWrite[] {
  return durableMemoryWritesThisTurn(turnId).filter((w) => w.kind === "memory");
}

export function encodeCarriedWrites(writes: readonly DurableMemoryWrite[]): string | undefined {
  const facts = writes.filter((w) => w.kind === "memory").slice(0, MAX_WRITES);
  return facts.length === 0 ? undefined : JSON.stringify(facts.map((w) => ({ road: w.road, ...(w.silo !== undefined ? { silo: w.silo } : {}), version: w.version })));
}

export function adoptCarriedWrites(turnId: string | undefined, raw: unknown): number {
  if (typeof raw !== "string" || raw.length === 0) return 0;
  let list: unknown;
  try {
    list = JSON.parse(raw);
  } catch {
    return 0;
  }
  if (!Array.isArray(list)) return 0;
  let n = 0;
  for (const w of list.slice(0, MAX_WRITES)) {
    if (typeof w !== "object" || w === null) continue;
    const e = w as { road?: unknown; silo?: unknown; version?: unknown };
    if (typeof e.road !== "string" || e.road.length === 0 || typeof e.version !== "string" || e.version.length === 0) continue;
    noteDurableMemoryWrite(turnId, { kind: "memory", road: `work-session:${e.road}`, ...(typeof e.silo === "string" && e.silo.length > 0 ? { silo: e.silo } : {}), version: e.version });
    n++;
  }
  return n;
}

export function factStoredThisTurn(turnId: string | undefined): boolean {
  return durableMemoryWritesThisTurn(turnId).some((w) => w.kind === "memory");
}
