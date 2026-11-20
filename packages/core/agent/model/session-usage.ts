import type { SessionUsageLimit } from "eve";

/** The token counts eve passes to a `limits.sessionUsage` function, for one span of a session. */
export interface SessionUsageTokens {
  readonly inputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly outputTokens: number;
}

/**
 * The input tokens that count toward the session budget. eve's `inputTokens` includes cache reads
 * and cache writes. A cache read replays history that the session already paid for, so it does
 * not count. A cache write is new input, so it counts.
 */
export function countedInputTokens(usage: SessionUsageTokens): number {
  return usage.inputTokens - usage.cacheReadTokens;
}

/**
 * The agent's `limits.sessionUsage` function for a budget of `budget` input tokens. eve calls it
 * before each model call. It reads the `window`, which is the usage since the last approved
 * continuation, so an approval starts a fresh budget. eve adds the usage of a `decide()` call and
 * of a worker that replied to the same window.
 */
export function sessionUsageLimit(budget: number): SessionUsageLimit {
  if (!Number.isFinite(budget) || budget <= 0) {
    throw new Error(`open-everywhere: the session input budget must be a positive number of tokens, got ${String(budget)}`);
  }
  return ({ window }) => countedInputTokens(window) >= budget;
}
