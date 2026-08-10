import { defineState } from "eve/context";
import { classifyIngestion, type IngestionSource, type IngestionVerdict } from "./taint-tiers.js";
import { getSettings, type TaintTierMode as SettingsTaintTierMode } from "../settings/settings.js";

export type TaintTierMode = SettingsTaintTierMode;

export function taintTierMode(): TaintTierMode {
  return getSettings().taint.tierMode;
}

export interface TaintVerdictRow {
  readonly divergence: "over-taint" | "under-taint" | "assumed";
  readonly kind: IngestionSource["kind"];
  readonly label?: string;
  readonly mode: TaintTierMode;
  readonly applied: boolean;
  readonly taintsToday: boolean;
  readonly tableTier: IngestionVerdict["tier"];
  readonly assumed: boolean;
  readonly reason: string;
}

type Sink = (row: TaintVerdictRow) => void;

let sink: Sink | null = null;

export function registerTaintVerdictSink(fn: Sink | null): void {
  sink = fn;
}

export function currentTaintVerdictSink(): Sink | null {
  return sink;
}

interface VerdictSeen {
  readonly turn?: string;
  readonly keys: readonly string[];
}

const seen = defineState<VerdictSeen>("open-everywhere.taint-dryrun-seen", () => ({ keys: [] }));

function readSeen(v: unknown): VerdictSeen {
  if (Array.isArray(v)) return { keys: v.filter((k): k is string => typeof k === "string") };
  if (typeof v === "object" && v !== null && "keys" in (v as Record<string, unknown>)) {
    const s = v as { turn?: unknown; keys?: unknown };
    return {
      turn: typeof s.turn === "string" ? s.turn : undefined,
      keys: Array.isArray(s.keys) ? s.keys.filter((k): k is string => typeof k === "string") : [],
    };
  }
  return { keys: [] };
}

export function beginTaintVerdictTurn(turnId: string | undefined): void {
  try {
    seen.update((cur) => {
      const state = readSeen(cur);
      if (turnId !== undefined && state.turn === turnId) return state;
      return { ...(turnId !== undefined ? { turn: turnId } : {}), keys: [] };
    });
  } catch {
  }
}

function firstThisTurn(key: string): boolean {
  try {
    let fresh = false;
    seen.update((cur) => {
      const state = readSeen(cur);
      if (state.keys.includes(key)) return state;
      fresh = true;
      return { ...state, keys: [...state.keys, key] };
    });
    return fresh;
  } catch {
    return true;
  }
}

export function decideIngestion(src: IngestionSource | undefined, siteWouldTaint: boolean): boolean {
  if (src === undefined) return siteWouldTaint;
  try {
    const mode = taintTierMode();
    const verdict = classifyIngestion(src);
    const wouldTaint = verdict.tier === "untrusted";
    const applied = mode === "enforced" && siteWouldTaint;
    const decision = applied ? wouldTaint : siteWouldTaint;
    noteRow(src, verdict, { mode, applied, siteWouldTaint });
    return decision;
  } catch {
    return siteWouldTaint;
  }
}

export function noteIngestionVerdict(src: IngestionSource | undefined, taintsToday: boolean): void {
  if (src === undefined) return;
  try {
    noteRow(src, classifyIngestion(src), { mode: taintTierMode(), applied: false, siteWouldTaint: taintsToday });
  } catch {
  }
}

function noteRow(
  src: IngestionSource,
  verdict: IngestionVerdict,
  ctx: { mode: TaintTierMode; applied: boolean; siteWouldTaint: boolean },
): void {
  try {
    const wouldTaint = verdict.tier === "untrusted";
    const divergence: TaintVerdictRow["divergence"] | null =
      ctx.siteWouldTaint && !wouldTaint
        ? "over-taint"
        : !ctx.siteWouldTaint && wouldTaint
          ? "under-taint"
          : verdict.assumed
            ? "assumed"
            : null;
    if (divergence === null) return;
    if (!firstThisTurn(`${src.kind}:${divergence}`)) return;
    sink?.({
      divergence,
      kind: src.kind,
      ...(src.label !== undefined ? { label: src.label } : {}),
      mode: ctx.mode,
      applied: ctx.applied,
      taintsToday: ctx.siteWouldTaint,
      tableTier: verdict.tier,
      assumed: verdict.assumed,
      reason: verdict.reason,
    });
  } catch {
  }
}
