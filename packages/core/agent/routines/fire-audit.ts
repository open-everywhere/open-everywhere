import { appendAudit, readAudit, type AuditInput } from "../audit/audit.js";
import { getOperationalStore } from "../operational/provider.js";
import { usageSummary } from "../spend/usage-events.js";
import { isSilentRoutine, type Routine } from "./routine.js";

export const ROUTINE_AUDIT = {
  fire: "routine.fire",
  skip: "routine.skip",
  fireLost: "routine.fire_lost",
  disabled: "routine.disabled",
  stalled: "routine.stalled",
  runNow: "routine.run_now",
} as const;

export type RoutineSkipReason =
  | "fanout_cap"
  | "over_budget"
  | "unresolved_target"
  | "filter_invalid"
  | "grant_refused"
  | "grant_drift"
  | "audience_floor"
  | "creator_removed_from_room"
  | "creator_account_inactive"
  | "halted";

export const SKIP_WINDOW_MS = 60 * 60_000;

export function routineAuditScope(r: Pick<Routine, "surfaceKey">): { platform: string; workspace: string; surface: string } {
  const [platform = "", workspace = "", ...rest] = r.surfaceKey.split("/");
  return { platform, workspace, surface: rest.join("/") };
}

export const ROUTINE_DISPATCHER_PRINCIPAL = "routine:dispatcher";

export interface RoutineAuditDeps {
  readonly audit?: (entry: AuditInput) => Promise<void>;
  readonly markSeen?: (org: string, key: string, atIso: string, ttlMs: number) => Promise<boolean>;
  readonly now?: () => Date;
  readonly principalId?: string;
}

const suppressed = new Map<string, number>();

export function resetRoutineSkipThrottle(): void {
  suppressed.clear();
}

export function skipThrottleKey(routineId: string, reason: RoutineSkipReason): string {
  return `routineskip:${routineId}:${reason}`;
}

async function write(entry: AuditInput, deps: RoutineAuditDeps): Promise<void> {
  await (deps.audit ?? appendAudit)(entry).catch(() => undefined);
}

export async function auditRoutineSkip(
  r: Routine,
  reason: RoutineSkipReason,
  extra: Readonly<Record<string, unknown>> = {},
  deps: RoutineAuditDeps = {},
): Promise<boolean> {
  const nowIso = (deps.now?.() ?? new Date()).toISOString();
  const key = skipThrottleKey(r.id, reason);
  let first = true;
  try {
    const markSeen =
      deps.markSeen ?? ((o: string, k: string, at: string, ttl: number) => getOperationalStore().markEventSeen(o, k, at, ttl));
    first = await markSeen(r.org, key, nowIso, SKIP_WINDOW_MS);
  } catch {
    first = true;
  }
  if (!first) {
    suppressed.set(key, (suppressed.get(key) ?? 0) + 1);
    return false;
  }
  const carried = suppressed.get(key) ?? 0;
  suppressed.delete(key);
  await write(
    {
      org: r.org,
      ...routineAuditScope(r),
      principalId: deps.principalId ?? ROUTINE_DISPATCHER_PRINCIPAL,
      action: ROUTINE_AUDIT.skip,
      detail: {
        routineId: r.id,
        reason,
        ...extra,
        ...(carried > 0 ? { suppressed: carried, windowMs: SKIP_WINDOW_MS } : {}),
      },
    },
    deps,
  );
  return true;
}

export async function auditRoutineFire(
  r: Routine,
  sessionId: string,
  outcome: string,
  extra: Readonly<Record<string, unknown>> = {},
  deps: RoutineAuditDeps = {},
): Promise<void> {
  await write(
    {
      org: r.org,
      ...routineAuditScope(r),
      principalId: deps.principalId ?? ROUTINE_DISPATCHER_PRINCIPAL,
      action: ROUTINE_AUDIT.fire,
      detail: { routineId: r.id, sessionId, outcome, ...(isSilentRoutine(r) ? { silent: true, reportKind: "silent" } : {}), ...extra },
    },
    deps,
  );
}

export async function auditRoutineFireLost(r: Routine, error: string, deps: RoutineAuditDeps = {}): Promise<void> {
  await write(
    {
      org: r.org,
      ...routineAuditScope(r),
      principalId: deps.principalId ?? ROUTINE_DISPATCHER_PRINCIPAL,
      action: ROUTINE_AUDIT.fireLost,
      detail: {
        routineId: r.id,
        error: error.slice(0, 300),
        sessionId: null,
        note: "delivery rejected — no session started, so no sessionId exists for this fire",
      },
    },
    deps,
  );
}

export async function auditRoutineStalled(
  r: Routine,
  detail: { readonly tool: string; readonly reason: string; readonly stalledFires: number },
  deps: RoutineAuditDeps = {},
): Promise<void> {
  await write(
    {
      org: r.org,
      ...routineAuditScope(r),
      principalId: deps.principalId ?? ROUTINE_DISPATCHER_PRINCIPAL,
      action: ROUTINE_AUDIT.stalled,
      detail: {
        routineId: r.id,
        tool: detail.tool,
        reason: detail.reason.slice(0, 300),
        stalledFires: detail.stalledFires,
      },
    },
    deps,
  );
}

export async function auditRoutineRunNow(
  r: Routine,
  requestedBy: string,
  nextRunAt: string,
  deps: RoutineAuditDeps = {},
): Promise<void> {
  await write(
    {
      org: r.org,
      ...routineAuditScope(r),
      principalId: requestedBy,
      action: ROUTINE_AUDIT.runNow,
      detail: { routineId: r.id, requestedBy, nextRunAt, trigger: r.trigger.kind },
    },
    deps,
  );
}

