import { appendAudit, readAudit } from "../audit/audit.js";
import { resolveTurnAnchor, TURN_ANCHOR_TTL_MS, type TurnAnchorQuery } from "./turn-registry.js";

export const TURN_CANCEL_ACTION = "turn.cancel_requested";

export const TURN_CANCELLED_ACTION = "turn.cancelled";

export const TURN_STOP_IGNORED_ACTION = "turn.stop_ignored";

export function isStopDirective(body: string | undefined): boolean {
  if (typeof body !== "string") return false;
  return STOP_DIRECTIVE.test(body.trim());
}

const STOP_DIRECTIVE = /^(?:\/oe\s+)?stop[.!]?$/i;

export type AttachSessionForCancel = (sessionId: string) => {
  cancel(options?: { turnId?: string }): Promise<{ readonly status?: string } | undefined>;
};

export type CancelOutcome =
  | "requested"
  | "no_active_turn"
  | "no_turn_found"
  | "error";

export interface CancelResult {
  readonly outcome: CancelOutcome;
  readonly message: string;
  readonly sessionId?: string;
  readonly turnId?: string;
}

export interface CancelAnchoredTurnInput {
  readonly org: string;
  readonly platform: string;
  readonly workspace: string;
  readonly requestedBy?: string;
  readonly via: "reaction" | "command";
  readonly query: TurnAnchorQuery;
  readonly attachSession: AttachSessionForCancel;
}

export async function cancelAnchoredTurn(input: CancelAnchoredTurnInput): Promise<CancelResult> {
  const anchor = await resolveTurnAnchor(input.org, input.query);
  if (!anchor) {
    await auditCancel(input, { outcome: "no_turn_found" });
    return { outcome: "no_turn_found", message: NOTHING_RUNNING };
  }

  let status: string | undefined;
  try {
    const res = await input.attachSession(anchor.sessionId).cancel({ turnId: anchor.turnId });
    status = typeof res?.status === "string" ? res.status : undefined;
  } catch (err) {
    await auditCancel(input, { outcome: "error", anchorSurfaceKey: anchor.surfaceKey, note: String(err), sessionId: anchor.sessionId, turnId: anchor.turnId });
    return { outcome: "error", message: "Couldn't reach that turn to stand it down — try again in a moment.", sessionId: anchor.sessionId, turnId: anchor.turnId };
  }

  const outcome: CancelOutcome = status === "no_active_turn" ? "no_active_turn" : "requested";
  await auditCancel(input, { outcome, anchorSurfaceKey: anchor.surfaceKey, sessionId: anchor.sessionId, turnId: anchor.turnId, ...(status ? { status } : {}) });
  return {
    outcome,
    message: outcome === "no_active_turn" ? NOTHING_RUNNING : STANDING_DOWN,
    sessionId: anchor.sessionId,
    turnId: anchor.turnId,
  };
}

const NOTHING_RUNNING = "Nothing running here right now — I'm already waiting on you.";

const STANDING_DOWN = "Standing down — I've asked this turn to stop. I'll post the outcome in the thread.";

const CANCEL_REQUEST_SCAN = 50;

const CANCEL_REQUEST_WINDOW_MS = 2 * TURN_ANCHOR_TTL_MS;

const PLAIN_PRINCIPAL_ID = /^[A-Za-z0-9._:@|+-]{1,64}$/;

export interface CancelRequestRecord {
  readonly principalId?: string;
  readonly via?: string;
  readonly outcome?: string;
  readonly at?: string;
}

export async function findCancelRequest(input: { readonly org: string; readonly turnId: string; readonly sessionId?: string }): Promise<CancelRequestRecord | undefined> {
  const since = new Date(Date.now() - CANCEL_REQUEST_WINDOW_MS).toISOString();
  const rows = await readAudit({ org: input.org, action: TURN_CANCEL_ACTION, since, limit: CANCEL_REQUEST_SCAN });
  for (const row of rows) {
    const detail = row.detail ?? {};
    if (detail["turnId"] !== input.turnId) continue;
    const rowSessionId = detail["sessionId"];
    if (input.sessionId !== undefined && typeof rowSessionId === "string" && rowSessionId !== input.sessionId) continue;
    return {
      ...(typeof row.principalId === "string" ? { principalId: row.principalId } : {}),
      ...(typeof detail["via"] === "string" ? { via: detail["via"] as string } : {}),
      ...(typeof detail["outcome"] === "string" ? { outcome: detail["outcome"] as string } : {}),
      ...(typeof row.ts === "string" ? { at: row.ts } : {}),
    };
  }
  return undefined;
}

export async function findCancelRequester(org: string, turnId: string, sessionId?: string): Promise<string | undefined> {
  try {
    const by = (await findCancelRequest({ org, turnId, ...(sessionId === undefined ? {} : { sessionId }) }))?.principalId;
    return typeof by === "string" && PLAIN_PRINCIPAL_ID.test(by) ? by : undefined;
  } catch {
    return undefined;
  }
}

export const UNPAIRED_STOP_DEFAULT_WINDOW_MS = 24 * 60 * 60_000;
export const UNPAIRED_STOP_MAX_WINDOW_MS = 30 * 24 * 60 * 60_000;
export const UNPAIRED_STOP_DEFAULT_GRACE_MS = 60_000;
const UNPAIRED_STOP_SCAN = 1000;
const UNPAIRED_STOP_DEFAULT_LIMIT = 200;

