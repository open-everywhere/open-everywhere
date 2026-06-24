import type { SessionMode } from "../access/resolver.js";

export interface Usage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
}

export interface SpendWindow {
  inputTokens: number;
  outputTokens: number;
  calls: number;
}

export interface SurfaceLedger {
  windows: Record<string, SpendWindow>;
}

export function periodOf(iso: string): string {
  return iso.slice(0, 7);
}

export function emptyWindow(): SpendWindow {
  return { inputTokens: 0, outputTokens: 0, calls: 0 };
}

export function addUsage(w: SpendWindow, u: Usage): SpendWindow {
  return {
    inputTokens: w.inputTokens + (u.inputTokens ?? 0),
    outputTokens: w.outputTokens + (u.outputTokens ?? 0),
    calls: w.calls + 1,
  };
}

export function windowTokens(w: SpendWindow | undefined): number {
  return w ? w.inputTokens + w.outputTokens : 0;
}

export interface Caps {
  readonly surfaceMonthlyTokens?: number;
  readonly workspaceMonthlyTokens?: number;
}

export interface CapVerdict {
  readonly over: boolean;
  readonly reason?: string;
}

export function checkCap(opts: {
  mode: SessionMode;
  surfaceTokens: number;
  workspaceTokens: number;
  caps: Caps;
}): CapVerdict {
  if (opts.mode === "dm") return { over: false };
  const { surfaceMonthlyTokens, workspaceMonthlyTokens } = opts.caps;
  if (surfaceMonthlyTokens != null && opts.surfaceTokens >= surfaceMonthlyTokens) {
    return { over: true, reason: `this channel reached its monthly budget (${opts.surfaceTokens.toLocaleString()} / ${surfaceMonthlyTokens.toLocaleString()} tokens)` };
  }
  if (workspaceMonthlyTokens != null && opts.workspaceTokens >= workspaceMonthlyTokens) {
    return { over: true, reason: `this workspace reached its monthly budget (${opts.workspaceTokens.toLocaleString()} / ${workspaceMonthlyTokens.toLocaleString()} tokens)` };
  }
  return { over: false };
}
