import type { AttachSessionFn } from "eve/channels";
import { routeAuth } from "eve/channels/auth";
import { classifySessionId } from "../channels/window-key.js";
import { readTokenEntries, serviceTokenAuth, type EveSessionAuth } from "./auth.js";
import { auditView, usageWindowView, unifiedDomainAudit, toolUsageView } from "./views.js";
import { appendAudit } from "../audit/audit.js";
import type { AuditFilter } from "../audit/audit.js";
import { deploymentOrg } from "../identity/binding.js";
import { credentialKeyArmed } from "../credentials/db-broker.js";
import { getOperationalStore } from "../operational/provider.js";

export const CONTROL_READ_USAGE_PATH = "/control/v1/usage";
export const CONTROL_READ_TOOL_USAGE_PATH = "/control/v1/tool-usage";
export const CONTROL_READ_AUDIT_PATH = "/control/v1/audit";
export const CONTROL_READ_UNIFIED_AUDIT_PATH = "/control/v1/unified-audit";
export const CONTROL_READ_TRANSCRIPT_PATH = "/control/v1/session/:sessionId/transcript";
export const CONTROL_READ_RUNTIME_SIGNAL_PATH = "/control/v1/runtime-signal";
export const CONTROL_READ_MODEL_CALLS_PATH = "/control/v1/session/:sessionId/model-calls";
export const CONTROL_READ_MODEL_CALL_SESSIONS_PATH = "/control/v1/model-calls/sessions";
export const AUDIT_MAX_LIMIT = 1000;
const AUDIT_MAX_ACTIONS = 25;
const AUDIT_DEFAULT_LIMIT = 200;
const TRANSCRIPT_DEFAULT_LIMIT = 2000;
const TRANSCRIPT_MAX_LIMIT = 10000;
const TRANSCRIPT_DEFAULT_IDLE_MS = 1500;
const TRANSCRIPT_MAX_IDLE_MS = 10000;
const TRANSCRIPT_WALL_MS = 30000;
const TRANSCRIPT_PROBE_MS = 3000;
const MODEL_CALLS_DEFAULT_LIMIT = 200;
const MODEL_CALLS_MAX_LIMIT = 1000;
const MODEL_CALLS_MAX_LIMIT_WITH_BODY = 25;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

async function authorizeRead(req: Request): Promise<EveSessionAuth | Response> {
  const entries = await readTokenEntries();
  if (entries.length === 0) return new Response("not found", { status: 404 });
  return routeAuth(req, serviceTokenAuth(entries));
}

export async function handleUsageWindowRead(req: Request): Promise<Response> {
  const identity = await authorizeRead(req);
  if (identity instanceof Response) return identity;

  const url = new URL(req.url);
  const since = (url.searchParams.get("since") ?? "").trim();
  const workspaces = (url.searchParams.get("workspaces") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!since || workspaces.length === 0) {
    return json(400, { error: 'expected query params: since=<ISO-8601 timestamp> and workspaces=<comma-separated "platform/workspace" keys>' });
  }
  const sessionStartedAfter = (url.searchParams.get("sessionStartedAfter") ?? "").trim() || undefined;

  await appendAudit({
    org: deploymentOrg(),
    platform: "control",
    workspace: "control",
    principalId: identity.principalId,
    action: "control.service_call",
    detail: { service: identity.principalId, view: "usage_window", since, workspaces: workspaces.join(","), ...(sessionStartedAfter ? { sessionStartedAfter } : {}) },
  });

  try {
    return json(200, await usageWindowView({ sinceIso: since, workspaceKeys: workspaces, ...(sessionStartedAfter ? { sessionStartedAfter } : {}) }));
  } catch (err) {
    return json(400, { error: err instanceof Error ? err.message : String(err) });
  }
}

