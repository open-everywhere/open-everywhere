import type { AttachSessionFn } from "eve/channels";
import { classifySessionId } from "../channels/window-key.js";
import { parseServiceTokenEntries, verifyServiceToken } from "./auth.js";
import { auditView, usageWindowView, unifiedDomainAudit } from "./views.js";
import { appendAudit } from "../audit/audit.js";
import type { AuditFilter } from "../audit/audit.js";
import { deploymentOrg } from "../identity/binding.js";

export const CONTROL_READ_USAGE_PATH = "/control/v1/usage";
export const CONTROL_READ_AUDIT_PATH = "/control/v1/audit";
export const CONTROL_READ_UNIFIED_AUDIT_PATH = "/control/v1/unified-audit";
export const CONTROL_READ_TRANSCRIPT_PATH = "/control/v1/session/:sessionId/transcript";
const AUDIT_MAX_LIMIT = 1000;
const AUDIT_DEFAULT_LIMIT = 200;
const TRANSCRIPT_DEFAULT_LIMIT = 2000;
const TRANSCRIPT_MAX_LIMIT = 10000;
const TRANSCRIPT_DEFAULT_IDLE_MS = 1500;
const TRANSCRIPT_MAX_IDLE_MS = 10000;
const TRANSCRIPT_WALL_MS = 30000;
const TRANSCRIPT_PROBE_MS = 3000;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export async function handleUsageWindowRead(req: Request): Promise<Response> {
  const entries = parseServiceTokenEntries(process.env.OE_CONTROL_READ_TOKENS);
  if (entries.length === 0) return new Response("not found", { status: 404 });

  const match = /^Bearer\s+(.+)$/i.exec((req.headers.get("authorization") ?? "").trim());
  const identity = match ? verifyServiceToken(match[1], entries) : null;
  if (!identity) return json(401, { error: "unauthorized: missing or invalid bearer token" });

  const url = new URL(req.url);
  const since = (url.searchParams.get("since") ?? "").trim();
  const workspaces = (url.searchParams.get("workspaces") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!since || workspaces.length === 0) {
    return json(400, { error: 'expected query params: since=<ISO-8601 timestamp> and workspaces=<comma-separated "platform/workspace" keys>' });
  }

  await appendAudit({
    org: deploymentOrg(),
    platform: "control",
    workspace: "control",
    principalId: identity.subject,
    action: "control.service_call",
    detail: { service: identity.subject, view: "usage_window", since, workspaces: workspaces.join(",") },
  });

  try {
    return json(200, await usageWindowView({ sinceIso: since, workspaceKeys: workspaces }));
  } catch (err) {
    return json(400, { error: err instanceof Error ? err.message : String(err) });
  }
}

export async function handleAuditWindowRead(req: Request): Promise<Response> {
  const entries = parseServiceTokenEntries(process.env.OE_CONTROL_READ_TOKENS);
  if (entries.length === 0) return new Response("not found", { status: 404 });

  const match = /^Bearer\s+(.+)$/i.exec((req.headers.get("authorization") ?? "").trim());
  const identity = match ? verifyServiceToken(match[1], entries) : null;
  if (!identity) return json(401, { error: "unauthorized: missing or invalid bearer token" });

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
  const limitRaw = p("limit");
  let limit = AUDIT_DEFAULT_LIMIT;
  if (limitRaw !== undefined) {
    const n = Number.parseInt(limitRaw, 10);
    if (!Number.isInteger(n) || n <= 0) return json(400, { error: `limit "${limitRaw}" must be a positive integer` });
    limit = Math.min(n, AUDIT_MAX_LIMIT);
  }
  const actions = (p("actions") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const base: AuditFilter = {
    org: deploymentOrg(),
    since,
    ...(p("platform") ? { platform: p("platform") } : {}),
    ...(p("workspace") ? { workspace: p("workspace") } : {}),
    ...(p("surface") ? { surface: p("surface") } : {}),
    ...(p("principalId") ? { principalId: p("principalId") } : {}),
  };

  await appendAudit({
    org: deploymentOrg(),
    platform: "control",
    workspace: "control",
    principalId: identity.subject,
    action: "control.service_call",
    detail: { service: identity.subject, view: "audit", since, actions: actions.join(","), platform: base.platform ?? "", limit },
  });

  try {
    if (actions.length <= 1) {
      const view = await auditView({ ...base, ...(actions.length === 1 ? { action: actions[0] } : {}), limit });
      return json(200, view);
    }
    const view = await auditView({ ...base, limit: AUDIT_MAX_LIMIT });
    const wanted = new Set(actions);
    const filtered = view.entries.filter((e) => wanted.has(e.action)).slice(0, limit);
    return json(200, { ...view, filter: { ...view.filter, limit }, entries: filtered, capped: filtered.length === limit });
  } catch (err) {
    return json(400, { error: err instanceof Error ? err.message : String(err) });
  }
}

export async function handleUnifiedAuditRead(req: Request): Promise<Response> {
  const entries = parseServiceTokenEntries(process.env.OE_CONTROL_READ_TOKENS);
  if (entries.length === 0) return new Response("not found", { status: 404 });

  const match = /^Bearer\s+(.+)$/i.exec((req.headers.get("authorization") ?? "").trim());
  const identity = match ? verifyServiceToken(match[1], entries) : null;
  if (!identity) return json(401, { error: "unauthorized: missing or invalid bearer token" });

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
    principalId: identity.subject,
    action: "control.service_call",
    detail: { service: identity.subject, view: "unified_domain_audit", domain, sinceDays: sinceDays ?? 30 },
  });

  try {
    return json(200, await unifiedDomainAudit({ domain, org: deploymentOrg(), ...(sinceDays ? { sinceDays } : {}) }));
  } catch (err) {
    return json(400, { error: err instanceof Error ? err.message : String(err) });
  }
}

