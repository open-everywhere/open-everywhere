import { appendAudit, type AuditInput } from "../audit/audit.js";
import { getOperationalStore } from "../operational/provider.js";
import type { OperationalStore } from "../operational/store.js";
import { supervisorRotateTokenBudget } from "./turn-delivery.js";
import { DM_SEAT_ROTATE_TOKEN_BUDGET } from "./dm-seat.js";
import { standingSeatRegistryKey } from "./unified-supervisor.js";
import { isWorkWindowToken } from "./window-key.js";
import { countedInputTokens } from "../model/session-usage.js";

export const SESSION_LIMIT_CONTINUATION_TOOL_NAME = "session_limit_continuation";

export const SESSION_LIMIT_REQUEST_ID_RE = /:limit:(?:usage|input|output):\d+$/u;

const SESSION_USAGE_WINDOW_RE = /:limit:usage:(\d+)$/u;

export function sessionUsageWindowIndex(requestId: string): number | undefined {
  const m = SESSION_USAGE_WINDOW_RE.exec(requestId);
  return m ? Number(m[1]) : undefined;
}

export const SESSION_LIMIT_COST_REQUEST_ID_RE = /:limit:token-cost:\d+(?:\.\d+)?(?:e[+-]?\d+)?$/iu;

export function isSessionLimitRequestId(requestId: string): boolean {
  return SESSION_LIMIT_REQUEST_ID_RE.test(requestId) || SESSION_LIMIT_COST_REQUEST_ID_RE.test(requestId);
}

export const SESSION_PARK_AUDIT_ACTION = "session.token_limit_park";

export const PARK_AUDIT_WINDOW_MS = 60 * 60_000;

export function parkRotateDelta(): number {
  return Math.max(supervisorRotateTokenBudget(), DM_SEAT_ROTATE_TOKEN_BUDGET);
}

export interface SessionLimitPark {
  readonly kind: "input" | "output" | "token-cost" | "unknown";
  readonly limit?: number;
  readonly usedTokens?: number;
  readonly limitUsd?: number;
  readonly usedCostUsd?: number;
  readonly requestId: string;
}

