import type { GetSessionFn } from "eve/channels";
import { parseServiceTokenEntries, verifyServiceToken } from "./auth.js";
import { auditView, usageWindowView, unifiedDomainAudit } from "./views.js";
import { appendAudit } from "../audit/audit.js";
import type { AuditFilter } from "../audit/audit.js";
import { deploymentOrg } from "../identity/binding.js";

export const CONTROL_READ_USAGE_PATH = "/control/v1/usage";
export const CONTROL_READ_AUDIT_PATH = "/control/v1/audit";
export const CONTROL_READ_UNIFIED_AUDIT_PATH = "/control/v1/unified-audit";
export const CONTROL_READ_TRANSCRIPT_PATH = "/control/v1/session/:sessionId/transcript";
export const CONTROL_READ_CONNECT_PROBE_PATH = "/control/v1/connect-probe";
const AUDIT_MAX_LIMIT = 1000;
const AUDIT_DEFAULT_LIMIT = 200;
const TRANSCRIPT_DEFAULT_LIMIT = 2000;
const TRANSCRIPT_MAX_LIMIT = 10000;
const TRANSCRIPT_DEFAULT_IDLE_MS = 1500;
const TRANSCRIPT_MAX_IDLE_MS = 10000;
const TRANSCRIPT_WALL_MS = 30000;

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

interface SourceStreamEvent {
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

async function drainSessionStream(
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

export async function handleSessionTranscriptRead(
  req: Request,
  getSession: GetSessionFn,
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

  let stream: ReadableStream<SourceStreamEvent>;
  try {
    stream = (await getSession(sessionId).getEventStream({ startIndex })) as unknown as ReadableStream<SourceStreamEvent>;
  } catch {
    return new Response("not found", { status: 404 });
  }

  try {
    const { events, complete } = await drainSessionStream(stream, startIndex, limit, idleMs);
    return json(200, { sessionId, startIndex, nextIndex: startIndex + events.length, complete, count: events.length, events });
  } catch (err) {
    return json(400, { error: err instanceof Error ? err.message : String(err) });
  }
}

function decodeJwtClaims(token: string): Record<string, unknown> | undefined {
  try {
    const payload = token.split(".")[1];
    if (!payload) return undefined;
    return JSON.parse(Buffer.from(payload, "base64url").toString()) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

export async function handleConnectProbeRead(req: Request): Promise<Response> {
  const entries = parseServiceTokenEntries(process.env.OE_CONTROL_READ_TOKENS);
  if (entries.length === 0) return new Response("not found", { status: 404 });
  const match = /^Bearer\s+(.+)$/i.exec((req.headers.get("authorization") ?? "").trim());
  const identity = match ? verifyServiceToken(match[1], entries) : null;
  if (!identity) return json(401, { error: "unauthorized: missing or invalid bearer token" });

  const url = new URL(req.url);
  const subjectId = (url.searchParams.get("subject") ?? "").trim();
  const connector = (url.searchParams.get("connector") ?? "notion.so/open-everywhere").trim();
  if (!subjectId) return json(400, { error: "expected query param: subject=<user subject id>" });

  await appendAudit({
    org: deploymentOrg(),
    platform: "control",
    workspace: "control",
    principalId: identity.subject,
    action: "control.service_call",
    detail: { service: identity.subject, view: "connect_probe", connector, subject: subjectId },
  });

  let oidc: Record<string, unknown> | undefined;
  let oidcSource = "none";
  try {
    const mod = (await import("@vercel/" + "oidc")) as { getVercelOidcToken?: () => Promise<string> };
    if (mod.getVercelOidcToken) {
      oidc = decodeJwtClaims(await mod.getVercelOidcToken());
      oidcSource = "sdk";
    }
  } catch {
  }
  if (!oidc && process.env.VERCEL_OIDC_TOKEN) {
    oidc = decodeJwtClaims(process.env.VERCEL_OIDC_TOKEN);
    oidcSource = "env";
  }
  const claims = oidc
    ? { environment: oidc.environment, sub: oidc.sub, project: oidc.project, owner: oidc.owner }
    : undefined;

  let probe: Record<string, unknown>;
  let verify: Record<string, unknown> | undefined;
  try {
    const connect = (await import("@vercel/" + "connect")) as {
      getTokenResponse: (c: string, p: unknown, o?: unknown) => Promise<{ token: string }>;
    };
    const r = await connect.getTokenResponse(connector, { subject: { type: "user", id: subjectId } }, { forceRefresh: true });
    probe = { outcome: "ok", tokenLength: r.token.length };
    const mode = (url.searchParams.get("verify") ?? "").trim();
    if (mode === "api") {
      const res = await fetch("https://api.notion.com/v1/users/me", {
        headers: { Authorization: `Bearer ${r.token}`, "Notion-Version": "2022-06-28" },
      });
      verify = { target: "api.notion.com/v1/users/me", status: res.status };
    } else if (mode === "mcp") {
      const res = await fetch("https://mcp.notion.com/mcp", {
        method: "POST",
        headers: { Authorization: `Bearer ${r.token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "oe-probe", version: "0" } } }),
      });
      verify = { target: "mcp.notion.com/mcp initialize", status: res.status };
    } else if (mode === "sse") {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 5000);
      try {
        const res = await fetch("https://mcp.notion.com/sse", {
          headers: { Authorization: `Bearer ${r.token}`, accept: "text/event-stream" },
          signal: ac.signal,
        });
        verify = { target: "mcp.notion.com/sse", status: res.status };
        await res.body?.cancel().catch(() => undefined);
      } finally {
        clearTimeout(timer);
      }
    }
  } catch (err) {
    probe = {
      outcome: "error",
      name: err instanceof Error ? err.name : "unknown",
      message: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200),
    };
  }
  return json(200, { connector, subject: subjectId, oidcSource, claims, probe, ...(verify ? { verify } : {}) });
}