export async function handleToolUsageRead(req: Request): Promise<Response> {
  const identity = await authorizeRead(req);
  if (identity instanceof Response) return identity;

  const url = new URL(req.url);
  const since = (url.searchParams.get("since") ?? "").trim();
  const until = (url.searchParams.get("until") ?? "").trim() || undefined;
  const domain = (url.searchParams.get("domain") ?? "").trim() || undefined;
  const byRaw = (url.searchParams.get("by") ?? "").trim() || undefined;
  if (!since) return json(400, { error: "expected query param: since=<ISO-8601 timestamp> (optional: until, domain, by=connector|tool)" });
  if (byRaw !== undefined && byRaw !== "connector" && byRaw !== "tool") return json(400, { error: 'by must be "connector" or "tool"' });
  const by = byRaw as "connector" | "tool" | undefined;
  const org = deploymentOrg();

  await appendAudit({
    org,
    platform: "control",
    workspace: "control",
    principalId: identity.principalId,
    action: "control.service_call",
    detail: { service: identity.principalId, view: "tool_usage", since, ...(until ? { until } : {}), ...(domain ? { domain } : {}), ...(by ? { by } : {}) },
  });

  try {
    return json(200, await toolUsageView({ org, sinceIso: since, ...(until ? { untilIso: until } : {}), ...(domain ? { domain } : {}), ...(by ? { by } : {}) }));
  } catch (err) {
    return json(400, { error: err instanceof Error ? err.message : String(err) });
  }
}

export async function handleAuditWindowRead(req: Request): Promise<Response> {
  const identity = await authorizeRead(req);
  if (identity instanceof Response) return identity;

  const url = new URL(req.url);
  const p = (name: string): string | undefined => {
    const v = (url.searchParams.get(name) ?? "").trim();
    return v.length > 0 ? v : undefined;
  };
  const since = p("since");
  if (!since) return json(400, { error: "expected query param: since=<ISO-8601 timestamp> (the audit-window lower bound)" });
  if (Number.isNaN(Date.parse(since))) {
    return json(400, { error: `since "${since}" is not a parseable ISO-8601 timestamp (e.g. "2026-07-11T12:00:00Z")` });
  }
  const until = p("until");
  if (until !== undefined) {
    if (Number.isNaN(Date.parse(until))) {
      return json(400, { error: `until "${until}" is not a parseable ISO-8601 timestamp (e.g. "2026-07-11T12:00:00Z")` });
    }
    if (Date.parse(until) < Date.parse(since)) {
      return json(400, { error: `until "${until}" is before since "${since}" — the window is empty (both bounds are inclusive)` });
    }
  }
  const sinceIso = new Date(since).toISOString();
  const untilIso = until === undefined ? undefined : new Date(until).toISOString();
  const limitRaw = p("limit");
  let limit = AUDIT_DEFAULT_LIMIT;
  if (limitRaw !== undefined) {
    const n = Number.parseInt(limitRaw, 10);
    if (!Number.isInteger(n) || n <= 0) return json(400, { error: `limit "${limitRaw}" must be a positive integer` });
    limit = Math.min(n, AUDIT_MAX_LIMIT);
  }
  const actions = [
    ...new Set(
      (p("actions") ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ];
  if (actions.length > AUDIT_MAX_ACTIONS) {
    return json(400, {
      error: `actions names ${actions.length} distinct actions, more than the ${AUDIT_MAX_ACTIONS} this route scans in one request — ask for fewer, or drop the filter and match the rows yourself`,
    });
  }
  const base: AuditFilter = {
    org: deploymentOrg(),
    since: sinceIso,
    ...(untilIso !== undefined ? { until: untilIso } : {}),
    ...(p("platform") ? { platform: p("platform") } : {}),
    ...(p("workspace") ? { workspace: p("workspace") } : {}),
    ...(p("surface") ? { surface: p("surface") } : {}),
    ...(p("principalId") ? { principalId: p("principalId") } : {}),
  };

  await appendAudit({
    org: deploymentOrg(),
    platform: "control",
    workspace: "control",
    principalId: identity.principalId,
    action: "control.service_call",
    detail: { service: identity.principalId, view: "audit", since: sinceIso, until: untilIso ?? "", actions: actions.join(","), platform: base.platform ?? "", limit },
  });

  try {
    if (actions.length <= 1) {
      const view = await auditView({ ...base, ...(actions.length === 1 ? { action: actions[0] } : {}), limit });
      return json(200, { ...view, maxLimit: AUDIT_MAX_LIMIT });
    }
    const views = await Promise.all(actions.map((action) => auditView({ ...base, action, limit: AUDIT_MAX_LIMIT })));
    const scanTruncated = views.some((v) => v.entries.length >= AUDIT_MAX_LIMIT);
    const scanned = views.reduce((n, v) => n + v.entries.length, 0);
    const merged = views
      .flatMap((v) => v.entries)
      .sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : b.seq - a.seq))
      .slice(0, limit);
    return json(200, {
      root: views[0]!.root,
      filter: { ...base, limit },
      entries: merged,
      capped: merged.length === limit || scanTruncated,
      maxLimit: AUDIT_MAX_LIMIT,
      ...(scanTruncated ? { scanTruncated: true, scanned } : {}),
    });
  } catch (err) {
    return json(400, { error: err instanceof Error ? err.message : String(err) });
  }
}

