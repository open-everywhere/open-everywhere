import type { SessionMode } from "../access/resolver.js";
import { USER_SCOPE_PREFIX } from "../access/scope-key.js";
import { isQualifiedPrincipalKey } from "../identity/principal-key.js";

export interface Usage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
}

export function periodOf(iso: string): string {
  return iso.slice(0, 7);
}

export function billableTokens(t: { readonly inputTokens: number; readonly outputTokens: number }): number {
  return t.inputTokens + t.outputTokens;
}

export interface Caps {
  readonly surfaceMonthlyTokens?: number;
  readonly workspaceMonthlyTokens?: number;
  readonly surfaceMonthlyUsd?: number;
  readonly workspaceMonthlyUsd?: number;
}

export type UserCaps = Pick<Caps, "surfaceMonthlyTokens" | "surfaceMonthlyUsd">;

export type CapLayer = "user" | "surface" | "workspace";

export interface CapVerdict {
  readonly over: boolean;
  readonly reason?: string;
  readonly layer?: CapLayer;
  readonly scopeKey?: string;
}

function fmtUsd(n: number): string {
  return `$${n.toFixed(2)}`;
}

export interface CapScopeLabels {
  readonly user?: string;
  readonly surface?: string;
  readonly workspace?: string;
}

function onScope(scopeKey: string | undefined): string {
  return scopeKey ? ` on \`${scopeKey}\`` : "";
}

export function checkCap(opts: {
  mode: SessionMode;
  surfaceTokens: number;
  workspaceTokens: number;
  surfaceUsd?: number;
  workspaceUsd?: number;
  userTokens?: number;
  userUsd?: number;
  caps: Caps;
  userCaps?: UserCaps;
  scopes?: CapScopeLabels;
}): CapVerdict {
  const here = opts.mode === "dm" ? "this DM" : opts.mode === "mpim" ? "this group DM" : "this channel";
  const s = opts.scopes ?? {};
  const { surfaceMonthlyTokens: userTokenCap, surfaceMonthlyUsd: userUsdCap } = opts.userCaps ?? {};
  const at = (layer: CapLayer, scopeKey: string | undefined, reason: string): CapVerdict => ({ over: true, reason, layer, ...(scopeKey ? { scopeKey } : {}) });
  if (userTokenCap != null && (opts.userTokens ?? 0) >= userTokenCap) {
    return at("user", s.user, `you've reached your own monthly budget — the per-user cap${onScope(s.user)} (${(opts.userTokens ?? 0).toLocaleString()} / ${userTokenCap.toLocaleString()} tokens)`);
  }
  if (userUsdCap != null && (opts.userUsd ?? 0) >= userUsdCap) {
    return at("user", s.user, `you've reached your own monthly budget — the per-user cap${onScope(s.user)} (~${fmtUsd(opts.userUsd ?? 0)} of ${fmtUsd(userUsdCap)})`);
  }
  const { surfaceMonthlyTokens, workspaceMonthlyTokens, surfaceMonthlyUsd, workspaceMonthlyUsd } = opts.caps;
  if (surfaceMonthlyTokens != null && opts.surfaceTokens >= surfaceMonthlyTokens) {
    return at("surface", s.surface, `${here} reached its monthly budget — the per-surface cap${onScope(s.surface)} (${opts.surfaceTokens.toLocaleString()} / ${surfaceMonthlyTokens.toLocaleString()} tokens)`);
  }
  if (surfaceMonthlyUsd != null && (opts.surfaceUsd ?? 0) >= surfaceMonthlyUsd) {
    return at("surface", s.surface, `${here} reached its monthly budget — the per-surface cap${onScope(s.surface)} (~${fmtUsd(opts.surfaceUsd ?? 0)} of ${fmtUsd(surfaceMonthlyUsd)})`);
  }
  if (workspaceMonthlyTokens != null && opts.workspaceTokens >= workspaceMonthlyTokens) {
    return at("workspace", s.workspace, `this workspace reached its monthly budget — the per-workspace cap${onScope(s.workspace)} (${opts.workspaceTokens.toLocaleString()} / ${workspaceMonthlyTokens.toLocaleString()} tokens)`);
  }
  if (workspaceMonthlyUsd != null && (opts.workspaceUsd ?? 0) >= workspaceMonthlyUsd) {
    return at("workspace", s.workspace, `this workspace reached its monthly budget — the per-workspace cap${onScope(s.workspace)} (~${fmtUsd(opts.workspaceUsd ?? 0)} of ${fmtUsd(workspaceMonthlyUsd)})`);
  }
  return { over: false };
}

