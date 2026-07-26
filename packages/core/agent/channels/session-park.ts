import { appendAudit, type AuditInput } from "../audit/audit.js";
import { getOperationalStore } from "../operational/provider.js";
import type { OperationalStore } from "../operational/store.js";
import { SUPERVISOR_ROTATE_TOKEN_BUDGET } from "./turn-delivery.js";
import { DM_SEAT_ROTATE_TOKEN_BUDGET } from "./dm-seat.js";
import { standingSeatRegistryKey } from "./unified-supervisor.js";

export const SESSION_LIMIT_CONTINUATION_TOOL_NAME = "session_limit_continuation";

export const SESSION_LIMIT_REQUEST_ID_RE = /:limit:(?:input|output):\d+$/u;

export const SESSION_PARK_AUDIT_ACTION = "session.token_limit_park";

export const PARK_AUDIT_WINDOW_MS = 60 * 60_000;

export function parkRotateDelta(): number {
  return Math.max(SUPERVISOR_ROTATE_TOKEN_BUDGET, DM_SEAT_ROTATE_TOKEN_BUDGET);
}

export interface SessionLimitPark {
  readonly kind: "input" | "output" | "unknown";
  readonly limit?: number;
  readonly usedTokens?: number;
  readonly requestId: string;
}

function numberOrUndefined(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

export function detectSessionLimitPark(requests: unknown): SessionLimitPark | undefined {
  if (!Array.isArray(requests)) return undefined;
  for (const r of requests as readonly unknown[]) {
    if (r === null || typeof r !== "object") continue;
    const req = r as { requestId?: unknown; action?: { toolName?: unknown; input?: unknown } };
    if (req.action?.toolName !== SESSION_LIMIT_CONTINUATION_TOOL_NAME) continue;
    const requestId = typeof req.requestId === "string" ? req.requestId : "";
    const input = (req.action?.input ?? {}) as { kind?: unknown; limit?: unknown; usedTokens?: unknown };
    const kind = input.kind === "input" || input.kind === "output" ? input.kind : "unknown";
    const limit = numberOrUndefined(input.limit);
    const usedTokens = numberOrUndefined(input.usedTokens);
    return {
      kind,
      ...(limit !== undefined ? { limit } : {}),
      ...(usedTokens !== undefined ? { usedTokens } : {}),
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
  if (!first) return { remedy, ...(registryKey !== undefined ? { registryKey } : {}), audited: false };

  await (deps.audit ?? appendAudit)({
    org: scope.org,
    platform: scope.platform,
    workspace: scope.workspace,
    surface: scope.surface,
    principalId: "eve:harness",
    action: SESSION_PARK_AUDIT_ACTION,
    detail: {
      remedy,
      kind: park.kind,
      requestId: park.requestId,
      ...(park.limit !== undefined ? { limit: park.limit } : {}),
      ...(park.usedTokens !== undefined ? { usedTokens: park.usedTokens } : {}),
      ...(scope.sessionId !== undefined ? { sessionId: scope.sessionId } : {}),
      ...(registryKey !== undefined ? { registryKey } : {}),
      ...(token !== undefined ? { token } : {}),
      note:
        remedy === "rotate_on_next_wake"
          ? "the seat's generation was retired — the next wake rotates to a fresh session; the parked message was NOT redelivered"
          : remedy === "already_rotated"
            ? "no live registry row matched this token — the generation had already been retired/rotated"
            : "this session has no channel_session row (thread seat / task / native) — it cannot be rotated and will not answer again; start a fresh thread",
    },
  }).catch(() => undefined);

  return { remedy, ...(registryKey !== undefined ? { registryKey } : {}), audited: true };
}