export async function auditRoutineDisabled(
  r: Routine,
  reason: string,
  consecutiveFailures: number,
  sessionId: string | undefined,
  extra: Readonly<Record<string, unknown>> = {},
  deps: RoutineAuditDeps = {},
): Promise<void> {
  await write(
    {
      org: r.org,
      ...routineAuditScope(r),
      principalId: deps.principalId ?? ROUTINE_DISPATCHER_PRINCIPAL,
      action: ROUTINE_AUDIT.disabled,
      detail: { routineId: r.id, reason, consecutiveFailures, ...(sessionId ? { sessionId } : {}), ...extra },
    },
    deps,
  );
}

export const FORENSIC_WINDOW_MS = 7 * 24 * 60 * 60_000;

export const FORENSIC_SCAN_LIMIT = 5000;

export interface RoutineForensics {
  readonly lastSessionId: string | null;
  readonly lastFireAt: string | null;
  readonly lastPostedAt: string | null;
  readonly fires7d: number;
  readonly tokens7d: number;
}

const EMPTY_FORENSICS: RoutineForensics = { lastSessionId: null, lastFireAt: null, lastPostedAt: null, fires7d: 0, tokens7d: 0 };

export function emptyRoutineForensics(): RoutineForensics {
  return EMPTY_FORENSICS;
}

function detailString(detail: Readonly<Record<string, unknown>> | undefined, key: string): string | undefined {
  const v = detail?.[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

export async function readRoutineForensics(
  scope: {
    readonly org: string;
    readonly platform: string;
    readonly workspace: string;
    readonly surface: string;
    readonly surfaceKey: string;
  },
  now: Date = new Date(),
): Promise<Map<string, RoutineForensics>> {
  const out = new Map<string, RoutineForensics>();
  const since = new Date(now.getTime() - FORENSIC_WINDOW_MS).toISOString();
  const base = {
    org: scope.org,
    platform: scope.platform,
    workspace: scope.workspace,
    surface: scope.surface,
    since,
    limit: FORENSIC_SCAN_LIMIT,
  };
  try {
    const fires = await readAudit({ ...base, action: ROUTINE_AUDIT.fire });
    const acc = new Map<string, { lastSessionId: string | null; lastFireAt: string | null; fires: number; sessions: Set<string> }>();
    for (const row of fires) {
      const id = detailString(row.detail, "routineId");
      if (id === undefined) continue;
      let a = acc.get(id);
      if (!a) {
        a = { lastSessionId: null, lastFireAt: null, fires: 0, sessions: new Set<string>() };
        acc.set(id, a);
      }
      a.fires++;
      const sid = detailString(row.detail, "sessionId");
      if (sid !== undefined) a.sessions.add(sid);
      if (a.lastFireAt === null) {
        a.lastFireAt = row.ts;
        a.lastSessionId = sid ?? null;
      }
    }

    const posted = new Map<string, string>();
    if (acc.size > 0) {
      const posts = await readAudit({ ...base, action: "reply.post" });
      for (const row of posts) {
        const sid = detailString(row.detail, "sessionId");
        if (sid === undefined) continue;
        for (const [id, a] of acc) {
          if (!posted.has(id) && a.sessions.has(sid)) posted.set(id, row.ts);
        }
      }
    }

    const tokens = new Map<string, number>();
    const rollup = await usageSummary(scope.org, { surfaceKeyPrefix: scope.surfaceKey, sinceTs: since });
    for (const g of rollup) {
      if (g.routineId === undefined) continue;
      tokens.set(g.routineId, (tokens.get(g.routineId) ?? 0) + g.inputTokens + g.outputTokens + g.cacheReadTokens + g.cacheWriteTokens);
    }

    for (const id of new Set([...acc.keys(), ...tokens.keys()])) {
      const a = acc.get(id);
      out.set(id, {
        lastSessionId: a?.lastSessionId ?? null,
        lastFireAt: a?.lastFireAt ?? null,
        lastPostedAt: posted.get(id) ?? null,
        fires7d: a?.fires ?? 0,
        tokens7d: tokens.get(id) ?? 0,
      });
    }
  } catch (err) {
    console.warn(`[open-everywhere:routines] forensics read skipped for ${scope.surfaceKey}: ${String(err)}`);
    return new Map();
  }
  return out;
}

export interface RoutineFireRow {
  readonly routineId: string;
  readonly sessionId: string;
  readonly at: string;
  readonly outcome: string | null;
  readonly silent: boolean;
}

export async function listRoutineFires(
  scope: {
    readonly org: string;
    readonly platform: string;
    readonly workspace: string;
    readonly surface: string;
  },
  routineId: string,
  now: Date = new Date(),
): Promise<RoutineFireRow[]> {
  const rows = await readAudit({
    org: scope.org,
    platform: scope.platform,
    workspace: scope.workspace,
    surface: scope.surface,
    action: ROUTINE_AUDIT.fire,
    since: new Date(now.getTime() - FORENSIC_WINDOW_MS).toISOString(),
    limit: FORENSIC_SCAN_LIMIT,
  });
  const out: RoutineFireRow[] = [];
  for (const row of rows) {
    if (detailString(row.detail, "routineId") !== routineId) continue;
    const sessionId = detailString(row.detail, "sessionId");
    if (sessionId === undefined) continue;
    out.push({
      routineId,
      sessionId,
      at: row.ts,
      outcome: detailString(row.detail, "outcome") ?? null,
      silent: row.detail?.silent === true,
    });
  }
  return out;
}
