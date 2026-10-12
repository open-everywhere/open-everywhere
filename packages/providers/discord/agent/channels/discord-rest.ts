import { friendlyDiscordBody, withRetryAfter, type RetryPolicy } from "@open-everywhere/core/agent/adapter-api.js";

async function friendlyDiscordInit(operation: string, init: RequestInit): Promise<RequestInit> {
  if (!/^(?:POST|PATCH) /.test(operation) || !/\/messages\b|\/callback\b|^POST \/webhooks\//.test(operation)) return init;
  const render = async (json: string): Promise<string | undefined> => {
    try {
      return JSON.stringify(await friendlyDiscordBody(JSON.parse(json) as unknown));
    } catch {
      return undefined;
    }
  };
  if (typeof init.body === "string") {
    const body = await render(init.body);
    return body === undefined ? init : { ...init, body };
  }
  if (init.body instanceof FormData) {
    const payload = init.body.get("payload_json");
    if (typeof payload !== "string") return init;
    const body = await render(payload);
    if (body === undefined) return init;
    const form = new FormData();
    for (const [k, v] of init.body.entries()) form.append(k, k === "payload_json" ? body : v);
    return { ...init, body: form };
  }
  return init;
}

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
  const guarded = friendlyDiscordInit(operation, init);
  const send = async (): Promise<Response> => (deps.fetch ?? (globalThis.fetch as DiscordFetchLike))(url, await guarded);
  return withRetryAfter(send, {
    surface: DISCORD_SURFACE,
    operation,
    retryAfterMs: (res) => discordBodyRetryAfterMs(res as Response),
    ...deps.retry,
  });
}
