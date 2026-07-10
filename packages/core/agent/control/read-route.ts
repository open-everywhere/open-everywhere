import { parseServiceTokenEntries, verifyServiceToken } from "./auth.js";
import { auditView, usageWindowView } from "./views.js";
import { appendAudit } from "../audit/audit.js";
import type { AuditFilter } from "../audit/audit.js";
import { deploymentOrg } from "../identity/binding.js";

export const CONTROL_READ_USAGE_PATH = "/control/v1/usage";
export const CONTROL_READ_AUDIT_PATH = "/control/v1/audit";
const AUDIT_MAX_LIMIT = 1000;
const AUDIT_DEFAULT_LIMIT = 200;

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
    org: p("org") ?? deploymentOrg(),
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