function numberOrUndefined(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

export function isSessionLimitContinuationRequest(request: unknown): boolean {
  if (request === null || typeof request !== "object") return false;
  return (request as { action?: { toolName?: unknown } }).action?.toolName === SESSION_LIMIT_CONTINUATION_TOOL_NAME;
}

export interface BudgetInteraction {
  readonly interactionId: string;
  readonly requestKind: unknown;
  readonly relayed: boolean;
  readonly budget: unknown;
  readonly sessionUsage: unknown;
}

function usageTokensOf(v: unknown): Parameters<typeof countedInputTokens>[0] | undefined {
  if (v === null || typeof v !== "object") return undefined;
  const u = v as Record<string, unknown>;
  const inputTokens = numberOrUndefined(u["inputTokens"]);
  const cacheReadTokens = numberOrUndefined(u["cacheReadTokens"]);
  if (inputTokens === undefined || cacheReadTokens === undefined) return undefined;
  return {
    inputTokens,
    cacheReadTokens,
    cacheWriteTokens: numberOrUndefined(u["cacheWriteTokens"]) ?? 0,
    outputTokens: numberOrUndefined(u["outputTokens"]) ?? 0,
  };
}

export function budgetSessionLimitPark(i: BudgetInteraction): SessionLimitPark | undefined {
  if (i.requestKind !== "budget") return undefined;
  const budget = numberOrUndefined(i.budget);
  const limit = budget !== undefined && budget > 0 ? budget : undefined;
  const usage = usageTokensOf(i.sessionUsage);
  const usedTokens =
    !i.relayed && sessionUsageWindowIndex(i.interactionId) === 0 && usage !== undefined ? countedInputTokens(usage) : undefined;
  return {
    kind: "input",
    ...(limit !== undefined ? { limit } : {}),
    ...(usedTokens !== undefined ? { usedTokens } : {}),
    requestId: i.interactionId,
  };
}

export function detectSessionLimitPark(requests: unknown): SessionLimitPark | undefined {
  if (!Array.isArray(requests)) return undefined;
  for (const r of requests as readonly unknown[]) {
    if (!isSessionLimitContinuationRequest(r)) continue;
    const req = r as { requestId?: unknown; action?: { toolName?: unknown; input?: unknown } };
    const requestId = typeof req.requestId === "string" ? req.requestId : "";
    const input = (req.action?.input ?? {}) as {
      kind?: unknown;
      limit?: unknown;
      usedTokens?: unknown;
      limitUsd?: unknown;
      usedCostUsd?: unknown;
    };
    const kind =
      input.kind === "input" || input.kind === "output" || input.kind === "token-cost" ? input.kind : "unknown";
    const limit = numberOrUndefined(input.limit);
    const usedTokens = numberOrUndefined(input.usedTokens);
    const limitUsd = numberOrUndefined(input.limitUsd);
    const usedCostUsd = numberOrUndefined(input.usedCostUsd);
    return {
      kind,
      ...(limit !== undefined ? { limit } : {}),
      ...(usedTokens !== undefined ? { usedTokens } : {}),
      ...(limitUsd !== undefined ? { limitUsd } : {}),
      ...(usedCostUsd !== undefined ? { usedCostUsd } : {}),
      requestId,
    };
  }
  return undefined;
}

export type ParkRemedy =
  | "rotate_on_next_wake"
  | "already_rotated"
  | "none";

export interface ParkOutcome {
  readonly remedy: ParkRemedy;
  readonly tier: "work" | "seat";
  readonly registryKey?: string;
  readonly audited: boolean;
}

export interface ParkScope {
  readonly org: string;
  readonly platform: string;
  readonly workspace: string;
  readonly surface: string;
  readonly domainKey: string;
  readonly token: unknown;
  readonly sessionId?: string;
}

export interface ParkDeps {
  readonly store?: Pick<OperationalStore, "bumpChannelSessionUsage" | "markEventSeen">;
  readonly audit?: (entry: AuditInput) => Promise<void>;
  readonly now?: () => Date;
}

export function parkThrottleKey(registryKey: string | undefined, token: unknown): string {
  return `sessionpark:${registryKey ?? `token:${typeof token === "string" ? token : "unknown"}`}`;
}

export async function handleSessionLimitPark(scope: ParkScope, park: SessionLimitPark, deps: ParkDeps = {}): Promise<ParkOutcome> {
  const store = deps.store ?? getOperationalStore();
  const registryKey = standingSeatRegistryKey(scope.token, scope.domainKey);
  const token = typeof scope.token === "string" ? scope.token : undefined;
  const tier: "work" | "seat" = isWorkWindowToken(token) ? "work" : "seat";

  let remedy: ParkRemedy = "none";
  if (registryKey !== undefined && token !== undefined) {
    try {
      const matched = await store.bumpChannelSessionUsage(scope.org, registryKey, token, parkRotateDelta());
      remedy = matched > 0 ? "rotate_on_next_wake" : "already_rotated";
    } catch (err) {
      console.warn(`[open-everywhere:session-park] generation retire failed for ${registryKey}: ${String(err)}`);
      remedy = "already_rotated";
    }
  }

  const nowIso = (deps.now?.() ?? new Date()).toISOString();
  const throttleKey = parkThrottleKey(registryKey, scope.token);
  let first = true;
  try {
    first = await store.markEventSeen(scope.org, throttleKey, nowIso, PARK_AUDIT_WINDOW_MS);
  } catch {
    first = true;
  }
  if (!first) return { remedy, tier, ...(registryKey !== undefined ? { registryKey } : {}), audited: false };

  await (deps.audit ?? appendAudit)({
    org: scope.org,
    platform: scope.platform,
    workspace: scope.workspace,
    surface: scope.surface,
    principalId: "eve:harness",
    action: SESSION_PARK_AUDIT_ACTION,
    detail: {
      remedy,
      tier,
      kind: park.kind,
      requestId: park.requestId,
      ...(park.limit !== undefined ? { limit: park.limit } : {}),
      ...(park.usedTokens !== undefined ? { usedTokens: park.usedTokens } : {}),
      ...(park.limitUsd !== undefined ? { limitUsd: park.limitUsd } : {}),
      ...(park.usedCostUsd !== undefined ? { usedCostUsd: park.usedCostUsd } : {}),
      ...(scope.sessionId !== undefined ? { sessionId: scope.sessionId } : {}),
      ...(registryKey !== undefined ? { registryKey } : {}),
      ...(token !== undefined ? { token } : {}),
      note:
        remedy === "rotate_on_next_wake" && tier === "work"
          ? "the work session's generation was retired — the next forward rotates it to a fresh session with a fresh sandbox; the seat's generation is untouched, and every job the parked work session still owed is reported to the room as lost"
          : remedy === "rotate_on_next_wake"
          ? "the seat's generation was retired — the next wake rotates to a fresh session; the parked message was NOT redelivered"
          : remedy === "already_rotated"
            ? "no live registry row matched this token — the generation had already been retired/rotated"
            : "this session has no channel_session row (thread seat / task / native) — it cannot be rotated and will not answer again; start a fresh thread",
    },
  }).catch(() => undefined);

  return { remedy, tier, ...(registryKey !== undefined ? { registryKey } : {}), audited: true };
}
