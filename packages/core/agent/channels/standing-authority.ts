import { defineState } from "eve/context";

export interface StandingWriteGrant {
  readonly host: string;
  readonly credential: string;
  readonly verb: readonly string[] | "any";
}

export interface GatedConnectorWrite {
  readonly connection: string;
  readonly op: string;
  readonly tier: "write" | "destructive";
}

interface StandingAuthorityState {
  readonly grants?: readonly StandingWriteGrant[];
  readonly turn?: string;
  readonly writes?: readonly GatedConnectorWrite[];
}

const slot = defineState<StandingAuthorityState>("open-everywhere.standing-authority", () => ({}));

const MAX_GRANTS = 20;
const MAX_WRITES = 32;

function readGrant(v: unknown): StandingWriteGrant[] {
  if (typeof v !== "object" || v === null) return [];
  const raw = v as { host?: unknown; credential?: unknown; verb?: unknown };
  if (typeof raw.host !== "string" || raw.host.length === 0) return [];
  if (typeof raw.credential !== "string" || raw.credential.length === 0) return [];
  const verb =
    raw.verb === "any"
      ? ("any" as const)
      : Array.isArray(raw.verb)
        ? raw.verb.filter((m): m is string => typeof m === "string" && m.length > 0)
        : undefined;
  if (verb === undefined) return [];
  return [{ host: raw.host, credential: raw.credential, verb }];
}

function readWrite(v: unknown): GatedConnectorWrite[] {
  if (typeof v !== "object" || v === null) return [];
  const raw = v as { connection?: unknown; op?: unknown; tier?: unknown };
  if (typeof raw.connection !== "string" || raw.connection.length === 0) return [];
  if (typeof raw.op !== "string" || raw.op.length === 0) return [];
  if (raw.tier !== "write" && raw.tier !== "destructive") return [];
  return [{ connection: raw.connection, op: raw.op, tier: raw.tier }];
}

function readState(v: unknown): StandingAuthorityState {
  if (typeof v !== "object" || v === null) return {};
  const s = v as { grants?: unknown; turn?: unknown; writes?: unknown };
  const grants = Array.isArray(s.grants) ? s.grants.flatMap(readGrant) : [];
  const turn = typeof s.turn === "string" && s.turn.length > 0 ? s.turn : undefined;
  const writes = turn === undefined || !Array.isArray(s.writes) ? [] : s.writes.flatMap(readWrite);
  return { grants, ...(turn === undefined ? {} : { turn }), writes };
}

export function noteStandingWriteGrants(hosts: readonly { host: string; credential: string | null; verb: readonly string[] | "any" }[]): void {
  const grants = hosts
    .flatMap((h) => (h.credential === null ? [] : [{ host: h.host, credential: h.credential, verb: h.verb }]))
    .slice(0, MAX_GRANTS);
  try {
    slot.update((cur) => ({ ...readState(cur), grants }));
  } catch {
  }
}

export function noteGatedConnectorWrite(turnId: string | undefined, write: GatedConnectorWrite): void {
  if (turnId === undefined || turnId.length === 0) return;
  const same = (a: GatedConnectorWrite, b: GatedConnectorWrite): boolean =>
    a.connection === b.connection && a.op === b.op && a.tier === b.tier;
  try {
    slot.update((cur) => {
      const state = readState(cur);
      const writes = state.turn === turnId ? (state.writes ?? []) : [];
      if (writes.length >= MAX_WRITES || writes.some((w) => same(w, write))) {
        return { ...state, turn: turnId, writes };
      }
      return { ...state, turn: turnId, writes: [...writes, write] };
    });
  } catch {
  }
}

export function standingWriteGrantsInForce(): readonly StandingWriteGrant[] {
  try {
    return readState(slot.get()).grants ?? [];
  } catch {
    return [];
  }
}

export function gatedConnectorWritesThisTurn(turnId: string | undefined): readonly GatedConnectorWrite[] {
  if (turnId === undefined || turnId.length === 0) return [];
  let state: StandingAuthorityState;
  try {
    state = readState(slot.get());
  } catch {
    return [];
  }
  if (state.turn !== turnId) return [];
  return state.writes ?? [];
}

export function describeStandingWriteGrant(grant: StandingWriteGrant): string {
  if (grant.host === "*") return "any service";
  return grant.host.replace(/^\*\./, "");
}
