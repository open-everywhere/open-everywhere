import { registerPreflightProbe, type Check } from "@open-everywhere/core/agent/adapter-api.js";
import { boundaryOfGraphToken, TENANT_WIDE_CHANNEL_READ_ROLES, type TeamsReadBoundary } from "./channels/teams-graph-boundary.js";

const TOKEN_LOGIN_BASE = "https://login.microsoftonline.com";
const GRAPH_TOKEN_SCOPE = "https://graph.microsoft.com/.default";
const PROBE_TIMEOUT_MS = 10_000;

const CHECK_NAME = "teams: channel-read boundary";

const pick = (env: NodeJS.ProcessEnv, ...keys: string[]): string | undefined => {
  for (const k of keys) {
    const v = env[k];
    if (v !== undefined && v !== "") return v;
  }
  return undefined;
};

async function mintGraphTokenFromEnv(appId: string, appPassword: string, tenantId: string): Promise<string> {
  const body = new URLSearchParams({ client_id: appId, client_secret: appPassword, grant_type: "client_credentials", scope: GRAPH_TOKEN_SCOPE });
  const res = await fetch(`${TOKEN_LOGIN_BASE}/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  });
  const json = (await res.json().catch(() => ({}))) as { access_token?: string; error?: string; error_description?: string };
  if (!res.ok || !json.access_token) {
    throw new Error(json.error_description ?? json.error ?? `HTTP ${res.status}`);
  }
  return json.access_token;
}

export function boundaryCheck(boundary: TeamsReadBoundary): Check {
  if (boundary === "tenant-wide") {
    return {
      name: CHECK_NAME,
      status: "info",
      detail:
        "TENANT-WIDE — the app registration holds a Graph application permission that reads EVERY channel message in the tenant. " +
        "Microsoft applies no per-team check, so the domain allowlist in memory/domains.ts is the ONLY fence on cross-team reads.",
      fix:
        `harden: remove ${TENANT_WIDE_CHANNEL_READ_ROLES.join(" / ")} from the Entra app registration and grant the per-team RSC ` +
        "permission ChannelMessage.Read.Group instead (install the Teams app into each team) — docs/deploy/surfaces/teams.md",
    };
  }
  if (boundary === "per-team") {
    return {
      name: CHECK_NAME,
      status: "ok",
      detail:
        "per-team — no tenant-wide Graph permission is consented, so Microsoft evaluates the ChannelMessage.Read.Group RSC grant " +
        "per request. A read outside a team the app is installed in fails at Microsoft, before Open Everywhere's own fence.",
    };
  }
  return {
    name: CHECK_NAME,
    status: "info",
    detail: "could not determine — the Graph token minted but its claims did not parse.",
    fix: "check the app registration's consented Graph application permissions by hand — docs/deploy/surfaces/teams.md",
  };
}

export async function teamsBoundaryProbe(env: NodeJS.ProcessEnv): Promise<readonly Check[]> {
  const appId = pick(env, "MICROSOFT_APP_ID", "TEAMS_APP_ID");
  const appPassword = pick(env, "MICROSOFT_APP_PASSWORD", "TEAMS_APP_PASSWORD");
  const tenantId = pick(env, "MICROSOFT_TENANT_ID", "TEAMS_TENANT_ID");
  if (!appId || !appPassword) return [];
  if (!tenantId) {
    return [
      {
        name: CHECK_NAME,
        status: "info",
        detail: "not determined — MICROSOFT_TENANT_ID (or TEAMS_TENANT_ID) is unset, and Graph's client-credential token is tenant-scoped.",
        fix: "set MICROSOFT_TENANT_ID to the Directory (tenant) ID — docs/deploy/surfaces/teams.md",
      },
    ];
  }
  let token: string;
  try {
    token = await mintGraphTokenFromEnv(appId, appPassword, tenantId);
  } catch (err) {
    return [
      {
        name: CHECK_NAME,
        status: "info",
        detail: `not determined — the Graph token mint failed: ${err instanceof Error ? err.message : String(err)}`,
        fix: "check MICROSOFT_APP_ID / MICROSOFT_APP_PASSWORD / MICROSOFT_TENANT_ID and network reachability of login.microsoftonline.com",
      },
    ];
  }
  return [boundaryCheck(boundaryOfGraphToken(token))];
}

export function registerTeamsOps(): void {
  registerPreflightProbe("teams", teamsBoundaryProbe);
}
