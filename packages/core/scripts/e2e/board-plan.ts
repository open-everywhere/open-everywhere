import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { changedAreaScenarios, relevantScenarios } from "./changed-relevant-map.js";
import { LANE_RESOURCE_NAMES, laneDeclarationIndex, type LaneDeclaration, type LaneResource } from "./lanes.js";
import type { BoardLeg } from "./board.js";
import { FixtureMissing, ScenarioSkip, type Scenario } from "./scenarios.js";

export const DEFAULT_MAX_LANES = 4;

export interface LegRisk {
  readonly coversChange: boolean;
  readonly redLastBoard: boolean;
}

export function riskRank(risk: LegRisk): number {
  if (risk.coversChange && risk.redLastBoard) return 0;
  if (risk.coversChange) return 1;
  if (risk.redLastBoard) return 2;
  return 3;
}

export function riskLabel(risk: LegRisk): string {
  if (risk.coversChange && risk.redLastBoard) return "covers a change, red last board";
  if (risk.coversChange) return "covers a change";
  if (risk.redLastBoard) return "red last board";
  return "floor or full roster";
}

export interface LastBoard {
  readonly path: string;
  readonly reds: ReadonlySet<string>;
  readonly durationsMs: ReadonlyMap<string, number>;
}

export function riskOrder<T extends { readonly id: string }>(legs: readonly T[], risk: (id: string) => LegRisk): T[] {
  return legs
    .map((leg, index) => ({ leg, index, rank: riskRank(risk(leg.id)) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((x) => x.leg);
}

export function riskOf(changedPaths: readonly string[] | undefined, lastBoard: LastBoard | undefined): (id: string) => LegRisk {
  const changed = new Set(changedPaths ? changedAreaScenarios(changedPaths) : []);
  const reds = lastBoard?.reds ?? new Set<string>();
  return (id) => ({ coversChange: changed.has(id), redLastBoard: reds.has(id) });
}

export function selectedByDiff(changedPaths: readonly string[] | undefined): ReadonlySet<string> | undefined {
  return changedPaths ? new Set(relevantScenarios(changedPaths)) : undefined;
}

function resourcesOf(decl: LaneDeclaration | undefined): readonly LaneResource[] | "all" {
  if (!decl || decl.parallel === "serial") return "all";
  return decl.resources;
}

export function nextStartable(
  queue: readonly string[],
  running: ReadonlySet<string>,
  declarations: ReadonlyMap<string, LaneDeclaration>,
  maxLanes: number,
): string | undefined {
  if (running.size >= maxLanes) return undefined;
  const reserved = new Set<LaneResource>();
  for (const id of running) {
    const r = resourcesOf(declarations.get(id));
    if (r === "all") return undefined;
    for (const x of r) reserved.add(x);
  }
  for (const id of queue) {
    const r = resourcesOf(declarations.get(id));
    if (r === "all") return running.size === 0 ? id : undefined;
    if (r.some((x) => reserved.has(x))) {
      for (const x of r) reserved.add(x);
      continue;
    }
    return id;
  }
  return undefined;
}

export function stopsBoard(err: unknown): boolean {
  return !(err instanceof FixtureMissing) && !(err instanceof ScenarioSkip);
}

export interface LaneRunOptions {
  readonly maxLanes: number;
  readonly stop: () => boolean;
  readonly run: (id: string, overlapping: () => readonly string[]) => Promise<void>;
}

export async function runLanes(
  order: readonly string[],
  declarations: ReadonlyMap<string, LaneDeclaration>,
  opts: LaneRunOptions,
): Promise<{ readonly started: readonly string[]; readonly notStarted: readonly string[] }> {
  const queue = [...order];
  const running = new Map<string, Promise<string>>();
  const overlaps = new Map<string, Set<string>>();
  const started: string[] = [];
  const errors: unknown[] = [];
  for (;;) {
    while (!opts.stop()) {
      const id = nextStartable(queue, new Set(running.keys()), declarations, opts.maxLanes);
      if (id === undefined) break;
      queue.splice(queue.indexOf(id), 1);
      started.push(id);
      const mine = new Set<string>(running.keys());
      overlaps.set(id, mine);
      for (const other of running.keys()) overlaps.get(other)?.add(id);
      running.set(
        id,
        opts.run(id, () => [...mine]).then(
          () => id,
          (err: unknown) => {
            errors.push(err);
            return id;
          },
        ),
      );
    }
    if (running.size === 0) break;
    const done = await Promise.race(running.values());
    running.delete(done);
    if (queue.length === 0 && running.size === 0) break;
  }
  if (errors.length > 0) throw new AggregateError(errors, `${errors.length} leg(s) threw out of the lane runner`);
  return { started, notStarted: queue };
}

export interface PlannedLeg {
  readonly id: string;
  readonly title: string;
  readonly risk: LegRisk;
  readonly lane: number;
  readonly startMs: number;
  readonly estimateMs: number;
  readonly estimateIsBudget: boolean;
  readonly declaration: LaneDeclaration | undefined;
}

export interface BoardPlan {
  readonly legs: readonly PlannedLeg[];
  readonly notSelected: readonly string[];
  readonly maxLanes: number;
  readonly serialMs: number;
  readonly wallMs: number;
}

export function planBoard(input: {
  readonly scenarios: readonly Scenario[];
  readonly changedPaths?: readonly string[];
  readonly selectByDiff?: boolean;
  readonly lastBoard?: LastBoard;
  readonly maxLanes: number;
  readonly declarations?: ReadonlyMap<string, LaneDeclaration>;
  readonly keep?: (scenario: Scenario) => boolean;
}): BoardPlan {
  const declarations = input.declarations ?? laneDeclarationIndex();
  const selected = input.selectByDiff === false ? undefined : selectedByDiff(input.changedPaths);
  const pool = input.scenarios.filter((s) => input.keep?.(s) ?? true);
  const chosen = pool.filter((s) => !selected || selected.has(s.id));
  const risk = riskOf(input.changedPaths, input.lastBoard);
  const ordered = riskOrder(chosen, risk);
  const byId = new Map(ordered.map((s) => [s.id, s]));
  const estimate = (id: string): { ms: number; budget: boolean } => {
    const measured = input.lastBoard?.durationsMs.get(id);
    return measured !== undefined ? { ms: measured, budget: false } : { ms: byId.get(id)!.timeoutMs, budget: true };
  };

  const queue = ordered.map((s) => s.id);
  const running = new Map<string, { end: number; lane: number }>();
  const placed = new Map<string, { lane: number; start: number }>();
  let now = 0;
  while (queue.length > 0 || running.size > 0) {
    for (;;) {
      const id = nextStartable(queue, new Set(running.keys()), declarations, input.maxLanes);
      if (id === undefined) break;
      queue.splice(queue.indexOf(id), 1);
      const used = new Set([...running.values()].map((r) => r.lane));
      let lane = 1;
      while (used.has(lane)) lane++;
      running.set(id, { end: now + estimate(id).ms, lane });
      placed.set(id, { lane, start: now });
    }
    if (running.size === 0) break;
    now = Math.min(...[...running.values()].map((r) => r.end));
    for (const [id, r] of running) if (r.end <= now) running.delete(id);
  }
  const legs = ordered.map((s) => {
    const p = placed.get(s.id)!;
    const e = estimate(s.id);
    return {
      id: s.id,
      title: s.title,
      risk: risk(s.id),
      lane: p.lane,
      startMs: p.start,
      estimateMs: e.ms,
      estimateIsBudget: e.budget,
      declaration: declarations.get(s.id),
    };
  });
  return {
    legs,
    notSelected: pool.filter((s) => selected && !selected.has(s.id)).map((s) => s.id),
    maxLanes: input.maxLanes,
    serialMs: legs.reduce((sum, l) => sum + l.estimateMs, 0),
    wallMs: legs.reduce((max, l) => Math.max(max, l.startMs + l.estimateMs), 0),
  };
}

function minutes(ms: number): string {
  return `${Math.round(ms / 60_000)} min`;
}

function laneNote(decl: LaneDeclaration | undefined): string {
  if (!decl) return "runs alone (no declaration)";
  if (decl.parallel === "serial") return `runs alone — ${decl.why}`;
  return decl.resources.map((r) => LANE_RESOURCE_NAMES[r]).join(", ");
}

export function renderBoardPlan(plan: BoardPlan): string[] {
  const out: string[] = [];
  out.push("## Board plan");
  out.push("");
  out.push(
    `${plan.legs.length} legs in risk order, up to ${plan.maxLanes} at once. ` +
      `Estimated ${minutes(plan.wallMs)} against ${minutes(plan.serialMs)} one at a time.`,
  );
  if (plan.notSelected.length > 0) out.push(`${plan.notSelected.length} legs not selected by the release diff.`);
  const budgets = plan.legs.filter((l) => l.estimateIsBudget).length;
  if (budgets > 0) out.push(`${budgets} estimates are a leg's budget, because the last board has no time for it.`);
  out.push("");
  out.push("| # | Leg | Risk | Lane | Starts | Needs |");
  out.push("| --- | --- | --- | --- | --- | --- |");
  plan.legs.forEach((leg, i) => {
    out.push(`| ${i + 1} | ${leg.id} | ${riskLabel(leg.risk)} | ${leg.lane} | +${minutes(leg.startMs)} | ${laneNote(leg.declaration)} |`);
  });
  return out;
}

export function redNowLine(id: string, reason: string | undefined): string {
  const text = (reason ?? "").replace(/\s+/g, " ").trim();
  return `E2E-RED ${id} — ${text.length > 0 ? text : "no reason recorded"}`;
}

export function boardResultsDir(): string {
  return join(process.cwd(), "scripts/e2e/results");
}

const BOARD_FILE = /^e2e-board-.*\.json$/;

export function boardRan(legs: readonly BoardLeg[]): boolean {
  return legs.some((l) => l.durationMs !== undefined);
}

export function writeBoardRecord(legs: readonly BoardLeg[], meta: { readonly startedAt: string }, dir: string = boardResultsDir()): string {
  mkdirSync(dir, { recursive: true });
  const finishedAt = new Date().toISOString();
  const path = join(dir, `e2e-board-${finishedAt.replace(/[:.]/g, "-")}.json`);
  const rows = legs.map((l) => ({ id: l.id, status: l.status, ...(l.durationMs !== undefined ? { durationMs: l.durationMs } : {}) }));
  writeFileSync(path, JSON.stringify({ startedAt: meta.startedAt, finishedAt, legs: rows }, null, 2));
  return path;
}

export function readLastBoard(path: string = boardResultsDir()): LastBoard | undefined {
  if (!existsSync(path)) return undefined;
  let file = path;
  if (!path.endsWith(".json")) {
    const names = readdirSync(path).filter((n) => BOARD_FILE.test(n)).sort();
    if (names.length === 0) return undefined;
    file = join(path, names[names.length - 1]!);
  }
  const parsed = JSON.parse(readFileSync(file, "utf8")) as { legs?: { id?: unknown; status?: unknown; durationMs?: unknown }[] };
  const reds = new Set<string>();
  const durationsMs = new Map<string, number>();
  for (const row of parsed.legs ?? []) {
    if (typeof row.id !== "string") continue;
    const ran = typeof row.durationMs === "number" && Number.isFinite(row.durationMs);
    if (row.status === "RED" && ran) reds.add(row.id);
    if (ran) durationsMs.set(row.id, row.durationMs as number);
  }
  return { path: file, reds, durationsMs };
}
