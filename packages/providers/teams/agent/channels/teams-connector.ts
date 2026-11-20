import { friendlyTeamsActivity, getSettings, withRetryAfter, type RateLimitRetryOptions } from "@open-everywhere/core/agent/adapter-api.js";
import { resolveTeamsAppId, resolveTeamsAppPassword, resolveTeamsTenantId } from "./teams-credentials.js";

export function teamsAppId(): string | undefined {
  return getSettings().teams.appId || undefined;
}

export function teamsAppCredentials(): { readonly appId: () => string } {
  return {
    appId: () => {
      const id = teamsAppId();
      if (id === undefined) throw new Error("teams.appId is required: set it in agent/settings/settings.ts.");
      return id;
    },
  };
}

export type TeamsFetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface TeamsConnectorDeps {
  readonly fetch?: TeamsFetchLike;
  readonly retry?: Pick<RateLimitRetryOptions, "maxAttempts" | "capMs" | "fallbackMs" | "totalBudgetMs" | "sleep" | "now">;
}

export interface TeamsConnectorResult {
  readonly ok: boolean;
  readonly status: number;
  readonly body: unknown;
}

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

async function parseTeamsResponseBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// The token mint and the Connector read below are adapted from eve 1.0.0-rc.18 (Copyright 2026
// Vercel, Inc. and contributors, Apache-2.0), `src/public/channels/teams/api`. The Open Everywhere
// authors changed them: eve 1.0 no longer exports them, so the seam owns them, and the app id
// comes from the `teams.appId` setting.
const LOGIN_BASE_URL = "https://login.microsoftonline.com";
const BOT_FRAMEWORK_TENANT = "botframework.com";
const BOT_CONNECTOR_SCOPE = "https://api.botframework.com/.default";
const TOKEN_REFRESH_MARGIN_MS = 60_000;
const DEFAULT_TOKEN_LIFETIME_S = 3600;
const accessTokenCache = new Map<string, { readonly accessToken: string; readonly expiresAt: number }>();

/** Drops every cached Bot Connector token. Tests only. */
export function _resetTeamsAccessTokenCacheForTest(): void {
  accessTokenCache.clear();
}

/**
 * Mints the Bot Connector access token by the client-credentials flow, as the `teams.appId` app.
 * The token is cached per tenant and app until one minute before it expires.
 */