export interface TranscriptEvent {
  readonly index: number;
  readonly at: string | null;
  readonly type: string;
  readonly data: unknown;
}

export interface SourceStreamEvent {
  readonly type: string;
  readonly data?: unknown;
  readonly meta?: { readonly at?: string };
}

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

export async function drainSessionStream(
  stream: ReadableStream<SourceStreamEvent>,
  startIndex: number,
  maxEvents: number,
  idleMs: number,
): Promise<{ events: TranscriptEvent[]; complete: boolean }> {
  const reader = stream.getReader();
  const events: TranscriptEvent[] = [];
  let complete = false;
  const deadline = Date.now() + TRANSCRIPT_WALL_MS;
  try {
    while (events.length < maxEvents) {
      const budget = Math.min(idleMs, deadline - Date.now());
      if (budget <= 0) break;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const idle = new Promise<"idle">((resolve) => {
        timer = setTimeout(() => resolve("idle"), budget);
      });
      const next = await Promise.race([reader.read(), idle]);
      if (timer) clearTimeout(timer);
      if (next === "idle") break;
      if (next.done) {
        complete = true;
        break;
      }
      const ev = next.value;
      events.push({ index: startIndex + events.length, at: ev.meta?.at ?? null, type: ev.type, data: ev.data ?? null });
      if (ev.type === "session.completed" || ev.type === "session.failed") {
        complete = true;
        break;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return { events, complete };
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

export function transcriptNotFound(sessionId: string): Response {
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
  const entries = parseServiceTokenEntries(process.env.OE_CONTROL_READ_TOKENS);
  if (entries.length === 0) return new Response("not found", { status: 404 });

  const match = /^Bearer\s+(.+)$/i.exec((req.headers.get("authorization") ?? "").trim());
  const identity = match ? verifyServiceToken(match[1], entries) : null;
  if (!identity) return json(401, { error: "unauthorized: missing or invalid bearer token" });

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
    principalId: identity.subject,
    action: "control.service_call",
    detail: { service: identity.subject, view: "transcript", sessionId, startIndex, limit },
  });

  const session = attachSession(sessionId);

  const existence = await probeSessionExists(session as ProbeableSession, TRANSCRIPT_PROBE_MS);
  if (existence === "missing") return transcriptNotFound(sessionId);

  let stream: ReadableStream<SourceStreamEvent>;
  try {
    stream = (await session.getEventStream({ startIndex })) as unknown as ReadableStream<SourceStreamEvent>;
  } catch {
    return transcriptNotFound(sessionId);
  }

  try {
    const { events, complete } = await drainSessionStream(stream, startIndex, limit, idleMs);
    if (existence === "unknown" && events.length === 0 && startIndex === 0) return transcriptNotFound(sessionId);
    return json(200, { sessionId, found: true, startIndex, nextIndex: startIndex + events.length, complete, count: events.length, events });
  } catch (err) {
    return json(400, { error: err instanceof Error ? err.message : String(err) });
  }
}
