import { withRetryAfter, type RetryPolicy } from "@open-everywhere/core/agent/adapter-api.js";

export const DISCORD_SURFACE = "discord";

export type DiscordFetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface DiscordFetchDeps {
  readonly fetch?: DiscordFetchLike;
  readonly retry?: RetryPolicy;
}

export async function discordBodyRetryAfterMs(res: Response): Promise<number | undefined> {
  try {
    const body = (await res.clone().json()) as { retry_after?: unknown } | null;
    const seconds = body?.retry_after;
    if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) return undefined;
    return seconds * 1000;
  } catch {
    return undefined;
  }
}

export function discordFetch(operation: string, url: string, init: RequestInit, deps: DiscordFetchDeps = {}): Promise<Response> {
  const send = (): Promise<Response> => (deps.fetch ?? (globalThis.fetch as DiscordFetchLike))(url, init);
  return withRetryAfter(send, {
    surface: DISCORD_SURFACE,
    operation,
    retryAfterMs: (res) => discordBodyRetryAfterMs(res as Response),
    ...deps.retry,
  });
}
