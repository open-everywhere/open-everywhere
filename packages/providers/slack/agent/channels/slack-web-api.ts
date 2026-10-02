import { withRetryAfter, type RateLimitRetryOptions } from "@open-everywhere/core/agent/adapter-api.js";
import { slackBotToken } from "../setup/credentials.js";

const SLACK_API_BASE = "https://slack.com/api/";

export interface SlackWebApiResponse {
  readonly ok?: boolean;
  readonly error?: string;
  readonly [key: string]: unknown;
}

export class SlackWebApiError extends Error {
  readonly method: string;
  readonly status: number;
  readonly response: unknown;

  constructor(init: { method: string; status: number; response: unknown }) {
    super(`Slack ${init.method} returned HTTP ${init.status}`);
    this.name = "SlackWebApiError";
    this.method = init.method;
    this.status = init.status;
    this.response = init.response;
  }
}

export type SlackFetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface SlackWebApiDeps {
  readonly fetch?: SlackFetchLike;
  readonly sleep?: RateLimitRetryOptions["sleep"];
  readonly now?: RateLimitRetryOptions["now"];
  readonly maxAttempts?: number;
  readonly capMs?: number;
  readonly totalBudgetMs?: number;
  readonly apiBase?: string;
}

export function encodeSlackForm(body: unknown): string {
  const params = new URLSearchParams();
  if (body !== null && typeof body === "object" && !Array.isArray(body)) {
    for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
      if (value === null || value === undefined) continue;
      const scalar = typeof value === "string" || typeof value === "number" || typeof value === "boolean";
      params.set(key, scalar ? String(value) : JSON.stringify(value));
    }
  }
  return params.toString();
}

const PROBE_OPERATIONS: ReadonlySet<string> = new Set(["auth.test", "conversations.info", "users.info", "conversations.open"]);
const PROBE_MAX_ATTEMPTS = 2;
const PROBE_CAP_MS = 2_000;

async function resolveBotToken(botToken: string | undefined): Promise<string> {
  const token = botToken ?? (await slackBotToken());
  if (!token) throw new Error("SLACK_BOT_TOKEN is required.");
  return token;
}

export async function callSlackWebApi(
  input: {
    readonly botToken?: string;
    readonly operation: string;
    readonly body: unknown;
    readonly unauthenticated?: boolean;
  },
  deps: SlackWebApiDeps = {},
): Promise<SlackWebApiResponse> {
  const token = input.unauthenticated === true ? undefined : await resolveBotToken(input.botToken);
  const encoded = encodeSlackForm(input.body);
  const url = new URL(input.operation, deps.apiBase ?? SLACK_API_BASE).toString();
  const send = (): Promise<Response> =>
    (deps.fetch ?? (globalThis.fetch as SlackFetchLike))(url, {
      body: encoded,
      headers: {
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
        "content-type": "application/x-www-form-urlencoded",
      },
      method: "POST",
    });

  const probe = PROBE_OPERATIONS.has(input.operation);
  const res = await withRetryAfter(send, {
    surface: "slack",
    operation: input.operation,
    maxAttempts: deps.maxAttempts ?? (probe ? PROBE_MAX_ATTEMPTS : undefined),
    capMs: deps.capMs ?? (probe ? PROBE_CAP_MS : undefined),
    totalBudgetMs: deps.totalBudgetMs,
    sleep: deps.sleep,
    now: deps.now,
  });

  const json = (await res.json()) as SlackWebApiResponse;
  if (!res.ok) throw new SlackWebApiError({ method: input.operation, status: res.status, response: json });
  return json;
}
