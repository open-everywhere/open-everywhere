import { resolveTeamsAccessToken } from "eve/channels/teams";
import { withRetryAfter, type RateLimitRetryOptions } from "@open-everywhere/core/agent/adapter-api.js";

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
  const send = (): Promise<Response> =>
    (deps.fetch ?? (globalThis.fetch as TeamsFetchLike))(`${trimTrailingSlash(input.serviceUrl)}${input.path}`, {
      method: input.method ?? "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json; charset=utf-8" },
      ...(input.body !== undefined ? { body: JSON.stringify(input.body) } : {}),
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