export interface SpendBudgets {
  readonly default?: Caps;
  readonly perWorkspace?: Readonly<Record<string, Caps>>;
  readonly perDomain?: Readonly<Record<string, Caps>>;
  readonly perSurface?: Readonly<Record<string, Caps>>;
  readonly perUser?: {
    readonly default?: UserCaps;
    readonly overrides?: Readonly<Record<string, UserCaps>>;
  };
}

export function defineSpendBudgets(budgets: SpendBudgets): SpendBudgets {
  return budgets;
}

const CAP_FIELDS = ["surfaceMonthlyTokens", "workspaceMonthlyTokens", "surfaceMonthlyUsd", "workspaceMonthlyUsd"] as const;
const USER_CAP_FIELDS = ["surfaceMonthlyTokens", "surfaceMonthlyUsd"] as const;

function assertCapsShape(caps: Caps, where: string, allowed: readonly (keyof Caps)[] = CAP_FIELDS): void {
  for (const key of Object.keys(caps)) {
    if (!(allowed as readonly string[]).includes(key)) {
      throw new Error(`spend budget ${where} has unknown field "${key}" (valid: ${allowed.join(", ")})`);
    }
  }
  if (allowed.every((f) => caps[f] == null)) {
    throw new Error(`spend budget ${where} sets no cap at all — remove the entry or set at least one of ${allowed.join(", ")}`);
  }
  for (const f of allowed) {
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
  for (const [key, caps] of Object.entries(budgets.perDomain ?? {})) {
    if (!key.trim()) {
      throw new Error(`spend budget perDomain key must be a non-empty domain name, got ${JSON.stringify(key)}`);
    }
    assertCapsShape(caps, `perDomain["${key}"]`);
  }
  for (const [key, caps] of Object.entries(budgets.perSurface ?? {})) {
    const parts = key.split("/");
    if (parts.length !== 3 || parts.some((p) => !p)) {
      throw new Error(`spend budget perSurface key must be "platform/workspace/surface", got ${JSON.stringify(key)}`);
    }
    assertCapsShape(caps, `perSurface["${key}"]`);
  }
  if (budgets.perUser) {
    for (const key of Object.keys(budgets.perUser)) {
      if (key !== "default" && key !== "overrides") {
        throw new Error(`spend budget perUser has unknown field "${key}" (valid: default, overrides)`);
      }
    }
    if (budgets.perUser.default) assertCapsShape(budgets.perUser.default, "perUser.default", USER_CAP_FIELDS);
    for (const [principalId, caps] of Object.entries(budgets.perUser.overrides ?? {})) {
      if (!principalId.trim()) {
        throw new Error(`spend budget perUser.overrides key must be a non-empty principal id, got ${JSON.stringify(principalId)}`);
      }
      if (principalId.startsWith(USER_SCOPE_PREFIX)) {
        throw new Error(
          `spend budget perUser.overrides key ${JSON.stringify(principalId)} carries the "${USER_SCOPE_PREFIX}" scope-key marker — that prefix belongs to a runtime override's scope key (set_spend_limit level:"user"), not to this registry. Drop it: use "${principalId.slice(USER_SCOPE_PREFIX.length)}".`,
        );
      }
      if (principalId.includes("/") && !isQualifiedPrincipalKey(principalId)) {
        throw new Error(`spend budget perUser.overrides key ${JSON.stringify(principalId)} must be a bare principal id ("U0123ABCD") or a well-formed qualified principal key ("slack/U0123ABCD")`);
      }
      assertCapsShape(caps, `perUser.overrides["${principalId}"]`, USER_CAP_FIELDS);
    }
  }
}