export async function handleUnifiedAuditRead(req: Request): Promise<Response> {
  const identity = await authorizeRead(req);
  if (identity instanceof Response) return identity;

  const url = new URL(req.url);
  const domain = (url.searchParams.get("domain") ?? "").trim();
  if (!domain) return json(400, { error: "expected query param: domain=<domain name>" });
  const sinceDaysRaw = (url.searchParams.get("sinceDays") ?? "").trim();
  let sinceDays: number | undefined;
  if (sinceDaysRaw.length > 0) {
    const n = Number.parseInt(sinceDaysRaw, 10);
    if (!Number.isInteger(n) || n <= 0 || n > 365) return json(400, { error: `sinceDays "${sinceDaysRaw}" must be a positive integer ≤ 365` });
    sinceDays = n;
  }

  await appendAudit({
    org: deploymentOrg(),
    platform: "control",
    workspace: "control",
    principalId: identity.principalId,
    action: "control.service_call",
    detail: { service: identity.principalId, view: "unified_domain_audit", domain, sinceDays: sinceDays ?? 30 },
  });

  try {
    return json(200, await unifiedDomainAudit({ domain, org: deploymentOrg(), ...(sinceDays ? { sinceDays } : {}) }));
  } catch (err) {
    return json(400, { error: err instanceof Error ? err.message : String(err) });
  }
}

export async function handleRuntimeSignalRead(req: Request): Promise<Response> {
  const identity = await authorizeRead(req);
  if (identity instanceof Response) return identity;

  const hasDeploymentId = (process.env.VERCEL_DEPLOYMENT_ID ?? "").trim().length > 0;
  const credentialBrokerArmed = credentialKeyArmed();

  await appendAudit({
    org: deploymentOrg(),
    platform: "control",
    workspace: "control",
    principalId: identity.principalId,
    action: "control.service_call",
    detail: { service: identity.principalId, view: "runtime_signal", hasDeploymentId, credentialBrokerArmed },
  });

  return json(200, { hasDeploymentId, credentialBrokerArmed });
}

export interface TranscriptEvent {
  /** The event's stored line: `startIndex` and `nextIndex` count lines, and one line can hold several events. */
  readonly index: number;
  readonly at: string | null;
  readonly type: string;
  readonly data: unknown;
  /** What the event belongs to: its turn, model run, task or context change (eve's `scope`). */
  readonly scope?: TranscriptEventScope;
}

export interface TranscriptEventScope {
  readonly turnId?: string;
  readonly runId?: string;
  readonly taskId?: string;
  readonly changeId?: string;
}

export interface SourceStreamEvent {
  readonly type: string;
  readonly data?: unknown;
  readonly scope?: TranscriptEventScope;
  readonly meta?: {
    readonly at?: string;
    readonly position?: { readonly line: number; readonly index: number };
    readonly endOfLine?: boolean;
    readonly next?: number;
  };
}

export interface SessionStreamDrain {
  readonly events: TranscriptEvent[];
  readonly complete: boolean;
  /** The first line the next read starts at. A partly read line is never committed, so it is read again whole. */
  readonly nextIndex: number;
}

/** The stream failed before it yielded its first event: the session's record is gone or unreadable. */
export class SessionStreamOpenError extends Error {}

