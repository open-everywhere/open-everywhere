import { callLinearGraphQL, createLinearAgentActivity, type LinearApiOptions, type LinearFetch } from "eve/channels/linear";
import { withRetryAfter, type RateLimitRetryOptions } from "@open-everywhere/core/agent/adapter-api.js";

export const LINEAR_SURFACE = "linear";

export const LINEAR_ACTIVITY_OPERATION = "AgentActivityCreate";

export type LinearRetryPolicy = Omit<RateLimitRetryOptions, "surface" | "operation">;

export interface LinearApi extends LinearApiOptions {
  readonly retry?: LinearRetryPolicy;
}

export type LinearCallInput = Omit<Parameters<typeof callLinearGraphQL>[0], "api"> & { readonly api?: LinearApi };
export type LinearActivityInput = Omit<Parameters<typeof createLinearAgentActivity>[0], "api"> & { readonly api?: LinearApi };

function baseFetch(api: LinearApi | undefined): LinearFetch {
  return api?.fetch ?? globalThis.fetch;
}

function retryingApi(api: LinearApi | undefined, operation: string): LinearApiOptions {
  const retry = api?.retry;
  const fetchWithRetry: LinearFetch = (input, init) =>
    withRetryAfter(() => baseFetch(api)(input, init), { ...retry, surface: LINEAR_SURFACE, operation });
  return api?.apiBaseUrl === undefined ? { fetch: fetchWithRetry } : { apiBaseUrl: api.apiBaseUrl, fetch: fetchWithRetry };
}

export function callLinear<T>(input: LinearCallInput): Promise<T> {
  return callLinearGraphQL<T>({ ...input, api: retryingApi(input.api, input.queryName) });
}

export function createLinearActivity(input: LinearActivityInput): Promise<{ readonly id: string; readonly success: boolean }> {
  return createLinearAgentActivity({ ...input, api: retryingApi(input.api, LINEAR_ACTIVITY_OPERATION) });
}

export const LINEAR_CHANNEL_OPERATION = "linearChannel";

const GRAPHQL_OPERATION = /(?:^|\n)\s*(?:query|mutation)\s+([A-Za-z_][A-Za-z0-9_]*)/;

export function linearChannelOperation(body: unknown): string {
  if (typeof body !== "string") return LINEAR_CHANNEL_OPERATION;
  try {
    const parsed = JSON.parse(body) as { query?: unknown };
    if (typeof parsed.query !== "string") return LINEAR_CHANNEL_OPERATION;
    return GRAPHQL_OPERATION.exec(parsed.query)?.[1] ?? LINEAR_CHANNEL_OPERATION;
  } catch {
    return LINEAR_CHANNEL_OPERATION;
  }
}

export function linearChannelApi(api?: LinearApi): LinearApiOptions {
  const retry = api?.retry;
  const fetchWithRetry: LinearFetch = (input, init) =>
    withRetryAfter(() => baseFetch(api)(input, init), { ...retry, surface: LINEAR_SURFACE, operation: linearChannelOperation(init?.body) });
  return { fetch: fetchWithRetry };
}
