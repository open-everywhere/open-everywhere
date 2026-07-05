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
  readonly surfaceMonthlyUsd?: number;
  readonly workspaceMonthlyUsd?: number;
}

export interface CapVerdict {
  readonly over: boolean;
  readonly reason?: string;
}

function fmtUsd(n: number): string {
  return `$${n.toFixed(2)}`;
}

export function checkCap(opts: {
  mode: SessionMode;
  surfaceTokens: number;
  workspaceTokens: number;
  surfaceUsd?: number;
  workspaceUsd?: number;
  caps: Caps;
}): CapVerdict {
  if (opts.mode === "dm") return { over: false };
  const { surfaceMonthlyTokens, workspaceMonthlyTokens, surfaceMonthlyUsd, workspaceMonthlyUsd } = opts.caps;
  if (surfaceMonthlyTokens != null && opts.surfaceTokens >= surfaceMonthlyTokens) {
    return { over: true, reason: `this channel reached its monthly budget (${opts.surfaceTokens.toLocaleString()} / ${surfaceMonthlyTokens.toLocaleString()} tokens)` };
  }
  if (surfaceMonthlyUsd != null && (opts.surfaceUsd ?? 0) >= surfaceMonthlyUsd) {
    return { over: true, reason: `this channel reached its monthly budget (~${fmtUsd(opts.surfaceUsd ?? 0)} of ${fmtUsd(surfaceMonthlyUsd)})` };
  }
  if (workspaceMonthlyTokens != null && opts.workspaceTokens >= workspaceMonthlyTokens) {
    return { over: true, reason: `this workspace reached its monthly budget (${opts.workspaceTokens.toLocaleString()} / ${workspaceMonthlyTokens.toLocaleString()} tokens)` };
  }
  if (workspaceMonthlyUsd != null && (opts.workspaceUsd ?? 0) >= workspaceMonthlyUsd) {
    return { over: true, reason: `this workspace reached its monthly budget (~${fmtUsd(opts.workspaceUsd ?? 0)} of ${fmtUsd(workspaceMonthlyUsd)})` };
  }
  return { over: false };
}

export interface SpendBudgets {
  readonly default?: Caps;
  readonly perWorkspace?: Readonly<Record<string, Caps>>;
  readonly perSurface?: Readonly<Record<string, Caps>>;
}

export function defineSpendBudgets(budgets: SpendBudgets): SpendBudgets {
  return budgets;
}

const CAP_FIELDS = ["surfaceMonthlyTokens", "workspaceMonthlyTokens", "surfaceMonthlyUsd", "workspaceMonthlyUsd"] as const;

function assertCapsShape(caps: Caps, where: string): void {
  for (const key of Object.keys(caps)) {
    if (!(CAP_FIELDS as readonly string[]).includes(key)) {
      throw new Error(`spend budget ${where} has unknown field "${key}" (valid: ${CAP_FIELDS.join(", ")})`);
    }
  }
  if (CAP_FIELDS.every((f) => caps[f] == null)) {
    throw new Error(`spend budget ${where} sets no cap at all — remove the entry or set at least one of ${CAP_FIELDS.join(", ")}`);
  }
  for (const f of CAP_FIELDS) {
    const v = caps[f];
    if (v == null) continue;
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
      throw new Error(`spend budget ${where}.${f} must be a finite number > 0, got ${JSON.stringify(v)}`);
    }
    if ((f === "surfaceMonthlyTokens" || f === "workspaceMonthlyTokens") && !Number.isInteger(v)) {
      throw new Error(`spend budget ${where}.${f} must be an integer token count, got ${v}`);
    }
  }
}

export function assertSpendBudgetsValid(budgets: SpendBudgets): void {
  if (budgets.default) assertCapsShape(budgets.default, "default");
  for (const [key, caps] of Object.entries(budgets.perWorkspace ?? {})) {
    const parts = key.split("/");
    if (parts.length !== 2 || parts.some((p) => !p)) {
      throw new Error(`spend budget perWorkspace key must be "platform/workspace", got ${JSON.stringify(key)}`);
    }
    assertCapsShape(caps, `perWorkspace["${key}"]`);
  }
  for (const [key, caps] of Object.entries(budgets.perSurface ?? {})) {
    const parts = key.split("/");
    if (parts.length !== 3 || parts.some((p) => !p)) {
      throw new Error(`spend budget perSurface key must be "platform/workspace/surface", got ${JSON.stringify(key)}`);
    }
    assertCapsShape(caps, `perSurface["${key}"]`);
  }
}