function nonNegIntParam(raw: string | null, def: number): number | null {
  const v = (raw ?? "").trim();
  if (v.length === 0) return def;
  const n = Number.parseInt(v, 10);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

function posIntCappedParam(raw: string | null, def: number, cap: number): number | null {
  const v = (raw ?? "").trim();
  if (v.length === 0) return def;
  const n = Number.parseInt(v, 10);
  if (!Number.isInteger(n) || n <= 0) return null;
  return Math.min(n, cap);
}

/**
 * Reads a session's recorded stream from line `startIndex` until `maxEvents`, an idle gap, the wall
 * budget, the stream's end or `session.ended`. Only `session.ended` marks the read `complete`: a
 * stream opened with `follow: false` also ends at the durable tail of a session that is still open. `open` receives the signal that stops the read, and
 * the drain aborts it on exit: a pending read never holds the request open.
 */
export async function drainSessionStream(
  open: (signal: AbortSignal) => AsyncIterable<SourceStreamEvent>,
  startIndex: number,
  maxEvents: number,
  idleMs: number,
): Promise<SessionStreamDrain> {
  const stop = new AbortController();
  let iterator: AsyncIterator<SourceStreamEvent>;
  try {
    iterator = open(stop.signal)[Symbol.asyncIterator]();
  } catch (err) {
    throw new SessionStreamOpenError(err instanceof Error ? err.message : String(err));
  }
  const events: TranscriptEvent[] = [];
  let line: TranscriptEvent[] = [];
  let lineEndsSession = false;
  let nextIndex = startIndex;
  let complete = false;
  let opened = false;
  const deadline = Date.now() + TRANSCRIPT_WALL_MS;
  try {
    while (events.length < maxEvents) {
      const budget = Math.min(idleMs, deadline - Date.now());
      if (budget <= 0) break;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const idle = new Promise<"idle">((resolve) => {
        timer = setTimeout(() => resolve("idle"), budget);
      });
      let next: IteratorResult<SourceStreamEvent> | "idle";
      try {
        next = await Promise.race([iterator.next(), idle]);
      } catch (err) {
        if (!opened) throw new SessionStreamOpenError(err instanceof Error ? err.message : String(err));
        throw err;
      } finally {
        if (timer) clearTimeout(timer);
      }
      if (next === "idle") break;
      opened = true;
      if (next.done) break;
      const ev = next.value;
      const lineNo = ev.meta?.position?.line ?? nextIndex;
      line.push({ index: lineNo, at: ev.meta?.at ?? null, type: ev.type, data: ev.data ?? null, ...(ev.scope !== undefined ? { scope: ev.scope } : {}) });
      if (ev.type === "session.ended") lineEndsSession = true;
      if (ev.meta?.endOfLine === false) continue;
      events.push(...line);
      line = [];
      nextIndex = Math.max(nextIndex, ev.meta?.next ?? lineNo + 1);
      if (lineEndsSession) {
        complete = true;
        break;
      }
    }
  } finally {
    stop.abort();
    try {
      iterator.return?.().catch(() => undefined);
    } catch {
      // A stream that refuses to close is already aborted by the signal.
    }
  }
  return { events, complete, nextIndex };
}

export type SessionExistence = "found" | "missing" | "unknown";

export interface ProbeableSession {
  getStreamTailIndex?: () => Promise<number>;
}

export async function probeSessionExists(session: ProbeableSession, budgetMs: number): Promise<SessionExistence> {
  const probe = session.getStreamTailIndex;
  if (typeof probe !== "function") return "unknown";
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const answered: Promise<SessionExistence> = Promise.resolve()
      .then(async () => await probe.call(session))
      .then(
        (tail) => (typeof tail === "number" && tail >= 0 ? "found" : "missing"),
        () => "missing",
      );
    const timedOut = new Promise<SessionExistence>((resolve) => {
      timer = setTimeout(() => resolve("unknown"), budgetMs);
    });
    return await Promise.race([answered, timedOut]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function transcriptNotFound(sessionId: string): Response {
  const classified = classifySessionId(sessionId);
  const hint =
    classified.kind === "native"
      ? undefined
      : `that looks like an OE channel continuation token (kind: ${classified.kind}), not a durable eve session id — ` +
        `this route takes the id stamped on audit rows as detail.sessionId (GET /control/v1/audit), e.g. "wrun_…"`;
  return json(404, { error: "no such session", found: false, sessionId, ...(hint ? { hint } : {}) });
}

export async function handleSessionTranscriptRead(
  req: Request,
  attachSession: AttachSessionFn,
  params: Readonly<Record<string, string>>,
): Promise<Response> {
  const identity = await authorizeRead(req);
  if (identity instanceof Response) return identity;

  const sessionId = (params["sessionId"] ?? "").trim();
  if (!sessionId) return json(400, { error: "expected path param: sessionId" });

  const url = new URL(req.url);
  const startIndex = nonNegIntParam(url.searchParams.get("startIndex"), 0);
  if (startIndex === null) return json(400, { error: "startIndex must be a non-negative integer" });
  const limit = posIntCappedParam(url.searchParams.get("limit"), TRANSCRIPT_DEFAULT_LIMIT, TRANSCRIPT_MAX_LIMIT);
  if (limit === null) return json(400, { error: `limit must be a positive integer (≤ ${TRANSCRIPT_MAX_LIMIT})` });
  const idleMs = posIntCappedParam(url.searchParams.get("idleMs"), TRANSCRIPT_DEFAULT_IDLE_MS, TRANSCRIPT_MAX_IDLE_MS);
  if (idleMs === null) return json(400, { error: `idleMs must be a positive integer (≤ ${TRANSCRIPT_MAX_IDLE_MS})` });

  await appendAudit({
    org: deploymentOrg(),
    platform: "control",
    workspace: "control",
    principalId: identity.principalId,
    action: "control.service_call",
    detail: { service: identity.principalId, view: "transcript", sessionId, startIndex, limit },
  });

  const session = attachSession(sessionId);

  const existence = await probeSessionExists(session as ProbeableSession, TRANSCRIPT_PROBE_MS);
  if (existence === "missing") return transcriptNotFound(sessionId);

  try {
    const { events, complete, nextIndex } = await drainSessionStream(
      (signal) => session.stream({ startIndex, follow: false, signal }) as AsyncIterable<SourceStreamEvent>,
      startIndex,
      limit,
      idleMs,
    );
    if (existence === "unknown" && events.length === 0 && startIndex === 0) return transcriptNotFound(sessionId);
    return json(200, { sessionId, found: true, startIndex, nextIndex, complete, count: events.length, events });
  } catch (err) {
    if (err instanceof SessionStreamOpenError) return transcriptNotFound(sessionId);
    return json(400, { error: err instanceof Error ? err.message : String(err) });
  }
}

export async function handleSessionModelCallsRead(req: Request, params: Readonly<Record<string, string>>): Promise<Response> {
  const identity = await authorizeRead(req);
  if (identity instanceof Response) return identity;

  const sessionId = (params["sessionId"] ?? "").trim();
  if (!sessionId) return json(400, { error: "expected path param: sessionId" });

  const url = new URL(req.url);
  const rawBody = (url.searchParams.get("body") ?? "").trim();
  const includeBody = rawBody === "" ? true : rawBody === "1" || rawBody.toLowerCase() === "true";
  const cap = includeBody ? MODEL_CALLS_MAX_LIMIT_WITH_BODY : MODEL_CALLS_MAX_LIMIT;
  const limit = posIntCappedParam(url.searchParams.get("limit"), Math.min(MODEL_CALLS_DEFAULT_LIMIT, cap), cap);
  if (limit === null) return json(400, { error: `limit must be a positive integer (≤ ${cap} for this body mode)` });
  const turnId = (url.searchParams.get("turnId") ?? "").trim() || undefined;

  await appendAudit({
    org: deploymentOrg(),
    platform: "control",
    workspace: "control",
    principalId: identity.principalId,
    action: "control.service_call",
    detail: { service: identity.principalId, view: "model_calls", sessionId, limit, includeBody, ...(turnId ? { turnId } : {}) },
  });

  try {
    const captures = await getOperationalStore().modelCallCapturesForSession(deploymentOrg(), sessionId, { includeBody, limit, ...(turnId ? { turnId } : {}) });
    return json(200, { sessionId, count: captures.length, includeBody, captures });
  } catch (err) {
    return json(400, { error: err instanceof Error ? err.message : String(err) });
  }
}

export async function handleModelCallSessionsRead(req: Request): Promise<Response> {
  const identity = await authorizeRead(req);
  if (identity instanceof Response) return identity;

  await appendAudit({
    org: deploymentOrg(),
    platform: "control",
    workspace: "control",
    principalId: identity.principalId,
    action: "control.service_call",
    detail: { service: identity.principalId, view: "model_call_sessions" },
  });

  try {
    const sessions = await getOperationalStore().modelCallCaptureSessions(deploymentOrg());
    return json(200, { count: sessions.length, sessions });
  } catch (err) {
    return json(400, { error: err instanceof Error ? err.message : String(err) });
  }
}
