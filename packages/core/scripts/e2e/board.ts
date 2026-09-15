import { SCENARIOS, type Scenario } from "./scenarios.js";

export type LegStatus = "GREEN" | "RED" | "DEFERRED" | "FILTERED" | "GAP";

export const LAUNCH_SURFACES: readonly string[] = ["slack", "notion", "github"];

export const DECLARED_GAP_SURFACES: readonly string[] = ["discord", "teams"];

export function isDeclaredGap(surface: string, reason: string | undefined): boolean {
  return DECLARED_GAP_SURFACES.includes(surface) && (reason ?? "").trim().length > 0;
}

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
  readonly gap: number;
  readonly total: number;
}

export function boardTotals(legs: readonly BoardLeg[]): BoardTotals {
  const count = (s: LegStatus): number => legs.filter((l) => l.status === s).length;
  return {
    green: count("GREEN"),
    red: count("RED"),
    deferred: count("DEFERRED"),
    filtered: count("FILTERED"),
    gap: count("GAP"),
    total: legs.length,
  };
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
  const scored = totals.total - totals.gap;
  out.push(`${scored} legs scored — ${totals.green} GREEN, ${totals.red} RED, ${totals.deferred} DEFERRED, ${totals.filtered} FILTERED.`);
  if (totals.gap > 0) {
    const gapIds = legs.filter((l) => l.status === "GAP").map((l) => `${l.id} (${l.surface})`);
    out.push(
      `${totals.gap} DECLARED GAP(S) on ${DECLARED_GAP_SURFACES.join(" / ")}, outside the ${LAUNCH_SURFACES.join(" / ")} launch set — ` +
        `each names the fixture it waits on: ${gapIds.join(", ")}.`,
    );
  }
  out.push("");
  out.push("| Leg | Surface | Status | Evidence / reason |");
  out.push("| --- | --- | --- | --- |");
  for (const leg of ordered) {
    const detail = leg.status === "GREEN" ? cell(leg.evidence) : cell(leg.reason ?? leg.evidence);
    out.push(`| ${cell(leg.id)} | ${cell(leg.surface)} | ${leg.status} | ${detail} |`);
  }
  return out;
}
