import { parseServiceTokenEntries, verifyServiceToken } from "./auth.js";
import { usageWindowView } from "./views.js";
import { appendAudit } from "../audit/audit.js";
import { deploymentOrg } from "../identity/binding.js";

export const CONTROL_READ_USAGE_PATH = "/control/v1/usage";

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
