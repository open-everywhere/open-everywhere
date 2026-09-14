import { SCENARIOS, type Scenario } from "./scenarios.js";

export type LegStatus = "GREEN" | "RED" | "DEFERRED" | "FILTERED";

export interface BoardLeg {
  readonly id: string;
  readonly surface: string;
  readonly status: LegStatus;
  readonly reason?: string;
  readonly evidence?: string;
}

export interface BoardTotals {
  readonly green: number;
  readonly red: number;
  readonly deferred: number;
  readonly filtered: number;
  readonly total: number;
}

export function boardTotals(legs: readonly BoardLeg[]): BoardTotals {
  const count = (s: LegStatus): number => legs.filter((l) => l.status === s).length;
  return { green: count("GREEN"), red: count("RED"), deferred: count("DEFERRED"), filtered: count("FILTERED"), total: legs.length };
}

export function rosterIds(scenarios: readonly Pick<Scenario, "id">[] = SCENARIOS): readonly string[] {
  return scenarios.map((s) => s.id);
}

export function boardGaps(
  legs: readonly BoardLeg[],
  ids: readonly string[] = rosterIds(),
): { readonly missing: readonly string[]; readonly unknown: readonly string[] } {
  const onBoard = new Set(legs.map((l) => l.id));
  const roster = new Set(ids);
  return {
    missing: ids.filter((id) => !onBoard.has(id)),
    unknown: legs.map((l) => l.id).filter((id) => !roster.has(id)),
  };
}

const PIPE = /\|/g;

function cell(text: string | undefined): string {
  return (text ?? "").replace(PIPE, "\\|").replace(/\s+/g, " ").trim();
}

export function renderBoard(legs: readonly BoardLeg[], ids: readonly string[] = rosterIds()): string[] {
  const byId = new Map(legs.map((l) => [l.id, l]));
  const ordered = [...ids.map((id) => byId.get(id)).filter((l): l is BoardLeg => l !== undefined), ...legs.filter((l) => !ids.includes(l.id))];
  const totals = boardTotals(legs);
  const out: string[] = [];
  out.push("## Ship legs");
  out.push("");
  out.push(`${totals.total} legs — ${totals.green} GREEN, ${totals.red} RED, ${totals.deferred} DEFERRED, ${totals.filtered} FILTERED.`);
  out.push("");
  out.push("| Leg | Surface | Status | Evidence / reason |");
  out.push("| --- | --- | --- | --- |");
  for (const leg of ordered) {
    const detail = leg.status === "GREEN" ? cell(leg.evidence) : cell(leg.reason ?? leg.evidence);
    out.push(`| ${cell(leg.id)} | ${cell(leg.surface)} | ${leg.status} | ${detail} |`);
  }
  return out;
}