export interface UnpairedStopRow {
  readonly sessionId: string;
  readonly turnId: string;
  readonly requestedAt: string;
  readonly ageMs: number;
  readonly principalId?: string;
  readonly via?: string;
  readonly surfaceKey?: string;
}

export interface UnpairedStopsResult {
  readonly org: string;
  readonly since: string;
  readonly graceMs: number;
  readonly requestsConsidered: number;
  readonly requestsWithinGrace: number;
  readonly requestsUndated: number;
  readonly scanTruncated: boolean;
  readonly unpaired: readonly UnpairedStopRow[];
  readonly capped: boolean;
}

export interface UnpairedStopsQuery {
  readonly org: string;
  readonly windowMs?: number;
  readonly graceMs?: number;
  readonly limit?: number;
  readonly now?: number;
}

function pairKey(detail: Readonly<Record<string, unknown>>): string | undefined {
  const sessionId = detail["sessionId"];
  const turnId = detail["turnId"];
  if (typeof sessionId !== "string" || typeof turnId !== "string" || !sessionId || !turnId) return undefined;
  return JSON.stringify([sessionId, turnId]);
}

export async function unpairedStops(q: UnpairedStopsQuery): Promise<UnpairedStopsResult> {
  const now = q.now ?? Date.now();
  const windowMs = Math.min(Math.max(q.windowMs ?? UNPAIRED_STOP_DEFAULT_WINDOW_MS, 0), UNPAIRED_STOP_MAX_WINDOW_MS);
  const graceMs = Math.max(q.graceMs ?? UNPAIRED_STOP_DEFAULT_GRACE_MS, 0);
  const limit = Math.min(Math.max(q.limit ?? UNPAIRED_STOP_DEFAULT_LIMIT, 1), UNPAIRED_STOP_SCAN);
  const since = new Date(now - windowMs).toISOString();
  const scan = { org: q.org, since, limit: UNPAIRED_STOP_SCAN };

  const [requests, cancelled, ignored] = await Promise.all([
    readAudit({ ...scan, action: TURN_CANCEL_ACTION }),
    readAudit({ ...scan, action: TURN_CANCELLED_ACTION }),
    readAudit({ ...scan, action: TURN_STOP_IGNORED_ACTION }),
  ]);

  const partners = new Set<string>();
  for (const row of [...cancelled, ...ignored]) {
    const key = pairKey(row.detail ?? {});
    if (key) partners.add(key);
  }

  const found: UnpairedStopRow[] = [];
  let requestsConsidered = 0;
  let requestsWithinGrace = 0;
  let requestsUndated = 0;
  for (const row of requests) {
    const detail = row.detail ?? {};
    if (detail["outcome"] !== "requested") continue;
    const key = pairKey(detail);
    if (!key) continue;
    const at = typeof row.ts === "string" ? Date.parse(row.ts) : Number.NaN;
    if (!Number.isFinite(at)) {
      requestsUndated++;
      continue;
    }
    const ageMs = now - at;
    if (ageMs < graceMs) {
      requestsWithinGrace++;
      continue;
    }
    requestsConsidered++;
    if (partners.has(key)) continue;
    const [sessionId, turnId] = JSON.parse(key) as [string, string];
    found.push({
      sessionId,
      turnId,
      requestedAt: row.ts as string,
      ageMs,
      ...(typeof row.principalId === "string" ? { principalId: row.principalId } : {}),
      ...(typeof detail["via"] === "string" ? { via: detail["via"] as string } : {}),
      ...(typeof detail["surfaceKey"] === "string" ? { surfaceKey: detail["surfaceKey"] as string } : {}),
    });
  }

  return {
    org: q.org,
    since,
    graceMs,
    requestsConsidered,
    requestsWithinGrace,
    requestsUndated,
    scanTruncated: requests.length >= UNPAIRED_STOP_SCAN || cancelled.length >= UNPAIRED_STOP_SCAN || ignored.length >= UNPAIRED_STOP_SCAN,
    unpaired: found.slice(0, limit),
    capped: found.length > limit,
  };
}

async function auditCancel(
  input: CancelAnchoredTurnInput,
  detail: { outcome: CancelOutcome; anchorSurfaceKey?: string; status?: string; note?: string; sessionId?: string; turnId?: string },
): Promise<void> {
  try {
    await appendAudit({
      org: input.org,
      platform: input.platform,
      workspace: input.workspace,
      action: TURN_CANCEL_ACTION,
      ...(input.requestedBy ? { principalId: input.requestedBy } : {}),
      detail: {
        via: input.via,
        outcome: detail.outcome,
        ...(detail.sessionId ? { sessionId: detail.sessionId } : {}),
        ...(detail.turnId ? { turnId: detail.turnId } : {}),
        ...(detail.anchorSurfaceKey ? { surfaceKey: detail.anchorSurfaceKey } : {}),
        ...(detail.status ? { eveStatus: detail.status } : {}),
        ...(detail.note ? { note: detail.note } : {}),
      },
    });
  } catch {
  }
}
