export const RATE_LIMITED_STATUS = 429;

export const DEFAULT_MAX_ATTEMPTS = 4;

export const DEFAULT_CAP_MS = 30_000;

export const DEFAULT_TOTAL_BUDGET_MS = 60_000;

export const DEFAULT_FALLBACK_MS = 1_000;

export class RateLimitExhaustedError extends Error {
  readonly status = RATE_LIMITED_STATUS;
  readonly surface: string;
  readonly operation: string;
  readonly attempts: number;
  readonly waitedMs: number;

  constructor(init: { surface: string; operation: string; attempts: number; waitedMs: number }) {
    super(
      `${init.surface} ${init.operation} stayed rate limited after ${init.attempts} attempts ` +
        `(waited ${init.waitedMs} ms across the honoured Retry-After delays).`,
    );
    this.name = "RateLimitExhaustedError";
    this.surface = init.surface;
    this.operation = init.operation;
    this.attempts = init.attempts;
    this.waitedMs = init.waitedMs;
  }
}

export function parseRetryAfterMs(value: string | null | undefined, nowMs: number): number | undefined {
  if (value === null || value === undefined) return undefined;
  const raw = value.trim();
  if (raw.length === 0) return undefined;
  if (/^\d+$/.test(raw)) return Number(raw) * 1000;
  if (!/^[A-Za-z]{3,9},? /.test(raw)) return undefined;
  const at = Date.parse(raw);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, at - nowMs);
}

export interface RateLimitRetryOptions {
  readonly surface: string;
  readonly operation: string;
  readonly maxAttempts?: number;
  readonly capMs?: number;
  readonly fallbackMs?: number;
  readonly totalBudgetMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withRetryAfter(send: () => Promise<Response>, opts: RateLimitRetryOptions): Promise<Response> {
  const maxAttempts = Math.max(1, Math.floor(opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS));
  const capMs = Math.max(0, opts.capMs ?? DEFAULT_CAP_MS);
  const fallbackMs = Math.max(0, opts.fallbackMs ?? DEFAULT_FALLBACK_MS);
  const totalBudgetMs = Math.max(0, opts.totalBudgetMs ?? DEFAULT_TOTAL_BUDGET_MS);
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? Date.now;

  let waitedMs = 0;
  for (let attempt = 1; ; attempt += 1) {
    const res = await send();
    if (res.status !== RATE_LIMITED_STATUS) return res;
    const named = parseRetryAfterMs(res.headers.get("retry-after"), now());
    void res.body?.cancel().catch(() => undefined);
    const delayMs = Math.min(capMs, named ?? fallbackMs);
    if (attempt >= maxAttempts || waitedMs + delayMs > totalBudgetMs) {
      throw new RateLimitExhaustedError({ surface: opts.surface, operation: opts.operation, attempts: attempt, waitedMs });
    }
    waitedMs += delayMs;
    await sleep(delayMs);
  }
}