async function resolveTeamsAccessToken(deps: Pick<TeamsConnectorDeps, "fetch"> = {}): Promise<string> {
  const appId = await resolveTeamsAppId(teamsAppCredentials().appId);
  const appPassword = await resolveTeamsAppPassword();
  const tenant = (await resolveTeamsTenantId()) ?? BOT_FRAMEWORK_TENANT;
  const key = `${LOGIN_BASE_URL}:${tenant}:${appId}`;
  const now = Date.now();
  const cached = accessTokenCache.get(key);
  if (cached !== undefined && cached.expiresAt - TOKEN_REFRESH_MARGIN_MS > now) return cached.accessToken;
  const res = await (deps.fetch ?? (globalThis.fetch as TeamsFetchLike))(`${LOGIN_BASE_URL}/${encodeURIComponent(tenant)}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: appId, client_secret: appPassword, grant_type: "client_credentials", scope: BOT_CONNECTOR_SCOPE }),
  });
  const body = await parseTeamsResponseBody(res);
  if (!res.ok) throw new Error(`Teams access-token request failed with HTTP ${res.status}.`);
  const fields = body !== null && typeof body === "object" ? (body as { access_token?: unknown; expires_in?: unknown }) : {};
  const accessToken = typeof fields.access_token === "string" ? fields.access_token : "";
  if (!accessToken) throw new Error("Teams access-token response did not include access_token.");
  const lifetimeS = typeof fields.expires_in === "number" ? fields.expires_in : DEFAULT_TOKEN_LIFETIME_S;
  accessTokenCache.set(key, { accessToken, expiresAt: now + lifetimeS * 1000 });
  return accessToken;
}

function assertConnectorServiceUrl(serviceUrl: string): void {
  const url = URL.parse(serviceUrl);
  if (url === null || url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    throw new Error("Teams Connector service URL must be an absolute HTTPS URL without credentials, query, or fragment.");
  }
}

/**
 * One Bot Framework Connector call with NO 429 backoff. The provider uses it for READS only (the
 * roster probe, the member directory and the team-details read). A write goes through
 * {@link teamsConnectorWrite}. The service URL must be absolute HTTPS with no credentials, query or
 * fragment, and the call refuses a redirect, so the bearer token reaches no other host.
 */
export async function callTeamsConnectorApi(
  input: { readonly serviceUrl: string; readonly path: string; readonly method?: "GET" | "POST" | "PUT" | "DELETE"; readonly body?: unknown },
  deps: Pick<TeamsConnectorDeps, "fetch"> = {},
): Promise<TeamsConnectorResult> {
  assertConnectorServiceUrl(input.serviceUrl);
  const token = await resolveTeamsAccessToken(deps);
  const res = await (deps.fetch ?? (globalThis.fetch as TeamsFetchLike))(`${trimTrailingSlash(input.serviceUrl)}${input.path}`, {
    method: input.method ?? "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json; charset=utf-8" },
    redirect: "error",
    ...(input.body !== undefined ? { body: JSON.stringify(input.body) } : {}),
  });
  return { ok: res.ok, status: res.status, body: await parseTeamsResponseBody(res) };
}

export async function teamsConnectorWrite(
  input: {
    readonly operation: string;
    readonly serviceUrl: string;
    readonly path: string;
    readonly method?: "GET" | "POST" | "PUT" | "DELETE";
    readonly body?: unknown;
  },
  deps: TeamsConnectorDeps = {},
): Promise<TeamsConnectorResult> {
  const token = await resolveTeamsAccessToken();
  const body = input.body === undefined || input.method === "GET" || input.method === "DELETE" ? input.body : await friendlyTeamsActivity(input.body);
  const send = (): Promise<Response> =>
    (deps.fetch ?? (globalThis.fetch as TeamsFetchLike))(`${trimTrailingSlash(input.serviceUrl)}${input.path}`, {
      method: input.method ?? "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json; charset=utf-8" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  const res = await withRetryAfter(send, { ...deps.retry, surface: "teams", operation: input.operation });
  return { ok: res.ok, status: res.status, body: await parseTeamsResponseBody(res) };
}

function toPostedTeamsActivity(body: unknown): { id: string } {
  const id = body !== null && typeof body === "object" && typeof (body as { id?: unknown }).id === "string" ? (body as { id: string }).id : "";
  return { id };
}

function formatTeamsConnectorErrorBody(body: unknown): string {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  if (text === undefined || text.length === 0) return "empty response body";
  return text.length <= 1000 ? text : `${text.slice(0, 997)}...`;
}

export async function sendTeamsActivityBackedOff(
  input: { readonly serviceUrl: string; readonly conversationId: string; readonly body: unknown },
  deps: TeamsConnectorDeps = {},
): Promise<{ id: string }> {
  const res = await teamsConnectorWrite(
    {
      operation: "conversations.activities.send",
      serviceUrl: input.serviceUrl,
      path: `/v3/conversations/${encodeURIComponent(input.conversationId)}/activities`,
      body: input.body,
    },
    deps,
  );
  if (!res.ok) throw new Error(`Teams send activity failed with HTTP ${res.status}.`);
  return toPostedTeamsActivity(res.body);
}

export async function replyToTeamsActivityBackedOff(
  input: { readonly serviceUrl: string; readonly conversationId: string; readonly activityId: string; readonly body: unknown },
  deps: TeamsConnectorDeps = {},
): Promise<{ id: string }> {
  const res = await teamsConnectorWrite(
    {
      operation: "conversations.activities.reply",
      serviceUrl: input.serviceUrl,
      path: `/v3/conversations/${encodeURIComponent(input.conversationId)}/activities/${encodeURIComponent(input.activityId)}`,
      body: input.body,
    },
    deps,
  );
  if (!res.ok) throw new Error(`Teams reply activity failed with HTTP ${res.status}.`);
  return toPostedTeamsActivity(res.body);
}

export async function updateTeamsActivityBackedOff(
  input: { readonly serviceUrl: string; readonly conversationId: string; readonly activityId: string; readonly body: unknown },
  deps: TeamsConnectorDeps = {},
): Promise<{ id: string }> {
  const res = await teamsConnectorWrite(
    {
      operation: "conversations.activities.update",
      serviceUrl: input.serviceUrl,
      path: `/v3/conversations/${encodeURIComponent(input.conversationId)}/activities/${encodeURIComponent(input.activityId)}`,
      method: "PUT",
      body: input.body,
    },
    deps,
  );
  if (!res.ok) {
    throw new Error(
      `Teams update activity failed with HTTP ${res.status} for conversation "${input.conversationId}" activity "${input.activityId}": ${formatTeamsConnectorErrorBody(res.body)}`,
    );
  }
  return toPostedTeamsActivity(res.body);
}
